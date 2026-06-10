use crate::commands::error::{CmdError, CmdResult};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::broadcast;

use cuprum_core::grbl::{self, Dir, GrblEvent, GrblHandle, MachineState as GrblState};

/// Active limit/probe pins, mirrored to the front-end (grbl `PinState` is
/// serde-free, so the DTO mapping lives here per the leaf-crate idiom).
#[derive(Clone, Copy, Serialize)]
pub struct Pins {
    pub x: bool,
    pub y: bool,
    pub z: bool,
    pub probe: bool,
}

impl From<grbl::PinState> for Pins {
    fn from(p: grbl::PinState) -> Self {
        Pins {
            x: p.x,
            y: p.y,
            z: p.z,
            probe: p.probe,
        }
    }
}

/// Telemetry pushed to the front-end over a per-connection Channel.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Telemetry {
    Status {
        state: String,
        mpos: [f32; 3],
        wpos: [f32; 3],
        feed: f32,
        spindle: f32,
        /// Override percentages `[feed, rapid, spindle]`.
        overrides: [u8; 3],
        /// Active limit/probe pins from the GRBL `Pn:` field.
        pins: Pins,
    },
    Line {
        /// "rx" (from GRBL) | "tx" (sent by us).
        dir: String,
        text: String,
    },
}

/// One console log line, broadcast globally so the console window can follow the
/// live feed without owning the per-connection telemetry Channel. Mirrors the
/// `Telemetry::Line` payload (dir + text); the frontend timestamps it on arrival.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleLine {
    /// "rx" (received from GRBL) or "tx" (sent by us).
    pub dir: String,
    pub text: String,
}

/// Maximum number of lines held in the in-memory ring buffer (per connection).
const CONSOLE_BACKLOG_CAP: usize = 500;

/// One-shot console echo of a status report, keyed by arm generation. A manual
/// `?` arms it; the forwarder echoes the next status line once per arm. A plain
/// boolean had two races: the 5 Hz poll firing in the arm->send window consumed
/// the arm, and the disarm-on-send-failure could clobber a newer arm from a
/// second `?`. Generations make the cancel precise (it only retires its own arm)
/// while keeping the swap-once semantics (one echo per arm).
#[derive(Default)]
struct EchoStatus {
    /// Generation of the latest arm (bumped by each manual `?`).
    armed: AtomicU64,
    /// Latest generation already echoed or cancelled; trails `armed`.
    served: AtomicU64,
}

impl EchoStatus {
    /// Arm an echo of the next status report; returns this arm's generation
    /// (pass it to `cancel` if the `?` never reaches the wire).
    fn arm(&self) -> u64 {
        self.armed.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Swap-once consumer: true exactly once per outstanding arm (a single echo
    /// serves all arms pending at that moment), false while disarmed.
    fn try_consume(&self) -> bool {
        let armed = self.armed.load(Ordering::SeqCst);
        let served = self.served.load(Ordering::SeqCst);
        if served >= armed {
            return false;
        }
        self.served
            .compare_exchange(served, armed, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// Retire the arm of generation `gen` (failed send): a stale arm must not
    /// later swallow a poll line. A newer arm (generation > `gen`) survives.
    fn cancel(&self, gen: u64) {
        self.served.fetch_max(gen, Ordering::SeqCst);
    }
}

/// Full status snapshot broadcast as the global `machine://status` event so the
/// separate drill webview can track the tool AND control the run without the main
/// window's per-connection Channel. Carries the same fields as `Telemetry::Status`
/// (minus console lines) so a follower window has status parity (feed/overrides/pins).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MachinePos {
    state: String,
    mpos: [f32; 3],
    wpos: [f32; 3],
    feed: f32,
    spindle: f32,
    /// Override percentages `[feed, rapid, spindle]`.
    overrides: [u8; 3],
    /// Active limit/probe pins from the GRBL `Pn:` field.
    pins: Pins,
}

#[derive(Serialize)]
pub struct PortDto {
    pub name: String,
    pub kind: String,
}

/// Live connection held in Tauri managed state. The async actor in `cuprum-grbl`
/// owns the serial port and the reader/poller loop; this layer keeps only the
/// UI-facing concerns: the cloneable handle, the (swappable) telemetry sink, and
/// the forwarder task that fans actor events out to the front-end.
struct MachineConn {
    /// Serial port this connection was opened on. Lets a reattaching front-end
    /// (after a webview reload) learn which port the still-live backend holds.
    port: String,
    /// Cloneable handle to the actor; every command is a thin call on it.
    handle: GrblHandle,
    /// Telemetry sink, behind a swappable cell: a webview reload destroys the
    /// front-end's Channel, so `machine_reattach` replaces it here and the
    /// forwarder keeps streaming to the new one without reopening the port.
    telemetry: Arc<Mutex<Channel<Telemetry>>>,
    /// The task draining the actor's broadcast into telemetry + global events +
    /// the console backlog. Aborted on a clean disconnect.
    forwarder: tauri::async_runtime::JoinHandle<()>,
    /// One-shot guard so `machine://disconnected` is emitted exactly once,
    /// whichever path observes the link end first (the forwarder seeing the
    /// broadcast close, or `machine_disconnect` after a clean shutdown).
    disconnected_once: Arc<AtomicBool>,
    /// One-shot: armed when the user types `?` in the console so the forwarder
    /// echoes the next status report back to them. Status replies are otherwise
    /// kept off the console (the 5 Hz poll would flood it), making a manual `?`
    /// look like it did nothing.
    echo_status: Arc<EchoStatus>,
}

/// Returned by `machine_reattach` when the backend still holds a live connection.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReattachDto {
    pub port: String,
}

/// One GRBL firmware setting `$N=value` as read from a `$$` query.
#[derive(Clone, Serialize)]
pub struct GrblSettingDto {
    n: u16,
    value: String,
}

/// Per-axis GRBL motion limits cached from `$$` (or live `$NNN=` console edits).
/// Stored raw (per axis) rather than as the aggregated `Kinematics` so a single
/// console assignment (`$110=...`) patches exactly one field; the aggregate (xy =
/// min of the two axes) is derived on demand in `to_kinematics`. Persisted to
/// `kinematics.json` so a fresh session has the controller's real limits before
/// the first `$$` read.
#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
pub struct KinematicsRaw {
    /// $110 / $111 / $112 — max rate per axis, mm/min.
    pub max_rate_x: f64,
    pub max_rate_y: f64,
    pub max_rate_z: f64,
    /// $120 / $121 / $122 — acceleration per axis, mm/s².
    pub accel_x: f64,
    pub accel_y: f64,
    pub accel_z: f64,
}

impl Default for KinematicsRaw {
    /// Stock 3018/GRBL defaults until `$$` is read or `kinematics.json` is loaded.
    fn default() -> Self {
        Self {
            max_rate_x: 1000.0,
            max_rate_y: 1000.0,
            max_rate_z: 500.0,
            accel_x: 30.0,
            accel_y: 30.0,
            accel_z: 30.0,
        }
    }
}

impl KinematicsRaw {
    /// Collapse per-axis limits into the aggregated `Kinematics` the planner
    /// consumes: XY takes the min of the two axes (the slower axis governs a
    /// diagonal traverse), Z is its own axis.
    pub fn to_kinematics(self) -> cuprum_core::drilling::Kinematics {
        cuprum_core::drilling::Kinematics {
            max_rate_xy_mm_min: self.max_rate_x.min(self.max_rate_y),
            max_rate_z_mm_min: self.max_rate_z,
            accel_xy_mm_s2: self.accel_x.min(self.accel_y),
            accel_z_mm_s2: self.accel_z,
        }
    }
}

/// Whether GRBL setting number `n` feeds the cached kinematics ($110-$112 rates,
/// $120-$122 accelerations).
fn is_kinematics_setting(n: u16) -> bool {
    matches!(n, 110 | 111 | 112 | 120 | 121 | 122)
}

/// Fold a batch of `$$` settings into the cached kinematics. Only the relevant
/// numbers ($110-$112, $120-$122) are applied; a value that fails to parse as
/// `f64` leaves the corresponding field unchanged (a malformed reply must not
/// clobber a good cached limit). Pure — unit-tested.
fn apply_settings(prev: KinematicsRaw, settings: &[(u16, String)]) -> KinematicsRaw {
    let mut k = prev;
    for (n, value) in settings {
        if !is_kinematics_setting(*n) {
            continue;
        }
        if let Ok(v) = value.trim().parse::<f64>() {
            k = patch_assignment(k, *n, v);
        }
    }
    k
}

/// Parse a GRBL setting assignment `$<num>=<val>` (tolerating surrounding
/// whitespace) into `(num, val)`. Returns `None` for anything that is not an
/// assignment (plain G-code, a bare `$110`, `?`, etc.). Pure — unit-tested.
fn parse_assignment(line: &str) -> Option<(u16, f64)> {
    let line = line.trim();
    let rest = line.strip_prefix('$')?;
    let (num, val) = rest.split_once('=')?;
    let n = num.trim().parse::<u16>().ok()?;
    let v = val.trim().parse::<f64>().ok()?;
    Some((n, v))
}

/// Apply a single setting assignment to the cached kinematics. Relevant numbers
/// ($110-$112, $120-$122) update their axis; everything else returns `prev`
/// unchanged. Pure — unit-tested.
fn patch_assignment(prev: KinematicsRaw, n: u16, v: f64) -> KinematicsRaw {
    let mut k = prev;
    match n {
        110 => k.max_rate_x = v,
        111 => k.max_rate_y = v,
        112 => k.max_rate_z = v,
        120 => k.accel_x = v,
        121 => k.accel_y = v,
        122 => k.accel_z = v,
        _ => {}
    }
    k
}

/// Path to the persisted kinematics cache inside the app data dir (created if
/// missing). Mirrors `project::catalog_db_path`.
fn kinematics_path(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(super::app_data_dir(app)?.join("kinematics.json"))
}

/// Load the persisted kinematics, falling back to `Default` on any error
/// (missing file, unreadable, malformed JSON) — a stale cache must never block
/// startup.
fn load_kinematics(app: &AppHandle) -> KinematicsRaw {
    kinematics_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Best-effort persist of the kinematics cache; errors are swallowed (a failed
/// write just means the next session re-reads `$$`).
fn save_kinematics(app: &AppHandle, k: &KinematicsRaw) {
    if let Ok(path) = kinematics_path(app) {
        if let Ok(json) = serde_json::to_string_pretty(k) {
            let _ = std::fs::write(path, json);
        }
    }
}

/// Application-level machine state: the optional live connection plus a capped
/// ring buffer of recent console lines shared by all windows. The line log is
/// cleared on every new connect (fresh session) and grows up to
/// `CONSOLE_BACKLOG_CAP` entries, after which the oldest line is evicted.
pub struct MachineState {
    conn: Mutex<Option<MachineConn>>,
    /// In-flight connect guard. Taken under the `conn` lock before awaiting
    /// `grbl::connect` (the `conn` mutex itself must not be held across the
    /// await), so a second concurrent connect fails fast instead of racing the
    /// first one and orphaning its forwarder task.
    connecting: AtomicBool,
    /// Capped ring buffer of recent console lines; seeded into follower windows
    /// (e.g. the console window) via `machine_console_backlog`.
    line_log: Arc<Mutex<VecDeque<ConsoleLine>>>,
    /// Cached GRBL motion limits (per axis), kept fresh by reading `$$` and by
    /// snooping console `$NNN=` writes; read by the `drill_plan` command.
    kinematics: Mutex<KinematicsRaw>,
}

impl Default for MachineState {
    fn default() -> Self {
        Self {
            conn: Mutex::new(None),
            connecting: AtomicBool::new(false),
            line_log: Arc::new(Mutex::new(VecDeque::with_capacity(CONSOLE_BACKLOG_CAP))),
            kinematics: Mutex::new(KinematicsRaw::default()),
        }
    }
}

/// Push a console line into the capped ring buffer AND broadcast it globally via
/// `machine://line`. Called at every site that also sends `Telemetry::Line` to the
/// per-connection Channel, so the console window can follow the log without owning
/// that Channel. The existing Channel sends are left in place (the main window still
/// needs them for its own console drawer).
fn record_and_broadcast_line(
    line_log: &Arc<Mutex<VecDeque<ConsoleLine>>>,
    app: &AppHandle,
    dir: &str,
    text: &str,
) {
    let entry = ConsoleLine {
        dir: dir.to_string(),
        text: text.to_string(),
    };
    {
        let mut log = line_log.lock().unwrap();
        if log.len() == CONSOLE_BACKLOG_CAP {
            log.pop_front();
        }
        log.push_back(entry.clone());
    }
    let _ = app.emit("machine://line", entry);
}

fn state_str(s: GrblState) -> &'static str {
    match s {
        GrblState::Idle => "idle",
        GrblState::Run => "run",
        GrblState::Hold => "hold",
        GrblState::Jog => "jog",
        GrblState::Alarm => "alarm",
        GrblState::Home => "home",
        GrblState::Door => "door",
        GrblState::Check => "check",
        GrblState::Sleep => "sleep",
        GrblState::Unknown => "unknown",
    }
}

/// Drain the actor's event broadcast into the front-end: status → per-connection
/// `Telemetry::Status` + the global `machine://status` event; raw lines → console
/// (Channel + global ring). A manual `?` arms `echo_status`, so the next status is
/// also echoed to the console verbatim. Ends — emitting `machine://disconnected` —
/// when the broadcast closes (the actor stopped: clean shutdown or an unplug).
async fn forward_events(
    mut sub: broadcast::Receiver<GrblEvent>,
    telemetry: Arc<Mutex<Channel<Telemetry>>>,
    app: AppHandle,
    line_log: Arc<Mutex<VecDeque<ConsoleLine>>>,
    echo_status: Arc<EchoStatus>,
    disconnected_once: Arc<AtomicBool>,
) {
    loop {
        match sub.recv().await {
            Ok(GrblEvent::Status { status, raw }) => {
                {
                    let t = telemetry.lock().unwrap();
                    let _ = t.send(Telemetry::Status {
                        state: state_str(status.state).into(),
                        mpos: status.mpos,
                        wpos: status.wpos,
                        feed: status.feed,
                        spindle: status.spindle,
                        overrides: status.overrides,
                        pins: status.pins.into(),
                    });
                }
                let _ = app.emit(
                    "machine://status",
                    MachinePos {
                        state: state_str(status.state).into(),
                        mpos: status.mpos,
                        wpos: status.wpos,
                        feed: status.feed,
                        spindle: status.spindle,
                        overrides: status.overrides,
                        pins: status.pins.into(),
                    },
                );
                // The user typed `?`: echo this one status line to the console.
                if echo_status.try_consume() {
                    {
                        let t = telemetry.lock().unwrap();
                        let _ = t.send(Telemetry::Line {
                            dir: "rx".into(),
                            text: raw.clone(),
                        });
                    }
                    record_and_broadcast_line(&line_log, &app, "rx", &raw);
                }
            }
            Ok(GrblEvent::Line { dir, text }) => {
                let d = match dir {
                    Dir::Rx => "rx",
                    Dir::Tx => "tx",
                };
                {
                    let t = telemetry.lock().unwrap();
                    let _ = t.send(Telemetry::Line {
                        dir: d.into(),
                        text: text.clone(),
                    });
                }
                record_and_broadcast_line(&line_log, &app, d, &text);
            }
            // The actor's explicit teardown notice (unplug, idle-link watchdog, or
            // shutdown). This is the reliable signal: the broadcast does NOT close
            // while the UI holds a GrblHandle clone, so we can't wait on `Closed`.
            Ok(GrblEvent::Disconnected) => break,
            // A slow subscriber dropped some events — status is periodic, so just
            // resume with the next one.
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            // Fallback: every Sender dropped (no live handle). Treat as teardown.
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
    // Emit once: a clean `machine_disconnect` may also reach this point via the
    // shutdown closing the broadcast, so the guard avoids a double signal.
    if !disconnected_once.swap(true, Ordering::SeqCst) {
        let _ = app.emit("machine://disconnected", ());
    }
}

#[tauri::command]
pub async fn list_serial_ports() -> CmdResult<Vec<PortDto>> {
    tauri::async_runtime::spawn_blocking(grbl::list_ports)
        .await?
        .map(|ports| {
            ports
                .into_iter()
                .map(|p| PortDto {
                    name: p.name,
                    kind: p.kind,
                })
                .collect()
        })
        .map_err(CmdError::from)
}

#[tauri::command]
pub async fn machine_connect(
    app: AppHandle,
    state: State<'_, MachineState>,
    port: String,
    baud: u32,
    telemetry: Channel<Telemetry>,
) -> CmdResult<()> {
    // Idempotent reconnect: if the backend already holds this exact port (e.g. a
    // webview reload left the connection live and the user pressed Connect), just
    // swap in the fresh telemetry Channel rather than failing or reopening. A
    // different port is a genuine conflict.
    {
        let guard = state.conn.lock().unwrap();
        if let Some(conn) = guard.as_ref() {
            if conn.port == port {
                *conn.telemetry.lock().unwrap() = telemetry;
                drop(guard);
                let _ = app.emit("machine://connected", ());
                return Ok(());
            }
            return Err("connected to a different port".into());
        }
        // Take the in-flight slot under the same lock as the check above: the
        // `conn` mutex is released across the `grbl::connect` await below, so
        // without this a second concurrent connect would also pass the guard,
        // and the loser would overwrite the winner's connection, orphaning its
        // forwarder task (telemetry silently misdirected).
        if state.connecting.swap(true, Ordering::SeqCst) {
            return Err("connection already in progress".into());
        }
    }

    let handle = match grbl::connect(&port, baud).await {
        Ok(handle) => handle,
        Err(e) => {
            // Release the slot so a retry after a failed open is possible.
            state.connecting.store(false, Ordering::SeqCst);
            return Err(e.into());
        }
    };
    // Confirm the device actually speaks GRBL before declaring it connected. Opening
    // the OS serial port succeeds for ANY device on that path (a modem, a logger, the
    // wrong board); only a valid `<…>` status report proves it's a GRBL controller.
    // On failure tear the port back down and surface the error — no `machine://connected`
    // is emitted, so the UI never enters a phantom "connected to a busy machine" state.
    if let Err(e) = handle.wait_until_ready().await {
        handle.shutdown().await;
        state.connecting.store(false, Ordering::SeqCst);
        return Err(e.into());
    }
    let telemetry = Arc::new(Mutex::new(telemetry));
    let echo_status = Arc::new(EchoStatus::default());
    let disconnected_once = Arc::new(AtomicBool::new(false));

    // A new connect starts a fresh session: drop old lines so the console
    // window's seeded view doesn't show a previous connection's traffic.
    state.line_log.lock().unwrap().clear();

    let forwarder = tauri::async_runtime::spawn(forward_events(
        handle.subscribe(),
        telemetry.clone(),
        app.clone(),
        state.line_log.clone(),
        echo_status.clone(),
        disconnected_once.clone(),
    ));

    {
        let mut guard = state.conn.lock().unwrap();
        *guard = Some(MachineConn {
            port,
            handle,
            telemetry,
            forwarder,
            echo_status,
            disconnected_once,
        });
        // Release the in-flight slot only once the connection is visible under
        // the lock, so a competing connect sees either `connecting` or `conn`.
        state.connecting.store(false, Ordering::SeqCst);
    }
    let _ = app.emit("machine://connected", ());
    Ok(())
}

#[tauri::command]
pub async fn machine_disconnect(app: AppHandle, state: State<'_, MachineState>) -> CmdResult<()> {
    let conn = state.conn.lock().unwrap().take();
    if let Some(conn) = conn {
        conn.forwarder.abort();
        conn.handle.shutdown().await;
        // Emit once — the forwarder may also have observed the broadcast close
        // (abort is cooperative) and raced us here; the shared guard dedups.
        if !conn.disconnected_once.swap(true, Ordering::SeqCst) {
            let _ = app.emit("machine://disconnected", ());
        }
    } else {
        // Nothing was connected; still notify followers idempotently.
        let _ = app.emit("machine://disconnected", ());
    }
    Ok(())
}

/// Echo a line/label to the console as "tx" without touching the wire. Used for
/// real-time bytes (jog-cancel, soft-reset, overrides, manual `?`), which the
/// actor writes but does not echo (it only echoes line commands as tx).
fn echo_tx(state: &State<MachineState>, app: &AppHandle, label: &str) {
    if let Some(conn) = state.conn.lock().unwrap().as_ref() {
        let t = conn.telemetry.lock().unwrap();
        let _ = t.send(Telemetry::Line {
            dir: "tx".into(),
            text: label.to_string(),
        });
    }
    record_and_broadcast_line(&state.line_log, app, "tx", label);
}

#[tauri::command]
pub async fn machine_jog(
    state: State<'_, MachineState>,
    dx: f32,
    dy: f32,
    dz: f32,
    feed: f32,
) -> CmdResult<()> {
    let handle = state.handle().ok_or("not connected")?;
    handle
        .send_line(&grbl::jog(dx, dy, dz, feed))
        .await
        .map_err(CmdError::from)
}

/// Absolute jog (work coords): drive the given axes to their targets. Used by the
/// click-to-move surfaces (work field, Z bar), which cancel any in-flight jog
/// before re-issuing so a new click retargets instead of queuing behind it.
#[tauri::command]
pub async fn machine_jog_to(
    state: State<'_, MachineState>,
    x: Option<f32>,
    y: Option<f32>,
    z: Option<f32>,
    feed: f32,
) -> CmdResult<()> {
    let handle = state.handle().ok_or("not connected")?;
    handle
        .send_line(&grbl::jog_to(x, y, z, feed))
        .await
        .map_err(CmdError::from)
}

#[tauri::command]
pub async fn machine_jog_cancel(app: AppHandle, state: State<'_, MachineState>) -> CmdResult<()> {
    let handle = state.handle().ok_or("not connected")?;
    handle.send_realtime(grbl::JOG_CANCEL).await?;
    echo_tx(&state, &app, "jog-cancel");
    Ok(())
}

/// Set the G54 work zero on the selected axes and wait for GRBL to accept it.
/// Returns Err if GRBL rejects the command (e.g. `error:N`) so the UI never
/// trusts a zero the machine didn't actually apply.
#[tauri::command]
pub async fn machine_set_zero(
    state: State<'_, MachineState>,
    x: bool,
    y: bool,
    z: bool,
) -> CmdResult<()> {
    let handle = state.handle().ok_or("not connected")?;
    handle
        .send_await(&grbl::set_work_zero(x, y, z))
        .await
        .map_err(CmdError::from)
}

#[tauri::command]
pub async fn machine_home(state: State<'_, MachineState>) -> CmdResult<()> {
    let handle = state.handle().ok_or("not connected")?;
    handle.send_line(grbl::home()).await.map_err(CmdError::from)
}

/// Home ($H) and resolve only once the cycle completes, so the UI can show
/// progress and mark the frame homed only when GRBL confirms it (Err on
/// failure/abort/timeout). The actor tolerates the long mid-cycle silence.
#[tauri::command]
pub async fn machine_home_await(state: State<'_, MachineState>) -> CmdResult<()> {
    let handle = state.handle().ok_or("not connected")?;
    handle.home().await.map_err(CmdError::from)
}

/// Read the controller's full firmware settings (`$$`).
#[tauri::command]
pub async fn machine_read_settings(
    app: AppHandle,
    state: State<'_, MachineState>,
) -> CmdResult<Vec<GrblSettingDto>> {
    let handle = state.handle().ok_or("not connected")?;
    let settings = handle.read_settings().await?;
    // Invalidation point 1: a full `$$` read refreshes the cached kinematics, then
    // persists so the next session starts with the controller's real limits.
    {
        let mut k = state.kinematics.lock().unwrap();
        *k = apply_settings(*k, &settings);
        save_kinematics(&app, &k);
    }
    Ok(settings
        .into_iter()
        .map(|(n, value)| GrblSettingDto { n, value })
        .collect())
}

#[tauri::command]
pub async fn machine_unlock(app: AppHandle, state: State<'_, MachineState>) -> CmdResult<()> {
    let handle = state.handle().ok_or("not connected")?;
    handle.send_line(grbl::unlock()).await?;
    // Broadcast so every window's alarm banner can optimistically hide at once,
    // before the next status poll confirms the cleared state (~200 ms later).
    let _ = app.emit("machine://unlock", ());
    Ok(())
}

#[tauri::command]
pub async fn machine_spindle(state: State<'_, MachineState>, on: bool, rpm: u32) -> CmdResult<()> {
    let handle = state.handle().ok_or("not connected")?;
    let line = if on {
        grbl::spindle_on(rpm)
    } else {
        grbl::spindle_off().to_string()
    };
    handle.send_line(&line).await.map_err(CmdError::from)
}

/// Probe Z down onto the work surface and set the G54 Z work-zero at contact
/// (`G10 L20 P1 Z<offset_mm>`), then retract Z to `safe_z_mm` (work coord). On no
/// contact / reject the Z-zero is left untouched. The caller (frontend) is
/// responsible for the probe-pin pre-check and the connectivity self-test.
#[tauri::command]
pub async fn machine_probe_z(
    state: State<'_, MachineState>,
    max_dist_mm: f32,
    feed_mm_min: f32,
    offset_mm: f32,
    safe_z_mm: f32,
    approach_z_mm: Option<f32>,
) -> CmdResult<()> {
    let handle = state.handle().ok_or("not connected")?;

    // Optional rapid descent to the approach height (work frame) before probing —
    // lets the tool-change park sit high (room to swap the bit) while the probe
    // still reaches the surface. Absolute (G90) so a high park descends correctly.
    if let Some(z) = approach_z_mm {
        handle.send_await(&format!("G90 G0 Z{z}")).await?;
    }

    // Strict straight-probe. `probe()` returns Ok(false) on no-contact (bare ok /
    // s=0) and Err on an ALARM (G38.2 strict, no contact within travel).
    let contact = handle
        .probe(&grbl::probe_z(max_dist_mm, feed_mm_min))
        .await?;
    if !contact {
        return Err("no contact".into());
    }

    // Contact confirmed: zero Z here (board top + plate offset)...
    handle
        .send_await(&format!("G10 L20 P1 Z{offset_mm}"))
        .await?;
    // ...then lift clear. Fire-and-forget jog: a retract that's late doesn't
    // invalidate the just-set Z-zero.
    handle
        .send_line(&grbl::jog_to(None, None, Some(safe_z_mm), feed_mm_min))
        .await
        .map_err(CmdError::from)
}

#[tauri::command]
pub async fn machine_send(
    app: AppHandle,
    state: State<'_, MachineState>,
    line: String,
) -> CmdResult<()> {
    let handle = state.handle().ok_or("not connected")?;
    // A bare `?` is the status query; GRBL's `<...>` reply is normally kept off
    // the console (5 Hz poll noise). When the user types it explicitly, arm a
    // one-shot so the forwarder echoes the next status report back to them. Send
    // it as a real-time byte (no `\n`) so it doesn't draw a spurious `ok`. Arm
    // before the write (so the reply can't beat the arm), disarm if the write
    // fails so a stale arm can't later swallow a poll line.
    if line.trim() == "?" {
        // Hold on to this connection's EchoStatus: if the connection is swapped
        // while the send is in flight, the cancel below must hit the same arm
        // it took (a fresh connection starts its generations from zero).
        let echo = state
            .conn
            .lock()
            .unwrap()
            .as_ref()
            .map(|conn| conn.echo_status.clone());
        let armed_gen = echo.as_ref().map(|e| e.arm());
        match handle.send_realtime(grbl::STATUS_QUERY).await {
            Ok(()) => {
                echo_tx(&state, &app, "?");
                Ok(())
            }
            Err(e) => {
                if let (Some(echo), Some(gen)) = (echo, armed_gen) {
                    echo.cancel(gen);
                }
                Err(e.into())
            }
        }
    } else {
        handle.send_line(&line).await?;
        // Invalidation point 2: snoop a console `$NNN=value` write. Only after the
        // send succeeds, and only for the kinematics settings, patch the cached
        // axis and persist — so a live `$110=...` edit is reflected without a `$$`.
        if let Some((n, v)) = parse_assignment(&line) {
            if is_kinematics_setting(n) {
                let mut k = state.kinematics.lock().unwrap();
                *k = patch_assignment(*k, n, v);
                save_kinematics(&app, &k);
            }
        }
        Ok(())
    }
}

/// Write a line and block until GRBL acknowledges it, returning Err on
/// `error:N`/`ALARM:N`. Used for firmware-setting writes (e.g. `$20=1`,
/// `$130=...`) the UI must know were actually applied — a blind send can be
/// silently dropped, so the change would never reach EEPROM yet the UI assumes
/// success.
///
/// Note: this path does NOT snoop kinematics like `machine_send` does. Its only
/// kinematics-writing caller is the settings UI (`GrblTab.doApply`), which always
/// re-reads `$$` via `machine_read_settings` afterwards — so the cache refreshes
/// through the read path. Any future caller writing `$110`–`$122` here WITHOUT a
/// following `$$` read would leave the kinematics cache stale.
#[tauri::command]
pub async fn machine_send_await_ok(state: State<'_, MachineState>, line: String) -> CmdResult<()> {
    let handle = state.handle().ok_or("not connected")?;
    handle.send_await(&line).await.map_err(CmdError::from)
}

#[tauri::command]
pub async fn machine_soft_reset(app: AppHandle, state: State<'_, MachineState>) -> CmdResult<()> {
    let handle = state.handle().ok_or("not connected")?;
    handle.send_realtime(grbl::SOFT_RESET).await?;
    echo_tx(&state, &app, "soft-reset");
    Ok(())
}

#[tauri::command]
pub async fn machine_feed_hold(app: AppHandle, state: State<'_, MachineState>) -> CmdResult<()> {
    let handle = state.handle().ok_or("not connected")?;
    handle.send_realtime(grbl::FEED_HOLD).await?;
    echo_tx(&state, &app, "!");
    Ok(())
}

#[tauri::command]
pub async fn machine_cycle_start(app: AppHandle, state: State<'_, MachineState>) -> CmdResult<()> {
    let handle = state.handle().ok_or("not connected")?;
    handle.send_realtime(grbl::CYCLE_START).await?;
    echo_tx(&state, &app, "~");
    Ok(())
}

/// Adjust a real-time override. `kind` ∈ {feed, rapid, spindle};
/// `action` ∈ {"100", "+10", "-10", "+1", "-1", "stop"}. "stop" is spindle-only.
#[tauri::command]
pub async fn machine_override(
    app: AppHandle,
    state: State<'_, MachineState>,
    kind: String,
    action: String,
) -> CmdResult<()> {
    let byte = match (kind.as_str(), action.as_str()) {
        ("feed", "100") => grbl::FEED_OVERRIDE_100,
        ("feed", "+10") => grbl::FEED_OVERRIDE_PLUS_10,
        ("feed", "-10") => grbl::FEED_OVERRIDE_MINUS_10,
        ("feed", "+1") => grbl::FEED_OVERRIDE_PLUS_1,
        ("feed", "-1") => grbl::FEED_OVERRIDE_MINUS_1,
        ("rapid", "100") => grbl::RAPID_OVERRIDE_100,
        // GRBL rapid override has only fixed 100/50/25 % steps; map -10 → 50 %,
        // -1 → 25 % so the same +/- action vocabulary works for every kind.
        ("rapid", "-10") => grbl::RAPID_OVERRIDE_50,
        ("rapid", "-1") => grbl::RAPID_OVERRIDE_25,
        ("spindle", "100") => grbl::SPINDLE_OVERRIDE_100,
        ("spindle", "+10") => grbl::SPINDLE_OVERRIDE_PLUS_10,
        ("spindle", "-10") => grbl::SPINDLE_OVERRIDE_MINUS_10,
        ("spindle", "+1") => grbl::SPINDLE_OVERRIDE_PLUS_1,
        ("spindle", "-1") => grbl::SPINDLE_OVERRIDE_MINUS_1,
        ("spindle", "stop") => grbl::SPINDLE_OVERRIDE_STOP,
        _ => return Err(format!("unknown override: {kind}/{action}").into()),
    };
    let handle = state.handle().ok_or("not connected")?;
    handle.send_realtime(byte).await?;
    echo_tx(&state, &app, &format!("ov:{kind}{action}"));
    Ok(())
}

impl MachineState {
    /// Clone of the live actor handle, if connected. The single accessor every
    /// command (and the drill runner) goes through.
    pub(crate) fn handle(&self) -> Option<GrblHandle> {
        self.conn.lock().unwrap().as_ref().map(|c| c.handle.clone())
    }

    pub(crate) fn is_connected(&self) -> bool {
        self.conn.lock().unwrap().is_some()
    }

    /// Snapshot of the cached kinematics aggregated for the planner. The single
    /// accessor `drill_plan` goes through.
    pub(crate) fn kinematics(&self) -> cuprum_core::drilling::Kinematics {
        self.kinematics.lock().unwrap().to_kinematics()
    }

    /// Seed the cached kinematics from the persisted `kinematics.json` on startup
    /// (called from `main`'s `.setup`). Best-effort: a missing/bad file leaves the
    /// `Default` seeded by `Default::default`.
    pub(crate) fn load_persisted(&self, app: &AppHandle) {
        *self.kinematics.lock().unwrap() = load_kinematics(app);
    }
}

#[tauri::command]
pub fn machine_is_connected(state: State<MachineState>) -> bool {
    state.is_connected()
}

/// Re-bind a fresh telemetry Channel to the still-live connection after a webview
/// reload (which destroys the front-end's previous Channel while the backend keeps
/// the serial port and actor running). Returns the held port so the front-end can
/// restore its connection state, or `None` if nothing is connected.
#[tauri::command]
pub fn machine_reattach(
    state: State<MachineState>,
    telemetry: Channel<Telemetry>,
) -> Option<ReattachDto> {
    let guard = state.conn.lock().unwrap();
    let conn = guard.as_ref()?;
    *conn.telemetry.lock().unwrap() = telemetry;
    Some(ReattachDto {
        port: conn.port.clone(),
    })
}

/// Return the in-memory ring buffer of recent console lines (up to
/// `CONSOLE_BACKLOG_CAP` entries). Called by a follower window (e.g. the console
/// window) on mount to seed its view before live `machine://line` events arrive.
/// Returns an empty list when no connection is active or no lines have been logged
/// yet (the follower must handle both without blocking).
#[tauri::command]
pub fn machine_console_backlog(state: State<MachineState>) -> Vec<ConsoleLine> {
    state.line_log.lock().unwrap().iter().cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_settings_updates_kinematics_fields() {
        let prev = KinematicsRaw::default();
        let settings = vec![
            (110, "1200".to_string()),
            (111, "1100".to_string()),
            (112, "600".to_string()),
            (120, "40".to_string()),
            (121, "35".to_string()),
            (122, "25".to_string()),
            // Irrelevant settings are ignored.
            (3, "4".to_string()),
            (130, "200".to_string()),
        ];
        let k = apply_settings(prev, &settings);
        assert_eq!(k.max_rate_x, 1200.0);
        assert_eq!(k.max_rate_y, 1100.0);
        assert_eq!(k.max_rate_z, 600.0);
        assert_eq!(k.accel_x, 40.0);
        assert_eq!(k.accel_y, 35.0);
        assert_eq!(k.accel_z, 25.0);
    }

    #[test]
    fn apply_settings_keeps_prev_on_parse_error() {
        let prev = KinematicsRaw::default();
        let settings = vec![(110, "not-a-number".to_string())];
        let k = apply_settings(prev, &settings);
        assert_eq!(k.max_rate_x, prev.max_rate_x);
    }

    #[test]
    fn to_kinematics_aggregates_xy_as_min() {
        let raw = KinematicsRaw {
            max_rate_x: 1200.0,
            max_rate_y: 800.0,
            max_rate_z: 500.0,
            accel_x: 40.0,
            accel_y: 30.0,
            accel_z: 20.0,
        };
        let agg = raw.to_kinematics();
        assert_eq!(agg.max_rate_xy_mm_min, 800.0);
        assert_eq!(agg.max_rate_z_mm_min, 500.0);
        assert_eq!(agg.accel_xy_mm_s2, 30.0);
        assert_eq!(agg.accel_z_mm_s2, 20.0);
    }

    #[test]
    fn parse_assignment_recognizes_settings() {
        assert_eq!(parse_assignment("$110=1200"), Some((110, 1200.0)));
        assert_eq!(parse_assignment("$3=4"), Some((3, 4.0)));
        // Leading/trailing whitespace tolerated.
        assert_eq!(parse_assignment("  $122=25.5  "), Some((122, 25.5)));
    }

    #[test]
    fn parse_assignment_rejects_non_assignments() {
        assert_eq!(parse_assignment("G0 X1"), None);
        assert_eq!(parse_assignment("$110"), None);
        assert_eq!(parse_assignment("?"), None);
        assert_eq!(parse_assignment("$$"), None);
        assert_eq!(parse_assignment("$x=1"), None);
    }

    #[test]
    fn patch_assignment_updates_relevant_axis() {
        let prev = KinematicsRaw::default();
        assert_eq!(patch_assignment(prev, 110, 1500.0).max_rate_x, 1500.0);
        assert_eq!(patch_assignment(prev, 122, 99.0).accel_z, 99.0);
    }

    #[test]
    fn patch_assignment_ignores_irrelevant_setting() {
        let prev = KinematicsRaw::default();
        let after = patch_assignment(prev, 3, 4.0);
        // No field changed.
        assert_eq!(after.max_rate_x, prev.max_rate_x);
        assert_eq!(after.max_rate_y, prev.max_rate_y);
        assert_eq!(after.max_rate_z, prev.max_rate_z);
        assert_eq!(after.accel_x, prev.accel_x);
        assert_eq!(after.accel_y, prev.accel_y);
        assert_eq!(after.accel_z, prev.accel_z);
    }

    #[test]
    fn echo_status_disarmed_by_default() {
        let e = EchoStatus::default();
        assert!(!e.try_consume());
    }

    #[test]
    fn echo_status_consumes_once_per_arm() {
        let e = EchoStatus::default();
        e.arm();
        assert!(e.try_consume());
        // Swap-once: the next status line is not echoed.
        assert!(!e.try_consume());
        // A new arm re-enables exactly one echo.
        e.arm();
        assert!(e.try_consume());
        assert!(!e.try_consume());
    }

    #[test]
    fn echo_status_single_echo_serves_pending_arms() {
        let e = EchoStatus::default();
        e.arm();
        e.arm();
        // Two rapid `?` before any status: one echoed line serves both arms.
        assert!(e.try_consume());
        assert!(!e.try_consume());
    }

    #[test]
    fn echo_status_cancel_retires_own_arm() {
        let e = EchoStatus::default();
        let gen = e.arm();
        e.cancel(gen);
        // A cancelled arm must not swallow a later poll line.
        assert!(!e.try_consume());
    }

    #[test]
    fn echo_status_cancel_keeps_newer_arm() {
        let e = EchoStatus::default();
        let old = e.arm();
        e.arm();
        // Cancelling the failed older send leaves the newer arm live.
        e.cancel(old);
        assert!(e.try_consume());
        assert!(!e.try_consume());
    }
}

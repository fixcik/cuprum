use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};

use cuprum_core::grbl::{self, GrblWriter, MachineState as GrblState};

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

/// Connection liveness shared with the drill job-runner: the time of the last
/// line received from GRBL (any line — the 200 ms status poll keeps this fresh
/// while connected) and whether GRBL last reported Idle. Lets the runner wait
/// for `ok` based on the machine actually being alive/busy rather than a blind
/// fixed timeout (a long move keeps GRBL in Run and the status flowing).
pub(crate) struct Activity {
    pub last: std::time::Instant,
    pub idle: bool,
    /// Whether GRBL last reported the Hold state. Retained for future use
    /// (was used by the old pause path; kept so machine.rs stays consistent).
    #[allow(dead_code)]
    pub hold: bool,
}

/// Live connection held in Tauri managed state.
struct MachineConn {
    /// Serial port this connection was opened on. Lets a reattaching front-end
    /// (after a webview reload) learn which port the still-live backend holds.
    port: String,
    writer: Arc<Mutex<GrblWriter>>,
    /// Telemetry sink, behind a swappable cell: a webview reload destroys the
    /// front-end's Channel, so `machine_reattach` replaces it here and the reader
    /// keeps streaming to the new one without reopening the port.
    telemetry: Arc<Mutex<Channel<Telemetry>>>,
    stop: Arc<AtomicBool>,
    reader_handle: Option<JoinHandle<()>>,
    poller_handle: Option<JoinHandle<()>>,
    ack_tx: Arc<Mutex<Option<std::sync::mpsc::Sender<grbl::Line>>>>,
    activity: Arc<Mutex<Activity>>,
    /// One-shot: armed when the user types `?` in the console so the reader echoes
    /// the next status report back to them. Status replies are otherwise filtered
    /// from the console (the 5 Hz poll would flood it), making a manual `?` look
    /// like it did nothing.
    echo_status: Arc<AtomicBool>,
}

/// Returned by `machine_reattach` when the backend still holds a live connection.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReattachDto {
    pub port: String,
}

#[derive(Default)]
pub struct MachineState(Mutex<Option<MachineConn>>);

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

#[tauri::command]
pub async fn list_serial_ports() -> Result<Vec<PortDto>, String> {
    tauri::async_runtime::spawn_blocking(grbl::list_ports)
        .await
        .map_err(|e| e.to_string())?
        .map(|ports| {
            ports
                .into_iter()
                .map(|p| PortDto {
                    name: p.name,
                    kind: p.kind,
                })
                .collect()
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn machine_connect(
    app: AppHandle,
    state: State<MachineState>,
    port: String,
    baud: u32,
    telemetry: Channel<Telemetry>,
) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    if let Some(conn) = guard.as_ref() {
        // Idempotent reconnect: if the backend already holds this exact port (e.g.
        // a webview reload left the connection live and the user pressed Connect),
        // just swap in the fresh telemetry Channel rather than failing or reopening
        // the port. A different port is a genuine conflict.
        if conn.port == port {
            *conn.telemetry.lock().unwrap() = telemetry;
            drop(guard);
            let _ = app.emit("machine://connected", ());
            return Ok(());
        }
        return Err("connected to a different port".into());
    }
    let (writer, mut reader) = grbl::open(&port, baud).map_err(|e| e.to_string())?;
    let writer = Arc::new(Mutex::new(writer));
    // Swappable telemetry sink (see MachineConn::telemetry) so a reattach can
    // redirect the reader's stream to a new front-end Channel.
    let telemetry = Arc::new(Mutex::new(telemetry));
    let stop = Arc::new(AtomicBool::new(false));
    let ack_tx: Arc<Mutex<Option<std::sync::mpsc::Sender<grbl::Line>>>> =
        Arc::new(Mutex::new(None));
    let activity = Arc::new(Mutex::new(Activity {
        last: std::time::Instant::now(),
        idle: false,
        hold: false,
    }));
    let echo_status = Arc::new(AtomicBool::new(false));

    // Reader thread: parse lines, push status + raw rx lines.
    let r_stop = stop.clone();
    let r_tel = telemetry.clone();
    let r_echo = echo_status.clone();
    let r_app = app.clone();
    let r_ack = ack_tx.clone();
    let r_activity = activity.clone();
    let reader_handle = std::thread::spawn(move || {
        let mut tracker = grbl::StatusTracker::default();
        while !r_stop.load(Ordering::Relaxed) {
            match reader.read_line() {
                Ok(Some(line)) => {
                    // Any line from GRBL = the link is alive (used by the runner's
                    // liveness-based ok-wait).
                    r_activity.lock().unwrap().last = std::time::Instant::now();
                    let parsed = grbl::parse_line(&line);
                    // Echo to the console — but NOT the status-report polls (`<...>`),
                    // which arrive at ~5 Hz from the 200 ms poller and would flood the
                    // log, thrash the console (auto-scroll + full re-render of the line
                    // list), and bury real traffic. Status is forwarded separately as
                    // Telemetry::Status below. Exception: when the user types `?` in the
                    // console, `echo_status` is armed so the NEXT status line is echoed
                    // once (otherwise a manual `?` looks like it did nothing). The swap
                    // is short-circuited for non-status lines so it can't consume the arm.
                    let is_status = matches!(parsed, grbl::Line::Status(_));
                    if !is_status || r_echo.swap(false, Ordering::Acquire) {
                        let _ = r_tel.lock().unwrap().send(Telemetry::Line {
                            dir: "rx".into(),
                            text: line.clone(),
                        });
                    }
                    // Route terminal replies to a pending ok-wait. Welcome is
                    // included so a soft-reset (e.g. aborting a homing cycle)
                    // unblocks the waiter instead of letting it hang to timeout.
                    if matches!(
                        parsed,
                        grbl::Line::Ok
                            | grbl::Line::Error(_)
                            | grbl::Line::Alarm(_)
                            | grbl::Line::Welcome(_)
                            | grbl::Line::Probe { .. }
                    ) {
                        if let Some(tx) = r_ack.lock().unwrap().as_ref() {
                            let _ = tx.send(parsed.clone());
                        }
                    }
                    if let grbl::Line::Status(rep) = &parsed {
                        let s = tracker.resolve(rep);
                        {
                            let mut a = r_activity.lock().unwrap();
                            a.idle = matches!(s.state, GrblState::Idle);
                            a.hold = matches!(s.state, GrblState::Hold);
                        }
                        let _ = r_tel.lock().unwrap().send(Telemetry::Status {
                            state: state_str(s.state).into(),
                            mpos: s.mpos,
                            wpos: s.wpos,
                            feed: s.feed,
                            spindle: s.spindle,
                            overrides: s.overrides,
                            pins: s.pins.into(),
                        });
                        // Global broadcast for other windows (drill webview) — full
                        // status (not just position) so a follower window has parity.
                        let _ = r_app.emit(
                            "machine://status",
                            MachinePos {
                                state: state_str(s.state).into(),
                                mpos: s.mpos,
                                wpos: s.wpos,
                                feed: s.feed,
                                spindle: s.spindle,
                                overrides: s.overrides,
                                pins: s.pins.into(),
                            },
                        );
                    }
                }
                Ok(None) => {}
                Err(e) => {
                    r_stop.store(true, Ordering::Relaxed);
                    let _ = r_app.emit("machine://error", e.to_string());
                    // Notify the frontend only on an unexpected drop (read error /
                    // unplug). A clean disconnect is frontend-initiated and already
                    // tore the store down, so it needs no event here.
                    let _ = r_app.emit("machine://disconnected", ());
                    break;
                }
            }
        }
    });

    // Poller thread: status query every 200 ms.
    let p_stop = stop.clone();
    let p_writer = writer.clone();
    let poller_handle = std::thread::spawn(move || {
        while !p_stop.load(Ordering::Relaxed) {
            if let Ok(mut w) = p_writer.lock() {
                let _ = w.write_realtime(grbl::STATUS_QUERY);
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    });

    *guard = Some(MachineConn {
        port,
        writer,
        telemetry,
        stop,
        reader_handle: Some(reader_handle),
        poller_handle: Some(poller_handle),
        ack_tx,
        activity,
        echo_status,
    });
    drop(guard);
    let _ = app.emit("machine://connected", ());
    Ok(())
}

#[tauri::command]
pub fn machine_disconnect(state: State<MachineState>) -> Result<(), String> {
    let conn = state.0.lock().unwrap().take();
    if let Some(mut conn) = conn {
        conn.stop.store(true, Ordering::Relaxed);
        if let Some(h) = conn.poller_handle.take() {
            let _ = h.join();
        }
        if let Some(h) = conn.reader_handle.take() {
            let _ = h.join();
        }
    }
    Ok(())
}

/// Write a line via the live connection and echo it to the console as "tx".
fn send_line(state: &State<MachineState>, line: &str) -> Result<(), String> {
    // Take owned handles and release the outer state lock BEFORE the (blocking)
    // serial write and telemetry send: keeps the outer lock off the I/O path and
    // avoids nesting telemetry.lock() under it.
    let (writer, telemetry) = {
        let guard = state.0.lock().unwrap();
        let conn = guard.as_ref().ok_or("not connected")?;
        (conn.writer.clone(), conn.telemetry.clone())
    };
    writer
        .lock()
        .unwrap()
        .write_line(line)
        .map_err(|e| e.to_string())?;
    let _ = telemetry.lock().unwrap().send(Telemetry::Line {
        dir: "tx".into(),
        text: line.to_string(),
    });
    Ok(())
}

/// Abort the ok-wait if GRBL goes fully silent this long (link dead / unplugged).
const SYNC_STALL_SILENCE: Duration = Duration::from_secs(4);
/// Abort if GRBL is Idle but no ok arrived this long after the write (lost ok).
const SYNC_IDLE_NO_ACK: Duration = Duration::from_secs(3);

/// Write a line and BLOCK until GRBL gives it a terminal reply, over owned
/// connection handles (so it can run on a `spawn_blocking` thread — the closure
/// must be `Send`, which `&State` is not). Claims the reader→`ack_tx` slot, writes
/// the line, then loops on the same liveness aborts as the rest of the sync waits.
///
/// `probe` selects the success rule:
/// - `false` (plain `await ok`): the first `ok` is success; this is the
///   `send_line_await_ok` behaviour (e.g. setting the work zero).
/// - `true` (`G38.2` straight-probe): track the `[PRB:...:s]` flag and treat
///   PRB-success + `ok` as a confirmed contact, a bare `ok` / `s=0` as no-contact,
///   and an `ALARM` (G38.2 strict, no contact within travel) as failure.
///
/// Refuses if a drill run already holds the ack slot ("busy"); always releases it.
fn await_terminal_owned(
    writer: Arc<Mutex<GrblWriter>>,
    ack_slot: Arc<Mutex<Option<std::sync::mpsc::Sender<grbl::Line>>>>,
    activity: Arc<Mutex<Activity>>,
    telemetry: Option<Channel<Telemetry>>,
    line: &str,
    probe: bool,
) -> Result<(), String> {
    // Claim the ack channel. If a drill run already holds it, don't interfere.
    let (tx, rx) = std::sync::mpsc::channel::<grbl::Line>();
    {
        let mut slot = ack_slot.lock().unwrap();
        if slot.is_some() {
            return Err("machine busy".into());
        }
        *slot = Some(tx);
    }

    // Always release the ack slot, whatever the outcome.
    let result = (|| {
        writer
            .lock()
            .unwrap()
            .write_line(line)
            .map_err(|e| e.to_string())?;
        if let Some(t) = &telemetry {
            let _ = t.send(Telemetry::Line {
                dir: "tx".into(),
                text: line.to_string(),
            });
        }
        let sent = std::time::Instant::now();
        let mut contacted: Option<bool> = None;
        loop {
            match rx.recv_timeout(Duration::from_millis(100)) {
                // Probe report: remember the contact flag until the terminal `ok`.
                Ok(grbl::Line::Probe { success, .. }) => contacted = Some(success),
                Ok(grbl::Line::Ok) => {
                    if probe {
                        // `ok` is the terminal after a probe. If GRBL never flagged
                        // contact (s=0, or a bare ok), treat as no-contact.
                        return match contacted {
                            Some(true) => Ok(()),
                            _ => Err("no contact".into()),
                        };
                    }
                    return Ok(());
                }
                Ok(grbl::Line::Error(n)) => return Err(format!("error:{n}")),
                // G38.2 strict raises an ALARM on no contact within travel.
                Ok(grbl::Line::Alarm(n)) => return Err(format!("ALARM:{n}")),
                // A reset (welcome banner) mid-command means the line was aborted.
                Ok(grbl::Line::Welcome(_)) => return Err("reset".into()),
                Ok(_) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    let (silent, idle) = {
                        let a = activity.lock().unwrap();
                        (a.last.elapsed(), a.idle)
                    };
                    if silent > SYNC_STALL_SILENCE {
                        return Err("no response from machine".into());
                    }
                    if idle && sent.elapsed() > SYNC_IDLE_NO_ACK {
                        return Err("machine idle, no ack (lost ok)".into());
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("connection lost".into());
                }
            }
        }
    })();

    *ack_slot.lock().unwrap() = None;
    result
}

/// Write a line and BLOCK until GRBL acknowledges it with `ok` (success) or
/// rejects it with `error`/`ALARM` (failure). Used for commands whose acceptance
/// the UI must trust before acting on it — notably setting the work zero: a blind
/// fire-and-forget send would let a rejected `G10` pass the run's start gate and
/// drive the bit in a stale coordinate system. Reuses the same reader→`ack_tx`
/// channel as the drill runner; refuses if a run already holds it ("busy"). Thin
/// `&State` wrapper over `await_terminal_owned` (plain ok-wait).
fn send_line_await_ok(state: &State<MachineState>, line: &str) -> Result<(), String> {
    let writer = state.writer().ok_or("not connected")?;
    let ack_slot = state.ack_slot().ok_or("not connected")?;
    let activity = state.activity().ok_or("not connected")?;
    let telemetry = state.telemetry();
    await_terminal_owned(writer, ack_slot, activity, telemetry, line, false)
}

/// Overall ceiling for a homing cycle. GRBL stays silent for the whole cycle and
/// then answers `ok` (done) or `ALARM` (switch not found within max travel), so
/// the usual silence/idle aborts of `send_line_await_ok` don't apply — only a
/// generous ceiling guards against a dead link that never answers.
const HOMING_TIMEOUT: Duration = Duration::from_secs(120);

/// Send `$H` and BLOCK until the homing cycle resolves: `ok` (homed),
/// `error`/`ALARM` (rejected/failed), or a `Welcome` banner (a soft-reset aborted
/// it). Unlike `send_line_await_ok`, it tolerates the long mid-cycle silence GRBL
/// produces while homing — status reports stop until the cycle ends, so liveness
/// can't be judged from silence here. Reuses the reader→`ack_tx` channel; refuses
/// if a run already holds it. Takes the connection handles by value so it can run
/// on a blocking thread (the cycle is seconds long — it must NOT run on the main
/// thread or it freezes the webview).
fn home_await(
    writer: Arc<Mutex<GrblWriter>>,
    ack_slot: Arc<Mutex<Option<std::sync::mpsc::Sender<grbl::Line>>>>,
    telemetry: Option<Channel<Telemetry>>,
) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel::<grbl::Line>();
    {
        let mut slot = ack_slot.lock().unwrap();
        if slot.is_some() {
            return Err("machine busy".into());
        }
        *slot = Some(tx);
    }

    let result = (|| {
        let line = grbl::home();
        writer
            .lock()
            .unwrap()
            .write_line(line)
            .map_err(|e| e.to_string())?;
        if let Some(t) = &telemetry {
            let _ = t.send(Telemetry::Line {
                dir: "tx".into(),
                text: line.to_string(),
            });
        }
        let sent = std::time::Instant::now();
        loop {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(grbl::Line::Ok) => return Ok(()),
                Ok(grbl::Line::Error(n)) => return Err(format!("error:{n}")),
                Ok(grbl::Line::Alarm(n)) => return Err(format!("ALARM:{n}")),
                Ok(grbl::Line::Welcome(_)) => return Err("aborted".into()),
                Ok(_) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if sent.elapsed() > HOMING_TIMEOUT {
                        return Err("homing timeout".into());
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("connection lost".into());
                }
            }
        }
    })();

    *ack_slot.lock().unwrap() = None;
    result
}

/// Write a real-time byte via the live connection, echoing `label` as "tx".
fn send_realtime(state: &State<MachineState>, byte: u8, label: &str) -> Result<(), String> {
    // Same handle-extract-then-release pattern as send_line (see its comment).
    let (writer, telemetry) = {
        let guard = state.0.lock().unwrap();
        let conn = guard.as_ref().ok_or("not connected")?;
        (conn.writer.clone(), conn.telemetry.clone())
    };
    writer
        .lock()
        .unwrap()
        .write_realtime(byte)
        .map_err(|e| e.to_string())?;
    let _ = telemetry.lock().unwrap().send(Telemetry::Line {
        dir: "tx".into(),
        text: label.to_string(),
    });
    Ok(())
}

#[tauri::command]
pub fn machine_jog(
    state: State<MachineState>,
    dx: f32,
    dy: f32,
    dz: f32,
    feed: f32,
) -> Result<(), String> {
    send_line(&state, &grbl::jog(dx, dy, dz, feed))
}

/// Absolute jog (work coords): drive the given axes to their targets. Used by the
/// click-to-move surfaces (work field, Z bar), which cancel any in-flight jog
/// before re-issuing so a new click retargets instead of queuing behind it.
#[tauri::command]
pub fn machine_jog_to(
    state: State<MachineState>,
    x: Option<f32>,
    y: Option<f32>,
    z: Option<f32>,
    feed: f32,
) -> Result<(), String> {
    send_line(&state, &grbl::jog_to(x, y, z, feed))
}

#[tauri::command]
pub fn machine_jog_cancel(state: State<MachineState>) -> Result<(), String> {
    send_realtime(&state, grbl::JOG_CANCEL, "jog-cancel")
}

/// Set the G54 work zero on the selected axes and wait for GRBL to accept it.
/// Returns Err if GRBL rejects the command (e.g. `error:N`) so the UI never
/// trusts a zero the machine didn't actually apply.
#[tauri::command]
pub fn machine_set_zero(
    state: State<MachineState>,
    x: bool,
    y: bool,
    z: bool,
) -> Result<(), String> {
    send_line_await_ok(&state, &grbl::set_work_zero(x, y, z))
}

#[tauri::command]
pub fn machine_home(state: State<MachineState>) -> Result<(), String> {
    send_line(&state, grbl::home())
}

/// Home ($H) and resolve only once the cycle completes, so the UI can show
/// progress and mark the frame homed only when GRBL confirms it (Err on
/// failure/abort/timeout). Runs the seconds-long blocking wait off the main
/// thread via `spawn_blocking`, so the webview stays responsive and the
/// "homing…" overlay can paint.
#[tauri::command]
pub async fn machine_home_await(state: State<'_, MachineState>) -> Result<(), String> {
    let writer = state.writer().ok_or("not connected")?;
    let ack_slot = state.ack_slot().ok_or("not connected")?;
    let telemetry = state.telemetry();
    tauri::async_runtime::spawn_blocking(move || home_await(writer, ack_slot, telemetry))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn machine_unlock(state: State<MachineState>) -> Result<(), String> {
    send_line(&state, grbl::unlock())
}

#[tauri::command]
pub fn machine_spindle(state: State<MachineState>, on: bool, rpm: u32) -> Result<(), String> {
    let line = if on {
        grbl::spindle_on(rpm)
    } else {
        grbl::spindle_off().to_string()
    };
    send_line(&state, &line)
}

/// Blocking body of the probe cycle, over owned handles so it can run on a
/// `spawn_blocking` thread. Probes Z (`G38.2`); on contact sets the G54 Z work-zero
/// (`G10 L20 P1 Z<offset_mm>`) and retracts Z to `safe_z_mm` (work coord). On no
/// contact / reject the Z-zero is left untouched (returns Err before the `G10`).
// Four owned connection handles + four probe scalars — inherent to the signature,
// like the other owned-handle waiters; grouping them buys nothing here.
#[allow(clippy::too_many_arguments)]
fn do_probe_z(
    writer: Arc<Mutex<GrblWriter>>,
    ack_slot: Arc<Mutex<Option<std::sync::mpsc::Sender<grbl::Line>>>>,
    activity: Arc<Mutex<Activity>>,
    telemetry: Option<Channel<Telemetry>>,
    max_dist_mm: f32,
    feed_mm_min: f32,
    offset_mm: f32,
    safe_z_mm: f32,
) -> Result<(), String> {
    await_terminal_owned(
        writer.clone(),
        ack_slot.clone(),
        activity.clone(),
        telemetry.clone(),
        &grbl::probe_z(max_dist_mm, feed_mm_min),
        true,
    )?;
    // Contact confirmed: zero Z here (board top + plate offset)...
    await_terminal_owned(
        writer.clone(),
        ack_slot,
        activity,
        telemetry.clone(),
        &format!("G10 L20 P1 Z{offset_mm}"),
        false,
    )?;
    // ...then lift clear. Fire-and-forget jog (mirrors home_await's direct write +
    // echo): a retract that's late doesn't invalidate the just-set Z-zero.
    let line = grbl::jog_to(None, None, Some(safe_z_mm), feed_mm_min);
    writer
        .lock()
        .unwrap()
        .write_line(&line)
        .map_err(|e| e.to_string())?;
    if let Some(t) = &telemetry {
        let _ = t.send(Telemetry::Line {
            dir: "tx".into(),
            text: line,
        });
    }
    Ok(())
}

/// Probe Z down onto the work surface and set the G54 Z work-zero at contact
/// (`G10 L20 P1 Z<offset_mm>`), then retract Z to `safe_z_mm` (work coord). On no
/// contact / reject the Z-zero is left untouched. The caller (frontend) is
/// responsible for the probe-pin pre-check and the connectivity self-test. The
/// descent is seconds long (max travel at probe feed), so the blocking wait runs
/// off the main thread via `spawn_blocking` — otherwise it freezes the webview.
#[tauri::command]
pub async fn machine_probe_z(
    state: State<'_, MachineState>,
    max_dist_mm: f32,
    feed_mm_min: f32,
    offset_mm: f32,
    safe_z_mm: f32,
) -> Result<(), String> {
    let writer = state.writer().ok_or("not connected")?;
    let ack_slot = state.ack_slot().ok_or("not connected")?;
    let activity = state.activity().ok_or("not connected")?;
    let telemetry = state.telemetry();
    tauri::async_runtime::spawn_blocking(move || {
        do_probe_z(
            writer,
            ack_slot,
            activity,
            telemetry,
            max_dist_mm,
            feed_mm_min,
            offset_mm,
            safe_z_mm,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn machine_send(state: State<MachineState>, line: String) -> Result<(), String> {
    // A bare `?` is the status query; GRBL's `<...>` reply is normally filtered from
    // the console (5 Hz poll noise). When the user types it explicitly, arm a
    // one-shot so the reader echoes the next status report back to them. Send it as
    // a real-time byte (no `\n`), matching the poller — a `?\n` line would also draw
    // a spurious `ok`. Arm before the write (so the reply can't beat the arm), and
    // disarm if the write fails so a stale arm can't later swallow a poll line.
    if line.trim() == "?" {
        if let Some(conn) = state.0.lock().unwrap().as_ref() {
            conn.echo_status.store(true, Ordering::Release);
        }
        let r = send_realtime(&state, grbl::STATUS_QUERY, "?");
        if r.is_err() {
            if let Some(conn) = state.0.lock().unwrap().as_ref() {
                conn.echo_status.store(false, Ordering::Relaxed);
            }
        }
        return r;
    }
    send_line(&state, &line)
}

/// Write a line and block until GRBL acknowledges it, returning Err on
/// `error:N`/`ALARM:N`. Used for firmware-setting writes (e.g. `$20=1`,
/// `$130=...`) the UI must know were actually applied — a blind send can be
/// silently dropped, so the change would never reach EEPROM yet the UI assumes
/// success.
#[tauri::command]
pub fn machine_send_await_ok(state: State<MachineState>, line: String) -> Result<(), String> {
    send_line_await_ok(&state, &line)
}

#[tauri::command]
pub fn machine_soft_reset(state: State<MachineState>) -> Result<(), String> {
    send_realtime(&state, grbl::SOFT_RESET, "soft-reset")
}

#[tauri::command]
pub fn machine_feed_hold(state: State<MachineState>) -> Result<(), String> {
    send_realtime(&state, grbl::FEED_HOLD, "!")
}

#[tauri::command]
pub fn machine_cycle_start(state: State<MachineState>) -> Result<(), String> {
    send_realtime(&state, grbl::CYCLE_START, "~")
}

/// Adjust a real-time override. `kind` ∈ {feed, rapid, spindle};
/// `action` ∈ {"100", "+10", "-10", "+1", "-1", "stop"}. "stop" is spindle-only.
#[tauri::command]
pub fn machine_override(
    state: State<MachineState>,
    kind: String,
    action: String,
) -> Result<(), String> {
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
        _ => return Err(format!("unknown override: {kind}/{action}")),
    };
    send_realtime(&state, byte, &format!("ov:{kind}{action}"))
}

impl MachineState {
    pub(crate) fn writer(&self) -> Option<Arc<Mutex<GrblWriter>>> {
        self.0.lock().unwrap().as_ref().map(|c| c.writer.clone())
    }

    pub(crate) fn ack_slot(
        &self,
    ) -> Option<Arc<Mutex<Option<std::sync::mpsc::Sender<grbl::Line>>>>> {
        self.0.lock().unwrap().as_ref().map(|c| c.ack_tx.clone())
    }

    pub(crate) fn activity(&self) -> Option<Arc<Mutex<Activity>>> {
        self.0.lock().unwrap().as_ref().map(|c| c.activity.clone())
    }

    pub(crate) fn telemetry(&self) -> Option<Channel<Telemetry>> {
        self.0
            .lock()
            .unwrap()
            .as_ref()
            .map(|c| c.telemetry.lock().unwrap().clone())
    }

    pub(crate) fn is_connected(&self) -> bool {
        self.0.lock().unwrap().is_some()
    }
}

#[tauri::command]
pub fn machine_is_connected(state: State<MachineState>) -> bool {
    state.is_connected()
}

/// Re-bind a fresh telemetry Channel to the still-live connection after a webview
/// reload (which destroys the front-end's previous Channel while the backend keeps
/// the serial port and reader/poller threads running). Returns the held port so the
/// front-end can restore its connection state, or `None` if nothing is connected.
#[tauri::command]
pub fn machine_reattach(
    state: State<MachineState>,
    telemetry: Channel<Telemetry>,
) -> Option<ReattachDto> {
    let guard = state.0.lock().unwrap();
    let conn = guard.as_ref()?;
    *conn.telemetry.lock().unwrap() = telemetry;
    Some(ReattachDto {
        port: conn.port.clone(),
    })
}

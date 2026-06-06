use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};

use cuprum_core::grbl::{self, GrblWriter, MachineState as GrblState};

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
    },
    Line {
        /// "rx" (from GRBL) | "tx" (sent by us).
        dir: String,
        text: String,
    },
}

/// Position snapshot broadcast as the global `machine://status` event so the
/// separate drill webview can track the tool without the main window's Channel.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MachinePos {
    state: String,
    mpos: [f32; 3],
    wpos: [f32; 3],
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
    writer: Arc<Mutex<GrblWriter>>,
    telemetry: Channel<Telemetry>,
    stop: Arc<AtomicBool>,
    reader_handle: Option<JoinHandle<()>>,
    poller_handle: Option<JoinHandle<()>>,
    ack_tx: Arc<Mutex<Option<std::sync::mpsc::Sender<grbl::Line>>>>,
    activity: Arc<Mutex<Activity>>,
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
    if guard.is_some() {
        return Err("already connected".into());
    }
    let (writer, mut reader) = grbl::open(&port, baud).map_err(|e| e.to_string())?;
    let writer = Arc::new(Mutex::new(writer));
    let stop = Arc::new(AtomicBool::new(false));
    let ack_tx: Arc<Mutex<Option<std::sync::mpsc::Sender<grbl::Line>>>> =
        Arc::new(Mutex::new(None));
    let activity = Arc::new(Mutex::new(Activity {
        last: std::time::Instant::now(),
        idle: false,
        hold: false,
    }));

    // Reader thread: parse lines, push status + raw rx lines.
    let r_stop = stop.clone();
    let r_tel = telemetry.clone();
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
                    let _ = r_tel.send(Telemetry::Line {
                        dir: "rx".into(),
                        text: line.clone(),
                    });
                    let parsed = grbl::parse_line(&line);
                    if matches!(
                        parsed,
                        grbl::Line::Ok | grbl::Line::Error(_) | grbl::Line::Alarm(_)
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
                        let _ = r_tel.send(Telemetry::Status {
                            state: state_str(s.state).into(),
                            mpos: s.mpos,
                            wpos: s.wpos,
                            feed: s.feed,
                            spindle: s.spindle,
                            overrides: s.overrides,
                        });
                        // Global broadcast for other windows (drill webview).
                        let _ = r_app.emit(
                            "machine://status",
                            MachinePos {
                                state: state_str(s.state).into(),
                                mpos: s.mpos,
                                wpos: s.wpos,
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
        writer,
        telemetry,
        stop,
        reader_handle: Some(reader_handle),
        poller_handle: Some(poller_handle),
        ack_tx,
        activity,
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
    let guard = state.0.lock().unwrap();
    let conn = guard.as_ref().ok_or("not connected")?;
    conn.writer
        .lock()
        .unwrap()
        .write_line(line)
        .map_err(|e| e.to_string())?;
    let _ = conn.telemetry.send(Telemetry::Line {
        dir: "tx".into(),
        text: line.to_string(),
    });
    Ok(())
}

/// Write a real-time byte via the live connection, echoing `label` as "tx".
fn send_realtime(state: &State<MachineState>, byte: u8, label: &str) -> Result<(), String> {
    let guard = state.0.lock().unwrap();
    let conn = guard.as_ref().ok_or("not connected")?;
    conn.writer
        .lock()
        .unwrap()
        .write_realtime(byte)
        .map_err(|e| e.to_string())?;
    let _ = conn.telemetry.send(Telemetry::Line {
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

#[tauri::command]
pub fn machine_set_zero(
    state: State<MachineState>,
    x: bool,
    y: bool,
    z: bool,
) -> Result<(), String> {
    send_line(&state, &grbl::set_work_zero(x, y, z))
}

#[tauri::command]
pub fn machine_home(state: State<MachineState>) -> Result<(), String> {
    send_line(&state, grbl::home())
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

#[tauri::command]
pub fn machine_send(state: State<MachineState>, line: String) -> Result<(), String> {
    send_line(&state, &line)
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

    pub(crate) fn is_connected(&self) -> bool {
        self.0.lock().unwrap().is_some()
    }
}

#[tauri::command]
pub fn machine_is_connected(state: State<MachineState>) -> bool {
    state.is_connected()
}

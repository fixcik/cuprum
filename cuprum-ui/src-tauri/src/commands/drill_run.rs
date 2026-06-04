use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, State};

use cuprum_core::grbl;

use super::machine::MachineState;

// ── DTOs ────────────────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrillStepDto {
    pub lines: Vec<String>,
    pub kind: String,
    #[serde(default)]
    pub pause_for_tool_change: bool,
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub diameter_mm: Option<f32>,
    #[serde(default)]
    pub hole_index: Option<u32>,
}

// ── Control + job state ──────────────────────────────────────────────────────

#[derive(Default)]
struct Control {
    abort: AtomicBool,
    paused: AtomicBool,
    confirm_tool_change: AtomicBool,
    finished: AtomicBool,
}

struct JobHandle {
    ctrl: Arc<Control>,
    handle: Option<std::thread::JoinHandle<()>>,
}

#[derive(Default)]
pub struct DrillJob(Mutex<Option<JobHandle>>);

// ── Event payloads ───────────────────────────────────────────────────────────

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    holes_completed: u32,
    holes_total: u32,
    hole_index: u32,
    step_index: u32,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolChangePayload {
    tool_name: String,
    diameter_mm: f32,
}

#[derive(Clone, serde::Serialize)]
struct StatePayload {
    phase: String,
}

#[derive(Clone, serde::Serialize)]
struct ErrorPayload {
    message: String,
}

// ── Helper: send a realtime byte via the machine writer ──────────────────────

fn send_rt(machine: &State<MachineState>, byte: u8) {
    if let Some(w) = machine.writer() {
        let _ = w.lock().unwrap().write_realtime(byte);
    }
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn drill_run_start(
    app: AppHandle,
    machine: State<MachineState>,
    job: State<DrillJob>,
    steps: Vec<DrillStepDto>,
) -> Result<(), String> {
    if !machine.is_connected() {
        return Err("not connected".into());
    }

    let writer = machine.writer().ok_or("not connected")?;
    let ack_slot = machine.ack_slot().ok_or("not connected")?;

    // Register the ack channel so the reader thread can forward ok/error/alarm.
    let (tx, rx) = std::sync::mpsc::channel::<grbl::Line>();
    *ack_slot.lock().unwrap() = Some(tx);

    let ctrl = Arc::new(Control::default());
    let ctrl_thread = ctrl.clone();

    let holes_total = steps.iter().filter(|s| s.kind == "hole").count() as u32;
    let app_thread = app.clone();

    // Hold the slot lock across the entire check-reclaim-insert sequence so
    // no concurrent start can observe a None slot mid-reinit.
    // The runner thread never locks the DrillJob slot (it uses ack_slot + ctrl
    // only), so there is no deadlock risk here.
    let mut slot = job.0.lock().unwrap();
    if let Some(h) = slot.as_ref() {
        if h.ctrl.finished.load(Relaxed) {
            // Previous run is done — join the thread (returns immediately for a
            // finished thread; safe while holding the slot lock).
            let finished = slot.take().unwrap();
            if let Some(handle) = finished.handle {
                let _ = handle.join();
            }
        } else {
            return Err("already running".into());
        }
    }

    let handle = std::thread::spawn(move || {
        run_job(
            app_thread,
            writer,
            rx,
            ack_slot,
            ctrl_thread,
            steps,
            holes_total,
        );
    });

    *slot = Some(JobHandle {
        ctrl,
        handle: Some(handle),
    });
    drop(slot);

    Ok(())
}

#[tauri::command]
pub fn drill_run_pause(
    app: AppHandle,
    machine: State<MachineState>,
    job: State<DrillJob>,
) -> Result<(), String> {
    let slot = job.0.lock().unwrap();
    if let Some(h) = slot.as_ref() {
        h.ctrl.paused.store(true, Relaxed);
        drop(slot);
        send_rt(&machine, grbl::FEED_HOLD);
        let _ = app.emit(
            "drill-run://state",
            StatePayload {
                phase: "paused".into(),
            },
        );
    }
    Ok(())
}

#[tauri::command]
pub fn drill_run_resume(
    app: AppHandle,
    machine: State<MachineState>,
    job: State<DrillJob>,
) -> Result<(), String> {
    send_rt(&machine, grbl::CYCLE_START);
    let slot = job.0.lock().unwrap();
    if let Some(h) = slot.as_ref() {
        h.ctrl.paused.store(false, Relaxed);
        drop(slot);
        let _ = app.emit(
            "drill-run://state",
            StatePayload {
                phase: "running".into(),
            },
        );
    }
    Ok(())
}

#[tauri::command]
pub fn drill_run_confirm_tool_change(job: State<DrillJob>) -> Result<(), String> {
    let slot = job.0.lock().unwrap();
    if let Some(h) = slot.as_ref() {
        h.ctrl.confirm_tool_change.store(true, Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub fn drill_run_stop(machine: State<MachineState>, job: State<DrillJob>) -> Result<(), String> {
    let slot = job.0.lock().unwrap();
    if let Some(h) = slot.as_ref() {
        h.ctrl.abort.store(true, Relaxed);
        drop(slot);
        send_rt(&machine, grbl::SOFT_RESET);
    }
    Ok(())
}

// ── Runner thread ────────────────────────────────────────────────────────────

fn run_job(
    app: AppHandle,
    writer: Arc<Mutex<cuprum_core::grbl::GrblWriter>>,
    rx: std::sync::mpsc::Receiver<grbl::Line>,
    ack_slot: Arc<Mutex<Option<std::sync::mpsc::Sender<grbl::Line>>>>,
    ctrl: Arc<Control>,
    steps: Vec<DrillStepDto>,
    holes_total: u32,
) {
    let emit_state = |phase: &str| {
        let _ = app.emit(
            "drill-run://state",
            StatePayload {
                phase: phase.to_string(),
            },
        );
    };

    emit_state("running");

    let mut holes_completed: u32 = 0;
    let mut aborted_msg: Option<String> = None;

    'outer: for (step_index, step) in steps.iter().enumerate() {
        if ctrl.abort.load(Relaxed) {
            break;
        }

        // Pause gate (between steps).
        while ctrl.paused.load(Relaxed) && !ctrl.abort.load(Relaxed) {
            std::thread::sleep(Duration::from_millis(50));
        }
        if ctrl.abort.load(Relaxed) {
            break;
        }

        // Tool-change gate.
        if step.pause_for_tool_change {
            ctrl.confirm_tool_change.store(false, Relaxed);
            let _ = app.emit(
                "drill-run://toolchange",
                ToolChangePayload {
                    tool_name: step.tool_name.clone().unwrap_or_default(),
                    diameter_mm: step.diameter_mm.unwrap_or(0.0),
                },
            );
            emit_state("awaitingToolChange");
            while !ctrl.confirm_tool_change.load(Relaxed) && !ctrl.abort.load(Relaxed) {
                std::thread::sleep(Duration::from_millis(50));
            }
            if ctrl.abort.load(Relaxed) {
                break;
            }
            emit_state("running");
        }

        // Stream lines, waiting for ok per line.
        for line in &step.lines {
            if ctrl.abort.load(Relaxed) {
                break 'outer;
            }
            if let Err(e) = writer.lock().unwrap().write_line(line) {
                aborted_msg = Some(format!("write failed: {e}"));
                break 'outer;
            }
            // Wait for ok, but stay responsive to abort (soft-reset sends a banner,
            // not an ok, so a single 30s wait would block on stop).
            let deadline = std::time::Instant::now() + Duration::from_secs(30);
            loop {
                if ctrl.abort.load(Relaxed) {
                    break 'outer;
                }
                match rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(grbl::Line::Ok) => break,
                    Ok(grbl::Line::Error(n)) => {
                        aborted_msg = Some(format!("error:{n}"));
                        break 'outer;
                    }
                    Ok(grbl::Line::Alarm(n)) => {
                        aborted_msg = Some(format!("ALARM:{n}"));
                        break 'outer;
                    }
                    // Stray non-ok line: keep waiting for the real ack.
                    Ok(_) => {}
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        if std::time::Instant::now() >= deadline {
                            aborted_msg = Some("timeout waiting for ok".into());
                            break 'outer;
                        }
                        // else keep polling (abort re-checked at loop top)
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        aborted_msg = Some("connection lost".into());
                        break 'outer;
                    }
                }
            }
        }

        if step.kind == "hole" {
            holes_completed += 1;
            let _ = app.emit(
                "drill-run://progress",
                ProgressPayload {
                    holes_completed,
                    holes_total,
                    hole_index: step.hole_index.unwrap_or(0),
                    step_index: step_index as u32,
                },
            );
        }
    }

    // Teardown: unregister the ack sender so the reader thread no longer
    // tries to forward lines into a dropped channel.
    *ack_slot.lock().unwrap() = None;

    if let Some(msg) = aborted_msg {
        let _ = writer.lock().unwrap().write_line("M5"); // best-effort spindle off
        let _ = app.emit("drill-run://error", ErrorPayload { message: msg });
        emit_state("error");
    } else if ctrl.abort.load(Relaxed) {
        let _ = writer.lock().unwrap().write_line("M5");
        emit_state("idle"); // stopped by user
    } else {
        let _ = app.emit("drill-run://done", ());
        emit_state("done");
    }

    // Mark the job as finished so drill_run_start can reclaim the slot.
    ctrl.finished.store(true, Relaxed);
}

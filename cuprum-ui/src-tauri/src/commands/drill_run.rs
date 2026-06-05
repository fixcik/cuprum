use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, State};

use cuprum_core::grbl;

use super::machine::{Activity, MachineState};

/// Abort the run if GRBL goes completely silent (no line — not even a status
/// poll reply) for this long: a real stall/disconnect.
const STALL_SILENCE: Duration = Duration::from_secs(4);
/// Abort if GRBL reports Idle (buffer drained, nothing executing) for this long
/// after a line was sent without an `ok`: the `ok` was lost on the wire.
const IDLE_NO_ACK: Duration = Duration::from_millis(2500);

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
    /// Graceful stop: runner breaks at the next step boundary (safe Z).
    stopping: AtomicBool,
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
    let activity = machine.activity().ok_or("not connected")?;

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
            RunConn {
                writer,
                rx,
                ack_slot,
                activity,
            },
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
pub fn drill_run_pause(app: AppHandle, job: State<DrillJob>) -> Result<(), String> {
    let slot = job.0.lock().unwrap();
    if let Some(h) = slot.as_ref() {
        // Idempotent: if already paused, do nothing.
        if h.ctrl.paused.load(Relaxed) {
            return Ok(());
        }
        h.ctrl.paused.store(true, Relaxed);
        // Emit intermediate "pausing" immediately so the UI can show a spinner
        // while the runner waits for the bit to reach safe Z.
        let _ = app.emit(
            "drill-run://state",
            StatePayload {
                phase: "pausing".into(),
            },
        );
    }
    Ok(())
}

#[tauri::command]
pub fn drill_run_resume(job: State<DrillJob>) -> Result<(), String> {
    let slot = job.0.lock().unwrap();
    if let Some(h) = slot.as_ref() {
        h.ctrl.paused.store(false, Relaxed);
        // The runner emits "running" itself once it re-spins the spindle.
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

/// Graceful stop: the runner finishes the current hole (bit returns to safe Z)
/// then stops cleanly — no ALARM, re-runnable.
#[tauri::command]
pub fn drill_run_stop(app: AppHandle, job: State<DrillJob>) -> Result<(), String> {
    let slot = job.0.lock().unwrap();
    if let Some(h) = slot.as_ref() {
        // Idempotent: a second stop while already stopping is a no-op.
        if h.ctrl.stopping.load(Relaxed) {
            return Ok(());
        }
        h.ctrl.stopping.store(true, Relaxed);
        // Emit intermediate "stopping" immediately so the UI can show a spinner
        // while the runner finishes the current hole and retracts to safe Z.
        let _ = app.emit(
            "drill-run://state",
            StatePayload {
                phase: "stopping".into(),
            },
        );
    }
    Ok(())
}

/// Emergency stop: immediate feed-hold + soft-reset. ALARM is expected and
/// acceptable; use only when the graceful stop is insufficient.
#[tauri::command]
pub fn drill_run_estop(machine: State<MachineState>, job: State<DrillJob>) -> Result<(), String> {
    let slot = job.0.lock().unwrap();
    if let Some(h) = slot.as_ref() {
        h.ctrl.abort.store(true, Relaxed);
        drop(slot);
        send_rt(&machine, grbl::FEED_HOLD);
        send_rt(&machine, grbl::SOFT_RESET);
    }
    Ok(())
}

// ── Runner thread ────────────────────────────────────────────────────────────

/// Connection handles the runner owns (cloned out of `MachineState` before the
/// thread spawns, so no `State<>` crosses the thread boundary).
struct RunConn {
    writer: Arc<Mutex<cuprum_core::grbl::GrblWriter>>,
    rx: std::sync::mpsc::Receiver<grbl::Line>,
    ack_slot: Arc<Mutex<Option<std::sync::mpsc::Sender<grbl::Line>>>>,
    activity: Arc<Mutex<Activity>>,
}

fn run_job(
    app: AppHandle,
    conn: RunConn,
    ctrl: Arc<Control>,
    steps: Vec<DrillStepDto>,
    holes_total: u32,
) {
    let RunConn {
        writer,
        rx,
        ack_slot,
        activity,
    } = conn;

    let emit_state = |phase: &str| {
        let _ = app.emit(
            "drill-run://state",
            StatePayload {
                phase: phase.to_string(),
            },
        );
    };

    // Wait until GRBL reports Idle (bit physically at safe Z after a retract).
    // Times out after 30 s to avoid hanging indefinitely on a lost connection.
    let wait_idle = |ctrl: &Control, activity: &Arc<Mutex<Activity>>| {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while std::time::Instant::now() < deadline {
            if ctrl.abort.load(Relaxed)
                || ctrl.stopping.load(Relaxed)
                || activity.lock().unwrap().idle
            {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    };

    emit_state("running");

    let mut holes_completed: u32 = 0;
    let mut aborted_msg: Option<String> = None;
    // Last M3 command sent — used to restart the spindle after a pause.
    let mut last_spindle_on: Option<String> = None;

    'outer: for (step_index, step) in steps.iter().enumerate() {
        if ctrl.abort.load(Relaxed) {
            break;
        }

        // Graceful-stop gate: previous step ended at safe Z — clean exit.
        if ctrl.stopping.load(Relaxed) {
            break;
        }

        // Pause gate (between steps): bit is at safe Z, spindle can be stopped.
        if ctrl.paused.load(Relaxed) {
            // Stop the spindle if it was running, then wait for the bit to
            // physically reach safe Z before blocking.
            if last_spindle_on.is_some() {
                let _ = writer.lock().unwrap().write_line("M5");
            }
            wait_idle(&ctrl, &activity);
            emit_state("paused");
            while ctrl.paused.load(Relaxed)
                && !ctrl.abort.load(Relaxed)
                && !ctrl.stopping.load(Relaxed)
            {
                std::thread::sleep(Duration::from_millis(50));
            }
            if ctrl.abort.load(Relaxed) || ctrl.stopping.load(Relaxed) {
                break;
            }
            // Resume: spin the spindle back up before motion resumes.
            if let Some(s) = &last_spindle_on {
                let _ = writer.lock().unwrap().write_line(s);
            }
            emit_state("running");
        }

        // Stream the step's lines FIRST (waiting for ok per line). For a
        // tool-change step this stops the spindle (M5) and retracts to safe Z
        // before we pause for the operator — so the bit is swapped with the
        // spindle stopped (safety). The tool-change pause happens after this block.
        for line in &step.lines {
            if ctrl.abort.load(Relaxed) {
                break 'outer;
            }
            // Track the last spindle-on command for pause/resume re-engagement.
            if line.trim_start().starts_with("M3") {
                last_spindle_on = Some(line.clone());
            }
            if let Err(e) = writer.lock().unwrap().write_line(line) {
                aborted_msg = Some(format!("write failed: {e}"));
                break 'outer;
            }
            // Wait for ok based on GRBL LIVENESS, not a fixed deadline: a long
            // move keeps GRBL in Run and the 200 ms status poll flowing, so we
            // keep waiting as long as the link is alive. Abort only on a real
            // stall (no line at all for STALL_SILENCE), a lost ok (GRBL Idle —
            // buffer drained — with no ack for IDLE_NO_ACK), abort, or error.
            // (Soft-reset on Stop replies with a banner, not an ok, so abort is
            // re-checked at the top each tick.)
            let sent = std::time::Instant::now();
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
                        let (silent, idle) = {
                            let a = activity.lock().unwrap();
                            (a.last.elapsed(), a.idle)
                        };
                        if silent > STALL_SILENCE {
                            aborted_msg = Some("no response from machine".into());
                            break 'outer;
                        }
                        if idle && sent.elapsed() > IDLE_NO_ACK {
                            aborted_msg = Some("machine idle, no ack (lost ok)".into());
                            break 'outer;
                        }
                        // else GRBL is alive and busy — keep waiting.
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        aborted_msg = Some("connection lost".into());
                        break 'outer;
                    }
                }
            }
        }

        // Tool-change gate — AFTER the step's lines (the spindle was stopped and
        // Z retracted above), so the operator swaps the bit with the spindle off.
        // Spindle-up (M3 S…) lives on the next group's first hole step, streamed
        // only after the operator confirms.
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
            while !ctrl.confirm_tool_change.load(Relaxed)
                && !ctrl.abort.load(Relaxed)
                && !ctrl.stopping.load(Relaxed)
            {
                std::thread::sleep(Duration::from_millis(50));
            }
            if ctrl.abort.load(Relaxed) || ctrl.stopping.load(Relaxed) {
                break;
            }
            emit_state("running");
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
        // Emergency stop: machine may be in ALARM — just stop the spindle best-effort.
        let _ = writer.lock().unwrap().write_line("M5");
        emit_state("idle");
    } else if ctrl.stopping.load(Relaxed) {
        // Graceful stop: bit is at safe Z, no ALARM, machine is re-runnable.
        let _ = writer.lock().unwrap().write_line("M5");
        emit_state("idle");
    } else {
        let _ = app.emit("drill-run://done", ());
        emit_state("done");
    }

    // Mark the job as finished so drill_run_start can reclaim the slot.
    ctrl.finished.store(true, Relaxed);
}

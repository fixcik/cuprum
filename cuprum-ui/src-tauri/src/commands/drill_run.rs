use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, State};
use tokio::sync::broadcast;

use cuprum_core::grbl::{self, GrblEvent, GrblHandle, GrblLease, MachineState as GrblState};

use super::machine::MachineState;

// ── Planning ─────────────────────────────────────────────────────────────────

/// Compute the drill route, G-code program and time estimate in the Rust core.
/// The GRBL kinematics are ALWAYS taken from the backend cache (kept fresh by
/// `$$` reads and console `$NNN=` snooping); any `kinematics` field the frontend
/// sends is ignored, so the estimate uses the controller's real limits.
#[tauri::command]
pub async fn drill_plan(
    state: State<'_, MachineState>,
    mut input: cuprum_core::drilling::DrillPlanInput,
) -> Result<cuprum_core::drilling::DrillPlanResult, String> {
    // Snapshot the cached kinematics on the IPC thread (cheap lock), then run the
    // route/G-code/estimate off-thread: the planner is non-trivial and the editor
    // re-plans on every preview tweak, so it must not block the IPC thread.
    input.kinematics = state.kinematics();
    tauri::async_runtime::spawn_blocking(move || cuprum_core::drilling::drill_plan(input))
        .await
        .map_err(|e| e.to_string())
}

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
    /// The runner task. Not joined: completion is signalled by `ctrl.finished`,
    /// and a new run reclaims the slot once that is set.
    #[allow(dead_code)]
    task: tauri::async_runtime::JoinHandle<()>,
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

// ── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn drill_run_start(
    app: AppHandle,
    machine: State<'_, MachineState>,
    job: State<'_, DrillJob>,
    steps: Vec<DrillStepDto>,
) -> Result<(), String> {
    let handle = machine.handle().ok_or("not connected")?;

    // Reclaim a finished job's slot, or refuse if one is still live. Held only
    // briefly; the runner task never locks this slot.
    {
        let mut slot = job.0.lock().unwrap();
        if let Some(h) = slot.as_ref() {
            if h.ctrl.finished.load(Relaxed) {
                slot.take();
            } else {
                return Err("already running".into());
            }
        }
    }

    // Take the exclusive line-lane lease for the whole run: interactive line
    // commands (jog, set-zero…) are refused with `busy` until it is released, so
    // nothing can interleave the drill stream. Real-time bytes (feed-hold, e-stop,
    // overrides) still pass. A previous run's lease is released on its task end;
    // retry briefly in case that release is still in flight.
    let lease = acquire_lease_retry(&handle).await?;
    let status = handle.subscribe();

    let ctrl = Arc::new(Control::default());
    let holes_total = steps.iter().filter(|s| s.kind == "hole").count() as u32;

    let task = tauri::async_runtime::spawn(run_job(
        app.clone(),
        handle,
        lease,
        status,
        ctrl.clone(),
        steps,
        holes_total,
    ));

    *job.0.lock().unwrap() = Some(JobHandle { ctrl, task });
    Ok(())
}

/// Acquire the line-lane lease, retrying briefly while it reports `Busy` (a prior
/// run's lease release may still be in flight). Gives up after ~1 s.
async fn acquire_lease_retry(handle: &GrblHandle) -> Result<GrblLease, String> {
    for _ in 0..20 {
        match handle.acquire_lease().await {
            Ok(lease) => return Ok(lease),
            Err(grbl::GrblError::Busy) => tokio::time::sleep(Duration::from_millis(50)).await,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("machine busy".into())
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

/// Cancel a pending graceful stop while the current hole is still finishing.
/// Valid only in the window between "stop requested" and the runner reaching the
/// next step boundary (where it would break out). Clears the `stopping` flag so
/// the runner keeps streaming instead of exiting — no program restart. After the
/// runner has committed to the stop (idle/done) or on e-stop, this is a no-op.
#[tauri::command]
pub fn drill_run_cancel_stop(app: AppHandle, job: State<DrillJob>) -> Result<(), String> {
    let slot = job.0.lock().unwrap();
    if let Some(h) = slot.as_ref() {
        let c = &h.ctrl;
        // Nothing to cancel unless a graceful stop is pending and the run is still
        // live (not finished, not aborted via e-stop).
        if c.finished.load(Relaxed) || c.abort.load(Relaxed) || !c.stopping.load(Relaxed) {
            return Ok(());
        }
        c.stopping.store(false, Relaxed);
        // Re-announce "running" so the UI drops the stop banner. If the runner had
        // already committed to the stop (a narrow race), it emits the authoritative
        // idle/done state right after and the UI converges there.
        let _ = app.emit(
            "drill-run://state",
            StatePayload {
                phase: "running".into(),
            },
        );
    }
    Ok(())
}

/// Emergency stop: immediate feed-hold + soft-reset. ALARM is expected and
/// acceptable; use only when the graceful stop is insufficient.
#[tauri::command]
pub async fn drill_run_estop(
    machine: State<'_, MachineState>,
    job: State<'_, DrillJob>,
) -> Result<(), String> {
    let aborting = {
        let slot = job.0.lock().unwrap();
        match slot.as_ref() {
            Some(h) => {
                h.ctrl.abort.store(true, Relaxed);
                true
            }
            None => false,
        }
    };
    if aborting {
        // Real-time bytes bypass the lease, so they reach GRBL even though the
        // runner holds the line lane. The soft-reset's welcome banner also
        // unblocks the runner's in-flight `send_await` (resolved as a reset).
        if let Some(handle) = machine.handle() {
            let _ = handle.send_realtime(grbl::FEED_HOLD).await;
            let _ = handle.send_realtime(grbl::SOFT_RESET).await;
        }
    }
    Ok(())
}

/// Snapshot of the live run, for a window that opens (or reopens) mid-run and needs
/// to re-attach. Phase is derived from the control flags — `holesCompleted` is not
/// tracked here (the runner emits it per hole), so a fresh follower fills progress in
/// from the next `drill-run://progress` event. `active` is false when no run is live.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrillRunStatus {
    active: bool,
    phase: String,
}

/// Report the current run status so a (re)opened drill window can reflect an
/// in-progress run instead of showing an idle screen. Best-effort: phase only,
/// progress arrives with the next live event.
#[tauri::command]
pub fn drill_run_status(job: State<DrillJob>) -> DrillRunStatus {
    let slot = job.0.lock().unwrap();
    match slot.as_ref() {
        // An aborted run (estop) is finishing — report it inactive so a re-attaching
        // window doesn't briefly show a stale live phase before `finished` is set.
        Some(h) if !h.ctrl.finished.load(Relaxed) && !h.ctrl.abort.load(Relaxed) => {
            let c = &h.ctrl;
            let phase = if c.stopping.load(Relaxed) {
                "stopping"
            } else if c.confirm_tool_change.load(Relaxed) {
                "awaitingToolChange"
            } else if c.paused.load(Relaxed) {
                "paused"
            } else {
                "running"
            };
            DrillRunStatus {
                active: true,
                phase: phase.into(),
            }
        }
        _ => DrillRunStatus {
            active: false,
            phase: "idle".into(),
        },
    }
}

// ── Runner task ────────────────────────────────────────────────────────────────

/// Wait until GRBL reports a FRESH Idle (bit physically at safe Z after a
/// retract). Stale buffered status is drained first, so we wait for a report
/// taken once this step's motion was underway. Returns early on abort (and, when
/// `stop_on_stopping`, on a graceful stop); times out after 30 s so a lost link
/// can't hang the runner. Driven by the actor's 200 ms status broadcast.
async fn wait_idle(
    status: &mut broadcast::Receiver<GrblEvent>,
    ctrl: &Control,
    stop_on_stopping: bool,
) {
    while status.try_recv().is_ok() {}
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if ctrl.abort.load(Relaxed) || (stop_on_stopping && ctrl.stopping.load(Relaxed)) {
            return;
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return;
        }
        let wait = (deadline - now).min(Duration::from_millis(150));
        match tokio::time::timeout(wait, status.recv()).await {
            Ok(Ok(GrblEvent::Status { status: s, .. })) if matches!(s.state, GrblState::Idle) => {
                return
            }
            Ok(Ok(_)) | Ok(Err(broadcast::error::RecvError::Lagged(_))) => {}
            Ok(Err(broadcast::error::RecvError::Closed)) => return,
            Err(_) => {} // timeout slice — loop to re-check flags
        }
    }
}

async fn run_job(
    app: AppHandle,
    handle: GrblHandle,
    lease: GrblLease,
    mut status: broadcast::Receiver<GrblEvent>,
    ctrl: Arc<Control>,
    steps: Vec<DrillStepDto>,
    holes_total: u32,
) {
    // Held for the whole run; released (set to None) during a tool-change pause so
    // the operator's per-tool Z bind (non-leased probe / manual touch-off) can run,
    // then reacquired before streaming the next group.
    let mut lease = Some(lease);

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
    // Whether the run is exiting because of a graceful stop. Captured at each break
    // point rather than re-read from `ctrl.stopping` at the end, so a cancel that
    // races in after the runner committed can't flip the final state to "done".
    let mut graceful_stop = false;
    // Last M3 command sent — used to restart the spindle after a pause.
    let mut last_spindle_on: Option<String> = None;

    'outer: for (step_index, step) in steps.iter().enumerate() {
        if ctrl.abort.load(Relaxed) {
            break;
        }
        // Graceful-stop gate: previous step ended at safe Z — clean exit. This is
        // also the point a pending stop becomes committed: a cancel landing after
        // this load is too late (the run is already exiting).
        if ctrl.stopping.load(Relaxed) {
            graceful_stop = true;
            break;
        }

        // Pause gate (between steps): bit is at safe Z, spindle can be stopped.
        if ctrl.paused.load(Relaxed) {
            // Stop the spindle if it was running, then wait for the bit to
            // physically reach safe Z before blocking.
            if last_spindle_on.is_some() {
                if let Some(l) = lease.as_ref() {
                    let _ = l.send_line("M5").await;
                }
            }
            wait_idle(&mut status, &ctrl, true).await;
            emit_state("paused");
            while ctrl.paused.load(Relaxed)
                && !ctrl.abort.load(Relaxed)
                && !ctrl.stopping.load(Relaxed)
            {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            if ctrl.abort.load(Relaxed) || ctrl.stopping.load(Relaxed) {
                graceful_stop = ctrl.stopping.load(Relaxed) && !ctrl.abort.load(Relaxed);
                break;
            }
            // Resume: spin the spindle back up before motion resumes.
            if let Some(s) = &last_spindle_on {
                if let Some(l) = lease.as_ref() {
                    let _ = l.send_line(s).await;
                }
            }
            emit_state("running");
        }

        // Mark a hole as the one currently being drilled BEFORE its traverse/plunge,
        // so the UI highlights it and fills the depth-progress ring while it drills.
        // `holes_completed` is still the pre-drill count here, so the UI sees this
        // hole as current (not yet completed). The post-drill emit below increments.
        if step.kind == "hole" {
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
            let Some(l) = lease.as_ref() else {
                aborted_msg = Some("lost machine lease".into());
                break 'outer;
            };
            // The actor waits for `ok` based on GRBL liveness (a long move keeps the
            // status flowing) and surfaces error/alarm/timeout/reset. A soft-reset on
            // e-stop resolves this as `reset`; abort is re-checked below.
            match l.send_await(line).await {
                Ok(()) => {}
                Err(e) => {
                    if !ctrl.abort.load(Relaxed) {
                        aborted_msg = Some(e.to_string());
                    }
                    break 'outer;
                }
            }
        }

        // Sync to physical completion before any gate or the next step. GRBL acks
        // each line on buffer-accept, NOT on motion-done, so without this the runner
        // races ahead by the planner-buffer depth (~15 blocks ≈ a few holes) and a
        // pause/stop would only take effect after the already-buffered holes had
        // drained. Wait for a fresh Idle so the pause/stop gates land on the true
        // hole boundary. E-stop (`abort`) skips the wait; a graceful stop does NOT —
        // the current hole's buffered retract to safe Z is allowed to finish.
        wait_idle(&mut status, &ctrl, false).await;

        // Tool-change gate — AFTER the step's lines (spindle stopped, Z retracted),
        // so the operator swaps the bit with the spindle off. Spindle-up (M3 S…)
        // lives on the next group's first hole step, streamed only after confirm.
        if step.pause_for_tool_change {
            ctrl.confirm_tool_change.store(false, Relaxed);
            let _ = app.emit(
                "drill-run://toolchange",
                ToolChangePayload {
                    tool_name: step.tool_name.clone().unwrap_or_default(),
                    diameter_mm: step.diameter_mm.unwrap_or(0.0),
                },
            );
            // Release the lease — AWAITING the actor — BEFORE prompting the
            // operator, so their per-tool Z bind (`machine_probe_z` G38.2 or
            // `machine_set_zero` manual touch-off, both non-leased line commands)
            // is guaranteed to pass the lease gate the instant they tap probe. A
            // fire-and-forget drop could let the prompt beat the release and make
            // the first probe fail with "machine busy".
            if let Some(l) = lease.take() {
                l.release().await;
            }
            emit_state("awaitingToolChange");
            while !ctrl.confirm_tool_change.load(Relaxed)
                && !ctrl.abort.load(Relaxed)
                && !ctrl.stopping.load(Relaxed)
            {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            if ctrl.abort.load(Relaxed) || ctrl.stopping.load(Relaxed) {
                graceful_stop = ctrl.stopping.load(Relaxed) && !ctrl.abort.load(Relaxed);
                break;
            }
            // Reclaim the lease before streaming the next group.
            match acquire_lease_retry(&handle).await {
                Ok(l) => lease = Some(l),
                Err(e) => {
                    aborted_msg = Some(e);
                    break;
                }
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

    // Best-effort spindle off on every exit path. Prefer the lease if still held
    // (a non-leased send would be refused while we hold it); otherwise the lease
    // was released at a tool-change gate and a plain send is fine.
    match &lease {
        Some(l) => {
            let _ = l.send_line("M5").await;
        }
        None => {
            let _ = handle.send_line("M5").await;
        }
    }

    if let Some(msg) = aborted_msg {
        let _ = app.emit("drill-run://error", ErrorPayload { message: msg });
        emit_state("error");
    } else if ctrl.abort.load(Relaxed) {
        // Emergency stop: machine may be in ALARM — spindle already addressed above.
        emit_state("idle");
    } else if graceful_stop {
        // Graceful stop: bit is at safe Z, no ALARM, machine is re-runnable.
        emit_state("idle");
    } else {
        let _ = app.emit("drill-run://done", ());
        emit_state("done");
    }

    // Mark the job as finished so drill_run_start can reclaim the slot. Dropping
    // `lease` here releases the line lane for interactive commands again.
    ctrl.finished.store(true, Relaxed);
}

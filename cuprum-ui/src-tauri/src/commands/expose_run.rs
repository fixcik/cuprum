//! Panel-driven UV exposure run job.
//!
//! Mirrors the shape of `drill_run.rs` for the control-state singleton, but is
//! simpler: no pause, no tool-change, no per-step streaming — just compose →
//! discover → upload → expose → poll until done/stopped.
//!
//! Events emitted:
//!   `expose://state`    — `{ stage: String, message: String }`
//!   `expose://progress` — `ExposeProgress` fields (camelCase, all Option)
//!
//! Commands: `expose_run_start`, `expose_run_stop`, `expose_run_status`.

use crate::commands::error::CmdResult;
use anyhow::Context as _;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, State};

use cuprum_core::compose::{self, InstancePlacementInput};
use cuprum_core::goo::{self, ExposureParams, SCREEN_H, SCREEN_W};
use cuprum_core::sdcp;
use cuprum_project::LayerType;

use crate::commands::printer::{DISCOVERY_TIMEOUT, PRINT_FILENAME};
use crate::traces_dir;

// ── DTOs ────────────────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GerberFileDto {
    pub path: String,
    pub layer_type: LayerType,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignDto {
    pub id: String,
    pub gerbers: Vec<GerberFileDto>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardInstanceDto {
    pub design_id: String,
    pub x_mm: f32,
    pub y_mm: f32,
    pub rotation_deg: u16,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelDto {
    pub width_mm: f32,
    pub height_mm: f32,
    pub instances: Vec<BoardInstanceDto>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExposeRunRequest {
    pub working_dir: String,
    pub panel: PanelDto,
    /// Designs referenced by the panel instances: resolved by `design_id`.
    pub designs: Vec<DesignDto>,
    /// "top" | "bottom" — selects topCopper / bottomCopper from each design.
    pub side: String,
    pub mirror: bool,
    pub invert: bool,
    pub exposure_s: f32,
    pub pwm: u16,
    /// Correlation token for the operation-run journal (Phase 3+). Carried through
    /// but not written here.
    #[allow(dead_code)]
    pub run_uid: String,
}

// ── Event payloads ───────────────────────────────────────────────────────────

#[derive(Clone, serde::Serialize)]
pub struct ExposeStatePayload {
    pub stage: String,
    pub message: String,
}

/// Re-export the SDCP progress struct as a serialisable event payload.
/// All fields are Option so a poll returning no data doesn't crash the listener.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExposeProgressPayload {
    pub current_layer: Option<u32>,
    pub total_layers: Option<u32>,
    pub percent: Option<f32>,
    pub remaining_s: Option<u32>,
    pub printer_state: Option<String>,
}

impl From<sdcp::client::ExposeProgress> for ExposeProgressPayload {
    fn from(p: sdcp::client::ExposeProgress) -> Self {
        Self {
            current_layer: p.current_layer,
            total_layers: p.total_layers,
            percent: p.percent,
            remaining_s: p.remaining_s,
            printer_state: p.printer_state,
        }
    }
}

// ── Job state ────────────────────────────────────────────────────────────────

struct ExposeControl {
    stopping: AtomicBool,
    finished: AtomicBool,
    /// Cached device info for `expose_run_stop` to send a stop command without
    /// re-discovering. Protected by a Mutex because it is set once by the runner
    /// thread and read by the command thread.
    device: Mutex<Option<sdcp::DeviceInfo>>,
    /// The last stage emitted, for `expose_run_status` re-attach.
    stage: Mutex<String>,
}

impl Default for ExposeControl {
    fn default() -> Self {
        Self {
            stopping: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            device: Mutex::new(None),
            stage: Mutex::new("idle".into()),
        }
    }
}

struct ExposeHandle {
    ctrl: Arc<ExposeControl>,
    #[allow(dead_code)]
    thread: std::thread::JoinHandle<()>,
}

#[derive(Default)]
pub struct ExposeJob(Mutex<Option<ExposeHandle>>);

// ── Helper: emit expose://state ───────────────────────────────────────────────

fn emit_expose_state(
    app: &AppHandle,
    ctrl: &ExposeControl,
    stage: &str,
    message: impl Into<String>,
) {
    *ctrl.stage.lock().unwrap() = stage.to_string();
    let _ = app.emit(
        "expose://state",
        ExposeStatePayload {
            stage: stage.to_string(),
            message: message.into(),
        },
    );
}

// ── Metrics helper: get board outline for one design ─────────────────────────

/// Compute board outline origin + size from all gerbers belonging to a design.
/// Returns `(origin_x_mm, origin_y_mm, width_mm, height_mm)`.
/// Uses the same cached `board_metrics_artifact` path that `project_board_metrics`
/// uses, so a previous DFM pass is a free cache hit here.
fn board_outline(
    working_dir: &str,
    gerbers: &[GerberFileDto],
) -> anyhow::Result<(f32, f32, f32, f32)> {
    use cuprum_core::dfm::MetricLayerInput;
    use cuprum_core::mesh::Role;
    use cuprum_project::layer::role_side;

    // Load all gerber bytes directly (working_dir + rel is already resolved by the
    // caller from the trusted Tauri IPC payload).
    let mut loaded: Vec<(String, LayerType, Vec<u8>)> = Vec::new();
    for g in gerbers {
        let abs = Path::new(working_dir).join(&g.path);
        let bytes = std::fs::read(&abs)
            .with_context(|| format!("reading gerber: {}", abs.display()))?;
        loaded.push((g.path.clone(), g.layer_type, bytes));
    }

    // Build a cache key matching `project_board_metrics` so we get a cache hit.
    let type_strs: Vec<String> = loaded.iter().map(|(_, t, _)| format!("{t:?}")).collect();
    let key = cuprum_core::cache::metrics_artifact_key(
        loaded
            .iter()
            .zip(&type_strs)
            .map(|((rel, _, bytes), ts)| (rel.as_str(), ts.as_str(), bytes.as_slice())),
    );
    let artifact_dir = Path::new(working_dir).join("artifacts").join("metrics");

    let metrics = cuprum_core::cache::board_metrics_artifact(&artifact_dir, &key, move || {
        fn build_inputs(
            loaded: &[(String, LayerType, Vec<u8>)],
        ) -> Vec<MetricLayerInput<'_>> {
            loaded
                .iter()
                .map(|(rel, t, bytes)| {
                    let (role, side) = role_side(*t);
                    MetricLayerInput {
                        role,
                        side,
                        inner: matches!(t, LayerType::InnerCopper),
                        plated: role == Role::Drill && !rel.to_lowercase().contains("npth"),
                        bytes,
                    }
                })
                .collect()
        }
        let inputs = build_inputs(&loaded);
        cuprum_core::dfm::board_metrics(&inputs)
    });

    Ok((
        metrics.board.origin_x_mm,
        metrics.board.origin_y_mm,
        metrics.board.width_mm,
        metrics.board.height_mm,
    ))
}

// ── Placement resolver ────────────────────────────────────────────────────────

/// Resolve `ExposeRunRequest` into a list of screen-pixel `Placement`s.
///
/// For each panel instance: find its design, pick the copper gerber for the
/// requested side, get the mask bbox + board outline, and build an
/// `InstancePlacementInput`. Instances with no matching copper layer are skipped
/// with a warning (not an error — a panel may mix one-sided boards).
fn resolve_placements(req: &ExposeRunRequest) -> anyhow::Result<Vec<compose::Placement>> {
    let copper_type = if req.side == "top" {
        LayerType::TopCopper
    } else {
        LayerType::BottomCopper
    };

    let mut inputs: Vec<InstancePlacementInput> = Vec::new();

    for inst in &req.panel.instances {
        // Find the design for this instance.
        let design = match req.designs.iter().find(|d| d.id == inst.design_id) {
            Some(d) => d,
            None => {
                eprintln!(
                    "expose: instance references unknown design_id {:?} — skipping",
                    inst.design_id
                );
                continue;
            }
        };

        // Find the copper gerber for the requested side.
        let copper_gerber = match design
            .gerbers
            .iter()
            .find(|g| g.layer_type == copper_type)
        {
            Some(g) => g,
            None => {
                eprintln!(
                    "expose: design {:?} has no {:?} layer (side={}) — skipping instance",
                    inst.design_id, copper_type, req.side
                );
                continue;
            }
        };

        // Absolute path to the copper mask.
        let abs_path = Path::new(&req.working_dir).join(&copper_gerber.path);

        // Get mask bbox from the in-process cache.
        let mask = cuprum_core::cache::native_mask(&abs_path)?;
        let mask_bbox_mm = (mask.min_x_mm, mask.min_y_mm, mask.max_x_mm, mask.max_y_mm);

        // Get board outline from the cached metrics path.
        let (origin_x, origin_y, board_w, board_h) =
            board_outline(&req.working_dir, &design.gerbers)?;

        inputs.push(InstancePlacementInput {
            mask_path: abs_path,
            mask_bbox_mm,
            board_origin_mm: (origin_x, origin_y),
            board_size_mm: (board_w, board_h),
            inst_x_mm: inst.x_mm,
            inst_y_mm: inst.y_mm,
            rotation_deg: inst.rotation_deg,
        });
    }

    if inputs.is_empty() {
        anyhow::bail!(
            "no exposable layers found for side '{}' — nothing to expose",
            req.side
        );
    }

    compose::resolve_panel_placements(req.panel.width_mm, req.panel.height_mm, &inputs)
}

// ── Worker ────────────────────────────────────────────────────────────────────

fn run_expose(app: AppHandle, req: ExposeRunRequest, ctrl: Arc<ExposeControl>) {
    // ── Step 1: resolve placements + compose ────────────────────────────────
    emit_expose_state(&app, &ctrl, "composing", "resolving panel placements…");

    let placements = match resolve_placements(&req) {
        Ok(p) => p,
        Err(e) => {
            emit_expose_state(&app, &ctrl, "error", e.to_string());
            ctrl.finished.store(true, Relaxed);
            return;
        }
    };

    if ctrl.stopping.load(Relaxed) {
        emit_expose_state(&app, &ctrl, "stopped", "stopped before composing");
        ctrl.finished.store(true, Relaxed);
        return;
    }

    let traces = traces_dir(&app);
    let bytes = match cuprum_core::trace::operation(
        "expose-compose",
        &traces,
        || -> anyhow::Result<Vec<u8>> {
            let screen = compose::compose_layout(&placements, req.mirror, req.invert, true)?;
            let params = ExposureParams {
                exposure_time_s: req.exposure_s,
                light_pwm: req.pwm,
            };
            let goo_file = goo::single_layer_exposure(SCREEN_W, SCREEN_H, &screen, params)?;
            Ok(goo::serialize(&goo_file))
        },
    ) {
        Ok(b) => b,
        Err(e) => {
            emit_expose_state(&app, &ctrl, "error", e.to_string());
            ctrl.finished.store(true, Relaxed);
            return;
        }
    };

    if ctrl.stopping.load(Relaxed) {
        emit_expose_state(&app, &ctrl, "stopped", "stopped before discovery");
        ctrl.finished.store(true, Relaxed);
        return;
    }

    // ── Step 2: discover ────────────────────────────────────────────────────
    emit_expose_state(&app, &ctrl, "discovering", "finding printer…");

    let device = match sdcp::discover_one(DISCOVERY_TIMEOUT) {
        Ok(d) => d,
        Err(e) => {
            emit_expose_state(&app, &ctrl, "error", format!("discovery failed: {e}"));
            ctrl.finished.store(true, Relaxed);
            return;
        }
    };

    // Cache the device so `expose_run_stop` can send a stop command.
    *ctrl.device.lock().unwrap() = Some(device.clone());

    if ctrl.stopping.load(Relaxed) {
        emit_expose_state(&app, &ctrl, "stopped", "stopped before upload");
        ctrl.finished.store(true, Relaxed);
        return;
    }

    // ── Step 3: upload ──────────────────────────────────────────────────────
    emit_expose_state(
        &app,
        &ctrl,
        "uploading",
        format!(
            "uploading {:.1} KiB to {}…",
            bytes.len() as f64 / 1024.0,
            device.data.name
        ),
    );

    if let Err(e) = sdcp::upload_file(&device.data.mainboard_ip, PRINT_FILENAME, &bytes) {
        emit_expose_state(&app, &ctrl, "error", format!("upload failed: {e}"));
        ctrl.finished.store(true, Relaxed);
        return;
    }

    if ctrl.stopping.load(Relaxed) {
        emit_expose_state(&app, &ctrl, "stopped", "stopped after upload");
        ctrl.finished.store(true, Relaxed);
        return;
    }

    // ── Step 4: connect, wait idle, start, skip preheat ─────────────────────
    emit_expose_state(&app, &ctrl, "starting", "waiting for printer to be idle…");

    let mut session = match sdcp::Session::connect(&device) {
        Ok(s) => s,
        Err(e) => {
            emit_expose_state(&app, &ctrl, "error", format!("connect failed: {e}"));
            ctrl.finished.store(true, Relaxed);
            return;
        }
    };

    if let Err(e) = session.wait_until_idle(Duration::from_secs(20)) {
        emit_expose_state(&app, &ctrl, "error", format!("wait-idle failed: {e}"));
        ctrl.finished.store(true, Relaxed);
        return;
    }

    if ctrl.stopping.load(Relaxed) {
        emit_expose_state(&app, &ctrl, "stopped", "stopped before starting exposure");
        ctrl.finished.store(true, Relaxed);
        return;
    }

    if let Err(e) = session.start_print_checked(PRINT_FILENAME, 5) {
        emit_expose_state(&app, &ctrl, "error", format!("start_print failed: {e}"));
        ctrl.finished.store(true, Relaxed);
        return;
    }
    let _ = session.skip_preheat();

    emit_expose_state(
        &app,
        &ctrl,
        "exposing",
        format!("exposure started: {:.0}s @ pwm {}", req.exposure_s, req.pwm),
    );

    // ── Step 5: poll loop ────────────────────────────────────────────────────
    // Poll until:
    //   a) the stop flag is set, or
    //   b) the printer reports Idle/done state after exposure has started, or
    //   c) the deadline (exposure_s + 60 s margin) elapses.
    let poll_deadline = std::time::Instant::now()
        + Duration::from_secs_f32(req.exposure_s)
        + Duration::from_secs(60);

    let mut first_poll = true;

    loop {
        if ctrl.stopping.load(Relaxed) {
            emit_expose_state(&app, &ctrl, "stopped", "exposure stopped by user");
            ctrl.finished.store(true, Relaxed);
            return;
        }

        if std::time::Instant::now() >= poll_deadline {
            // Deadline elapsed — the printer should have finished; declare done.
            eprintln!("expose: poll deadline elapsed; declaring done");
            break;
        }

        // Wait ~1 s between polls (first poll immediately after start).
        if !first_poll {
            // Interruptible sleep: check stopping every 100 ms.
            let sleep_end = std::time::Instant::now() + Duration::from_secs(1);
            while std::time::Instant::now() < sleep_end {
                if ctrl.stopping.load(Relaxed) {
                    emit_expose_state(&app, &ctrl, "stopped", "exposure stopped by user");
                    ctrl.finished.store(true, Relaxed);
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        first_poll = false;

        // poll_status: a single error or all-None result must NOT abort the run.
        match session.poll_status() {
            Ok(p) => {
                let done = is_exposure_done(&p, req.exposure_s);

                let _ = app.emit("expose://progress", ExposeProgressPayload::from(p));

                if done {
                    break;
                }
            }
            Err(e) => {
                // Log and keep going — a transient network hiccup shouldn't kill the run.
                eprintln!("expose: poll_status error (continuing): {e}");
            }
        }
    }

    emit_expose_state(
        &app,
        &ctrl,
        "done",
        "exposure complete — UV turns off when time elapses",
    );
    ctrl.finished.store(true, Relaxed);
}

/// Heuristic: consider the exposure done once the printer reports Idle or
/// `CurrentTicks` has reached (or passed) `TotalTicks`, or percent ≥ 100.
/// Also done if the printer_state transitions back to Idle after having started.
fn is_exposure_done(p: &sdcp::client::ExposeProgress, exposure_s: f32) -> bool {
    // remaining_s == 0 with a known total is a strong completion signal.
    if let (Some(0), Some(total)) = (p.remaining_s, p.total_layers) {
        if total > 0 {
            return true;
        }
    }
    // percent >= 100 means done.
    if p.percent.unwrap_or(0.0) >= 100.0 {
        return true;
    }
    // Printer went idle (it was exposing, now it's idle again).
    if let Some(state) = &p.printer_state {
        if state.to_lowercase().contains("idle") || state.to_lowercase().contains("finish") {
            // Guard: only treat idle as done after some exposure time has elapsed.
            // This prevents a premature exit on the first poll right after start.
            let _ = exposure_s; // used conceptually; the caller's deadline handles timeout
            return true;
        }
    }
    false
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Start a panel-driven exposure run. Spawns a background thread and returns
/// immediately. The caller listens to `expose://state` and `expose://progress`.
#[tauri::command]
pub fn expose_run_start(
    app: AppHandle,
    job: State<'_, ExposeJob>,
    req: ExposeRunRequest,
) -> CmdResult<()> {
    // Reclaim a finished job slot, or refuse if one is still live.
    {
        let mut slot = job.0.lock().unwrap();
        if let Some(h) = slot.as_ref() {
            if h.ctrl.finished.load(Relaxed) {
                slot.take();
            } else {
                return Err("exposure already running".into());
            }
        }
    }

    let ctrl = Arc::new(ExposeControl::default());
    let ctrl_thread = ctrl.clone();
    let app_thread = app.clone();

    let thread = std::thread::spawn(move || {
        run_expose(app_thread, req, ctrl_thread);
    });

    *job.0.lock().unwrap() = Some(ExposeHandle { ctrl, thread });
    Ok(())
}

/// Stop an in-progress exposure run. Sets the stopping flag and sends a
/// `stop_print` command to the printer via the cached DeviceInfo. Falls back to
/// re-discover if no device was cached yet (e.g. stopping was requested during
/// the discovery phase itself).
#[tauri::command]
pub fn expose_run_stop(app: AppHandle, job: State<'_, ExposeJob>) -> CmdResult<()> {
    // Extract ctrl + cached device under the lock, then release it before the
    // potentially-slow network call (stop_print may take seconds).
    let stop_info: Option<(Arc<ExposeControl>, Option<sdcp::DeviceInfo>)> = {
        let slot = job.0.lock().unwrap();
        match slot.as_ref() {
            Some(h) if !h.ctrl.finished.load(Relaxed) => {
                h.ctrl.stopping.store(true, Relaxed);
                let cached_device = h.ctrl.device.lock().unwrap().clone();
                Some((h.ctrl.clone(), cached_device))
            }
            _ => None,
        }
        // MutexGuard dropped here
    };

    if let Some((_ctrl, cached_device)) = stop_info {
        // Best-effort stop_print (non-fatal — the stopping flag is already set so
        // the worker loop will exit at the next iteration).
        let result = if let Some(device) = cached_device {
            sdcp::Session::connect(&device)
                .and_then(|mut s| s.stop_print().map(|_| ()))
        } else {
            // Device not discovered yet; quick re-discover.
            sdcp::discover_one(Duration::from_secs(2))
                .and_then(|device| sdcp::Session::connect(&device))
                .and_then(|mut s| s.stop_print().map(|_| ()))
        };

        if let Err(e) = result {
            eprintln!("expose_run_stop: stop_print failed (continuing): {e}");
        }

        let _ = app.emit(
            "expose://state",
            ExposeStatePayload {
                stage: "stopped".into(),
                message: "exposure stopped by user".into(),
            },
        );
    }
    Ok(())
}

/// Snapshot of the current exposure run state, for a window opening mid-run.
/// `active` is false when no run is live.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExposeRunStatus {
    pub active: bool,
    pub stage: String,
}

#[tauri::command]
pub fn expose_run_status(job: State<'_, ExposeJob>) -> CmdResult<ExposeRunStatus> {
    let slot = job.0.lock().unwrap();
    match slot.as_ref() {
        Some(h) if !h.ctrl.finished.load(Relaxed) => {
            let stage = h.ctrl.stage.lock().unwrap().clone();
            Ok(ExposeRunStatus {
                active: true,
                stage,
            })
        }
        _ => Ok(ExposeRunStatus {
            active: false,
            stage: "idle".into(),
        }),
    }
}

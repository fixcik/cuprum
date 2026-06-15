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

use cuprum_core::compose::{self, InstancePlacementInput, MirrorAxis};
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
    /// Which axis to mirror the screen buffer about ("none" | "x" | "y").
    pub mirror_axis: MirrorAxis,
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
    use crate::commands::project::read_workdir_file;
    use cuprum_core::dfm::MetricLayerInput;
    use cuprum_core::mesh::Role;
    use cuprum_project::layer::role_side;

    // Load all gerber bytes. `g.path` is IPC-supplied, so go through
    // `read_workdir_file` for the same path validation render.rs/board.rs use
    // (rejects `..`, absolute paths, drive prefixes).
    let mut loaded: Vec<(String, LayerType, Vec<u8>)> = Vec::new();
    for g in gerbers {
        let bytes = read_workdir_file(working_dir, &g.path)
            .map_err(|e| anyhow::anyhow!("{}", e.message()))
            .with_context(|| format!("reading gerber: {}", g.path))?;
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
        fn build_inputs(loaded: &[(String, LayerType, Vec<u8>)]) -> Vec<MetricLayerInput<'_>> {
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
        let copper_gerber = match design.gerbers.iter().find(|g| g.layer_type == copper_type) {
            Some(g) => g,
            None => {
                eprintln!(
                    "expose: design {:?} has no {:?} layer (side={}) — skipping instance",
                    inst.design_id, copper_type, req.side
                );
                continue;
            }
        };

        // Absolute path to the copper mask (`copper_gerber.path` is IPC-supplied,
        // so validate it the same way the other gerber-reading commands do).
        let abs_path =
            crate::commands::project::safe_workdir_path(&req.working_dir, &copper_gerber.path)
                .map_err(|e| anyhow::anyhow!("{}", e.message()))?;

        // Get the UNROTATED copper bbox.  We do NOT use the rotated mask's own
        // bbox here: native_mask rotates the copper about the COPPER centre, but a
        // rotated instance is a rigid rotation of {copper + outline} about the
        // OUTLINE centre.  When the two centres differ, using the copper-centred
        // rotation shifts registration by the inter-centre offset at 90/270.  So
        // rotate the unrotated copper bbox about the outline centre instead; the
        // resulting AABB size equals native_mask(path, rotation)'s pixmap size,
        // and compose_layout blits native_mask(path, rotation) at this position.
        let unrot_mask = cuprum_core::cache::native_mask(&abs_path, 0)?;
        let unrot_copper_bbox = (
            unrot_mask.min_x_mm,
            unrot_mask.min_y_mm,
            unrot_mask.max_x_mm,
            unrot_mask.max_y_mm,
        );

        // Board outline from cached metrics. The outline rotates about its own
        // centre (= the shared instance pivot), so rotate_bbox_about_centre is
        // correct for it.
        let (origin_x, origin_y, board_w, board_h) =
            board_outline(&req.working_dir, &design.gerbers)?;
        let outline_centre = (origin_x + board_w / 2.0, origin_y + board_h / 2.0);
        let (board_origin_mm, board_size_mm) = cuprum_core::compose::rotate_bbox_about_centre(
            (origin_x, origin_y),
            (board_w, board_h),
            inst.rotation_deg,
        );

        // Copper position: rotate the unrotated copper bbox about the OUTLINE centre.
        let (copper_origin, copper_size) = cuprum_core::compose::rotate_bbox_about_point(
            (unrot_copper_bbox.0, unrot_copper_bbox.1),
            (
                unrot_copper_bbox.2 - unrot_copper_bbox.0,
                unrot_copper_bbox.3 - unrot_copper_bbox.1,
            ),
            outline_centre,
            inst.rotation_deg,
        );
        let mask_bbox_mm = (
            copper_origin.0,
            copper_origin.1,
            copper_origin.0 + copper_size.0,
            copper_origin.1 + copper_size.1,
        );

        inputs.push(InstancePlacementInput {
            mask_path: abs_path,
            mask_bbox_mm,
            board_origin_mm,
            board_size_mm,
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
            let screen = compose::compose_layout(&placements, req.mirror_axis, req.invert, true)?;
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
    // True once we have actually observed the printer printing. The printer can
    // briefly re-report "idle" right after start_print (before it flips to
    // printing), so we must NOT treat idle as "done" until printing was seen —
    // otherwise the run declares done while the UV never turned on.
    let mut exposure_started = false;

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
                // Latch "exposure started" once we see the printer printing (state
                // == printing, or any progress: a layer / non-zero percent).
                if !exposure_started && exposure_in_progress(&p) {
                    exposure_started = true;
                }

                let done = is_exposure_done(&p, exposure_started);

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

/// True when this status shows the printer actively exposing: state == "printing",
/// or any forward progress (a current layer, non-zero percent).
fn exposure_in_progress(p: &sdcp::client::ExposeProgress) -> bool {
    if p.printer_state.as_deref() == Some("printing") {
        return true;
    }
    if p.current_layer.unwrap_or(0) > 0 {
        return true;
    }
    p.percent.unwrap_or(0.0) > 0.0
}

/// Heuristic: consider the exposure done once it has demonstrably finished.
/// `exposure_started` must be true (the printer was seen printing at least once)
/// before any completion signal is trusted — otherwise a transient "idle" right
/// after start_print would falsely declare done before the UV ever turned on.
fn is_exposure_done(p: &sdcp::client::ExposeProgress, exposure_started: bool) -> bool {
    // Until we have observed printing, never declare done (the deadline still bounds
    // the wait if the printer never reports printing).
    if !exposure_started {
        return false;
    }
    // percent >= 100 means done.
    if p.percent.unwrap_or(0.0) >= 100.0 {
        return true;
    }
    // Printer returned to idle after having printed → exposure finished.
    if p.printer_state.as_deref() == Some("idle") {
        return true;
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
///
/// This does NOT emit the terminal `expose://state {stopped}` itself — the worker
/// loop owns the terminal state: it observes the `stopping` flag and emits
/// `stopped` exactly once, so the UI sees a single authoritative transition.
#[tauri::command]
pub fn expose_run_stop(job: State<'_, ExposeJob>) -> CmdResult<()> {
    // Set the stopping flag + extract the cached device under the lock, then
    // release it before the potentially-slow network call (stop_print may take
    // seconds).
    let cached_device: Option<Option<sdcp::DeviceInfo>> = {
        let slot = job.0.lock().unwrap();
        match slot.as_ref() {
            Some(h) if !h.ctrl.finished.load(Relaxed) => {
                h.ctrl.stopping.store(true, Relaxed);
                Some(h.ctrl.device.lock().unwrap().clone())
            }
            _ => None,
        }
        // MutexGuard dropped here
    };

    if let Some(cached_device) = cached_device {
        // Best-effort stop_print (non-fatal — the stopping flag is already set so
        // the worker loop will exit at the next iteration and emit `stopped`).
        let result = if let Some(device) = cached_device {
            sdcp::Session::connect(&device).and_then(|mut s| s.stop_print().map(|_| ()))
        } else {
            // Device not discovered yet; quick re-discover.
            sdcp::discover_one(Duration::from_secs(2))
                .and_then(|device| sdcp::Session::connect(&device))
                .and_then(|mut s| s.stop_print().map(|_| ()))
        };

        if let Err(e) = result {
            eprintln!("expose_run_stop: stop_print failed (continuing): {e}");
        }
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

use crate::commands::error::{CmdError, CmdResult};
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use cuprum_core::compose::{self, Placement};
use cuprum_core::goo::{
    self, ExposureParams, SCREEN_H, SCREEN_PX_PER_MM_X, SCREEN_PX_PER_MM_Y, SCREEN_W,
};
use cuprum_core::sdcp;

use crate::traces_dir;

pub(crate) const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(4);
pub(crate) const PRINT_FILENAME: &str = "cuprum-ui.goo";

#[derive(Serialize)]
pub(crate) struct PrinterInfo {
    pub name: String,
    pub ip: String,
}

#[derive(Serialize)]
pub(crate) struct PreviewResult {
    /// PNG as a data URL, ready for an <img>/Konva image.
    pub png_data_url: String,
    pub width_mm: f32,
    pub height_mm: f32,
    /// Render timing breakdown (shown in the front-end console for diagnosis).
    pub timings: String,
}

#[derive(Deserialize)]
pub(crate) struct PlacementDto {
    pub path: String,
    /// Top-left of the artwork on the screen, in millimeters.
    pub x_mm: f32,
    pub y_mm: f32,
    #[serde(default)]
    pub rotation_deg: u16,
}

#[derive(Deserialize)]
pub(crate) struct PrintRequest {
    pub placements: Vec<PlacementDto>,
    pub mirror: bool,
    pub invert: bool,
    pub exposure_s: f32,
    pub pwm: u16,
}

#[derive(Serialize, Clone)]
pub(crate) struct PrintStatus {
    pub stage: String,
    pub message: String,
}

pub(crate) fn emit_status(app: &AppHandle, stage: &str, message: impl Into<String>) {
    let _ = app.emit(
        "print-status",
        PrintStatus {
            stage: stage.to_string(),
            message: message.into(),
        },
    );
}

/// Discover the first printer on the LAN. Async + spawn_blocking so the 4s UDP
/// wait runs off the core's main thread (otherwise it freezes the event loop).
#[tauri::command]
pub(crate) async fn discover() -> CmdResult<PrinterInfo> {
    let d =
        tauri::async_runtime::spawn_blocking(|| sdcp::discover_one(DISCOVERY_TIMEOUT)).await??;
    Ok(PrinterInfo {
        name: d.data.name,
        ip: d.data.mainboard_ip,
    })
}

/// Render a Gerber to a preview PNG + its true mm size. Called once per file.
/// Async + spawn_blocking: rasterization is CPU-bound; keep it off the main
/// thread so concurrent renders (reload) don't serialize and the UI stays live.
#[tauri::command]
pub(crate) async fn render_preview(
    app: AppHandle,
    path: String,
    max_px: u32,
) -> CmdResult<PreviewResult> {
    let dir = traces_dir(&app);
    let (png, info, timings) = tauri::async_runtime::spawn_blocking(move || {
        cuprum_core::trace::operation("render", &dir, || {
            cuprum_core::cache::preview_png(std::path::Path::new(&path), max_px)
        })
    })
    .await??;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
    Ok(PreviewResult {
        png_data_url: format!("data:image/png;base64,{b64}"),
        width_mm: info.width_mm,
        height_mm: info.height_mm,
        timings,
    })
}

/// Compose the layout at full resolution, upload, and fire the exposure. Runs on
/// a background thread and streams progress via the `print-status` event.
#[tauri::command]
pub(crate) fn compose_and_print(app: AppHandle, req: PrintRequest) -> CmdResult<()> {
    std::thread::spawn(move || {
        if let Err(e) = run_print(&app, req) {
            emit_status(&app, "error", e.to_string());
        }
    });
    Ok(())
}

pub(crate) fn run_print(app: &AppHandle, req: PrintRequest) -> anyhow::Result<()> {
    emit_status(app, "composing", "rendering & composing layout…");
    let placements: Vec<Placement> = req
        .placements
        .iter()
        .map(|p| Placement {
            path: p.path.clone().into(),
            off_x: (p.x_mm * SCREEN_PX_PER_MM_X).round() as i32,
            off_y: (p.y_mm * SCREEN_PX_PER_MM_Y).round() as i32,
            rotation_deg: p.rotation_deg,
        })
        .collect();

    let bytes = cuprum_core::trace::operation(
        "compose",
        &traces_dir(app),
        || -> anyhow::Result<Vec<u8>> {
            let screen = compose::compose_layout(&placements, req.mirror, req.invert, true)?;
            let params = ExposureParams {
                exposure_time_s: req.exposure_s,
                light_pwm: req.pwm,
            };
            let goo_file = goo::single_layer_exposure(SCREEN_W, SCREEN_H, &screen, params)?;
            Ok(goo::serialize(&goo_file))
        },
    )?;

    emit_status(app, "discovering", "finding printer…");
    let device = sdcp::discover_one(DISCOVERY_TIMEOUT)?;

    emit_status(
        app,
        "uploading",
        format!(
            "uploading {:.1} KiB to {}…",
            bytes.len() as f64 / 1024.0,
            device.data.name
        ),
    );
    sdcp::upload_file(&device.data.mainboard_ip, PRINT_FILENAME, &bytes)?;

    let mut session = sdcp::Session::connect(&device)?;
    emit_status(app, "starting", "waiting for printer to be idle…");
    session.wait_until_idle(Duration::from_secs(20))?;
    session.start_print_checked(PRINT_FILENAME, 5)?;
    let _ = session.skip_preheat();

    emit_status(
        app,
        "exposing",
        format!("exposure started: {:.0}s @ pwm {}", req.exposure_s, req.pwm),
    );
    // Drain briefly so skip_preheat flushes; the printer runs the job on its own.
    let drain = std::time::Instant::now() + Duration::from_secs(2);
    while std::time::Instant::now() < drain {
        let _ = session.try_recv()?;
    }
    emit_status(
        app,
        "done",
        "exposure running — UV turns off when time elapses",
    );
    Ok(())
}

/// Abort any running print. Async + spawn_blocking (discover + WS are blocking).
#[tauri::command]
pub(crate) async fn stop_print() -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(|| -> anyhow::Result<()> {
        let device = sdcp::discover_one(DISCOVERY_TIMEOUT)?;
        let mut session = sdcp::Session::connect(&device)?;
        session.stop_print()?;
        Ok(())
    })
    .await?
    .map_err(CmdError::from)
}

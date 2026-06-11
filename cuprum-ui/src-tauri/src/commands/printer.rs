use crate::commands::error::CmdResult;
use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use tauri::AppHandle;

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


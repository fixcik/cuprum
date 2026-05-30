//! In-process render cache, keyed by file path + modification time.
//!
//! Rasterizing a Gerber is the expensive step, and the same file is rendered
//! repeatedly: the preview on every (re)load, and the native mask on every
//! Expose. The Tauri Rust process outlives webview reloads, so caching here
//! makes reloads and repeat-exposes instant. Entries auto-invalidate when the
//! file's mtime changes (you edited/re-exported the Gerber).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use anyhow::Result;

use crate::gerber::{self, RenderInfo, RenderOptions};

/// A rasterized full-resolution (native-pitch) mask, ready to blit.
pub struct Mask {
    pub px: Vec<u8>,
    pub w: u32,
    pub h: u32,
}

struct PreviewEntry {
    mtime: SystemTime,
    max_px: u32,
    png: Vec<u8>,
    info: RenderInfo,
    summary: String,
}

struct MaskEntry {
    mtime: SystemTime,
    mask: Arc<Mask>,
}

fn preview_cache() -> &'static Mutex<HashMap<PathBuf, PreviewEntry>> {
    static C: OnceLock<Mutex<HashMap<PathBuf, PreviewEntry>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn mask_cache() -> &'static Mutex<HashMap<PathBuf, MaskEntry>> {
    static C: OnceLock<Mutex<HashMap<PathBuf, MaskEntry>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn mtime(path: &Path) -> Result<SystemTime> {
    Ok(std::fs::metadata(path)?.modified()?)
}

/// Cached preview PNG (+ geometry + timing summary). Renders on a miss / stale
/// entry; otherwise returns the stored bytes instantly.
pub fn preview_png(path: &Path, max_px: u32) -> Result<(Vec<u8>, RenderInfo, String)> {
    let m = mtime(path)?;
    if let Some(e) = preview_cache().lock().unwrap().get(path) {
        if e.mtime == m && e.max_px == max_px {
            return Ok((e.png.clone(), e.info, format!("{} (cached)", e.summary)));
        }
    }
    // Render outside the lock so parallel renders of distinct files don't serialize.
    let (png, info, summary) = gerber::render_preview_png(path, max_px)?;
    preview_cache().lock().unwrap().insert(
        path.to_owned(),
        PreviewEntry { mtime: m, max_px, png: png.clone(), info, summary: summary.clone() },
    );
    Ok((png, info, summary))
}

/// Cached native-pitch mask for compositing the exposure.
pub fn native_mask(path: &Path) -> Result<Arc<Mask>> {
    let m = mtime(path)?;
    if let Some(e) = mask_cache().lock().unwrap().get(path) {
        if e.mtime == m {
            return Ok(e.mask.clone());
        }
    }
    let commands = gerber::parse_file(path)?;
    let opts = RenderOptions { margin_mm: 0.0, ..Default::default() };
    let (pm, info) = gerber::render_with_info(commands, &opts)?;
    let mask = Arc::new(Mask { px: gerber::to_grayscale(&pm), w: info.px_w, h: info.px_h });
    mask_cache()
        .lock()
        .unwrap()
        .insert(path.to_owned(), MaskEntry { mtime: m, mask: mask.clone() });
    Ok(mask)
}

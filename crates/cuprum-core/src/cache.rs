//! In-process render caches keyed by file path + mtime.
//!
//! Two path+mtime caches live here ([`preview_png`], [`native_mask`]): rasterizing
//! a Gerber is expensive and the same file is rendered repeatedly (preview on every
//! reload, native mask on every Expose). Entries auto-invalidate on mtime change.
//!
//! The generic single-flight engine (in-memory LRU + disk tier + per-key
//! single-flight) now lives in the [`cuprum_cache`] leaf crate; the typed wrappers
//! that use it live in their own domains (SVG renders in [`crate::svg`], board
//! metrics in [`crate::dfm`], gerber parse in [`crate::gerber`]). Those wrappers are
//! re-exported below under the historical `cache::` paths for existing callers.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use anyhow::Result;

use crate::gerber::{self, RenderInfo, RenderOptions};

// Facade: the typed cache wrappers now live with their domains; re-export them
// under the historical `cache::` paths so existing callers (project / UI / in-core
// preview) keep resolving `cuprum_core::cache::…` unchanged.
pub use crate::dfm::{board_metrics_artifact, board_metrics_cached, metrics_artifact_key};
pub use crate::svg::{layer_svg_artifact, layer_svg_cached, svg_artifact_key};

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
    if !crate::diskcache::cache_disabled() {
        if let Some(e) = preview_cache().lock().unwrap().get(path) {
            if e.mtime == m && e.max_px == max_px {
                return Ok((e.png.clone(), e.info, format!("{} (cached)", e.summary)));
            }
        }
    }
    // Render outside the lock so parallel renders of distinct files don't serialize.
    let (png, info, summary) = gerber::render_preview_png(path, max_px)?;
    if !crate::diskcache::cache_disabled() {
        preview_cache().lock().unwrap().insert(
            path.to_owned(),
            PreviewEntry {
                mtime: m,
                max_px,
                png: png.clone(),
                info,
                summary: summary.clone(),
            },
        );
    }
    Ok((png, info, summary))
}

/// Cached native-pitch mask for compositing the exposure.
pub fn native_mask(path: &Path) -> Result<Arc<Mask>> {
    let m = mtime(path)?;
    if !crate::diskcache::cache_disabled() {
        if let Some(e) = mask_cache().lock().unwrap().get(path) {
            if e.mtime == m {
                return Ok(e.mask.clone());
            }
        }
    }
    let commands = gerber::parse_file(path)?;
    let opts = RenderOptions {
        margin_mm: 0.0,
        ..Default::default()
    };
    let (pm, info) = gerber::render_with_info(commands, &opts)?;
    let mask = Arc::new(Mask {
        px: gerber::to_grayscale(&pm),
        w: info.px_w,
        h: info.px_h,
    });
    if !crate::diskcache::cache_disabled() {
        mask_cache().lock().unwrap().insert(
            path.to_owned(),
            MaskEntry {
                mtime: m,
                mask: mask.clone(),
            },
        );
    }
    Ok(mask)
}

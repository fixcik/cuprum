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
use crate::svg::{self, LayerGeometry};

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

/// SVG cache key tag. Bump when SVG render output changes. Content-hash of the
/// gerber bytes + this tag is the cache key.
const SVG_CACHE_TAG: &[u8] = b"svg-v1";

/// Disk cache budget/TTL for SVG entries. Centralized here now that SVG disk
/// caching lives in core.
const SVG_DISK_MAX_BYTES: u64 = 256 * 1024 * 1024; // 256 MB
const SVG_DISK_TTL: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 60 * 60);

fn svg_cache() -> &'static Mutex<HashMap<String, LayerGeometry>> {
    static C: OnceLock<Mutex<HashMap<String, LayerGeometry>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Render a gerber layer to SVG, going through the in-memory and disk caches.
/// Order: in-memory → disk → render. On a render, both caches are populated.
/// Keyed by `hash(SVG_CACHE_TAG + bytes)` so a layer is never recomputed while
/// its gerber bytes are unchanged. Honors `diskcache::cache_disabled()`.
///
/// `cache_dir` is the disk-cache directory; `id` is the SVG element id (scopes
/// the clear-polarity mask).
pub fn layer_svg_cached(cache_dir: &Path, bytes: &[u8], id: &str) -> anyhow::Result<LayerGeometry> {
    let key = crate::diskcache::key_for(&[SVG_CACHE_TAG, bytes]);

    // 1. In-memory.
    if !crate::diskcache::cache_disabled() {
        if let Some(g) = svg_cache().lock().unwrap().get(&key) {
            return Ok(g.clone());
        }
    }

    // 2. Disk. The `cache_disabled()` gate here is load-bearing: it also skips
    //    populating the in-memory layer below. (diskcache::get/put self-gate too.)
    if !crate::diskcache::cache_disabled() {
        if let Some(blob) = crate::diskcache::get(cache_dir, &key, SVG_DISK_TTL) {
            if let Ok(g) = serde_json::from_slice::<LayerGeometry>(&blob) {
                svg_cache().lock().unwrap().insert(key.clone(), g.clone());
                return Ok(g);
            }
        }
    }

    // 3. Render (outside any lock so parallel renders of distinct layers don't
    //    serialize), then populate both caches.
    let g = svg::render_layer_svg(bytes, id)?;
    if !crate::diskcache::cache_disabled() {
        if let Ok(blob) = serde_json::to_vec(&g) {
            crate::diskcache::put(cache_dir, &key, &blob, SVG_DISK_MAX_BYTES, SVG_DISK_TTL);
        }
        svg_cache().lock().unwrap().insert(key, g.clone());
    }
    Ok(g)
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

#[cfg(test)]
mod tests {
    use super::*;

    // Flash a 1mm circle aperture at the origin — same fixture as svg.rs tests.
    const GBR: &[u8] = b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,1.0*%\nD10*\nX0Y0D03*\nM02*\n";

    #[test]
    fn layer_svg_cached_memory_hit_skips_disk() {
        let dir = std::env::temp_dir().join(format!("cuprum-svgcache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // First call: miss → render + populate both caches.
        let a = layer_svg_cached(&dir, GBR, "ly_test").expect("render ok");
        // Wipe the disk cache: a second hit now can only come from the in-memory layer.
        let _ = std::fs::remove_dir_all(&dir);
        let b = layer_svg_cached(&dir, GBR, "ly_test").expect("memory hit ok");
        assert_eq!(a.svg_body, b.svg_body, "in-memory cached svg identical");
        assert_eq!(a.bbox, b.bbox, "in-memory cached bbox identical");
        assert_eq!(a.snap, b.snap, "in-memory cached snap identical");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn layer_svg_cached_distinct_bytes_produce_distinct_geometry() {
        let dir = std::env::temp_dir().join(format!("cuprum-svgcache2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let other: &[u8] = b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,2.0*%\nD10*\nX0Y0D03*\nM02*\n";
        let a = layer_svg_cached(&dir, GBR, "ly_a").expect("ok");
        let b = layer_svg_cached(&dir, other, "ly_b").expect("ok");
        // Different aperture diameter → different geometry: distinct bytes are not
        // conflated into one cache entry.
        assert_ne!(a.bbox, b.bbox, "distinct gerbers yield distinct geometry");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

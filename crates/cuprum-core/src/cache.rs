//! In-process render caches + the shared single-flight cache engine.
//!
//! Two path+mtime caches live here ([`preview_png`], [`native_mask`]): rasterizing
//! a Gerber is expensive and the same file is rendered repeatedly (preview on every
//! reload, native mask on every Expose). Entries auto-invalidate on mtime change.
//!
//! The generic [`cached_single_flight`]/[`cached_single_flight_persistent`] engine
//! (in-memory LRU + disk tier + per-key single-flight) also lives here, `pub(crate)`
//! so the typed wrappers in their own domains use it: SVG renders in [`crate::svg`],
//! board metrics in [`crate::dfm`], gerber parse in [`crate::gerber`]. Those wrappers
//! are re-exported below under the historical `cache::` paths for existing callers.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use anyhow::Result;
use lru::LruCache;
use serde::de::DeserializeOwned;
use serde::Serialize;

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

/// In-memory (LRU) + disk cache with single-flight de-dup of concurrent misses.
/// Order: in-memory → disk → (NO_CACHE bypass) → per-key flight → render once.
/// `mem` is the typed LRU store; `inflight` the per-key lock registry; `render`
/// computes the value at most once per key under concurrency (the loser waits and
/// reads the winner's result from `mem`). Honors `diskcache::cache_disabled()`.
///
/// Lock discipline (no deadlock): the `inflight` registry lock is released before
/// taking the per-key `flight` lock; `mem` is locked only briefly for get/insert,
/// never across `render()` or `flight.lock()`. If `render` panics its inflight
/// entry leaks (bounded by distinct keys) — acceptable.
pub(crate) fn cached_single_flight<T>(
    mem: &Mutex<LruCache<String, T>>,
    inflight: &Mutex<HashMap<String, Arc<Mutex<()>>>>,
    cache_dir: &Path,
    key: &str,
    disk_max_bytes: u64,
    disk_ttl: Duration,
    render: impl FnOnce() -> anyhow::Result<T>,
) -> anyhow::Result<T>
where
    T: Clone + Serialize + DeserializeOwned,
{
    cached_single_flight_with(
        mem,
        inflight,
        key,
        |k| crate::diskcache::get(cache_dir, k, disk_ttl),
        |k, blob| crate::diskcache::put(cache_dir, k, blob, disk_max_bytes, disk_ttl),
        render,
    )
}

pub(crate) fn cached_single_flight_persistent<T>(
    mem: &Mutex<LruCache<String, T>>,
    inflight: &Mutex<HashMap<String, Arc<Mutex<()>>>>,
    dir: &Path,
    key: &str,
    render: impl FnOnce() -> anyhow::Result<T>,
) -> anyhow::Result<T>
where
    T: Clone + Serialize + DeserializeOwned,
{
    cached_single_flight_with(
        mem,
        inflight,
        key,
        |k| crate::diskcache::get_persistent(dir, k),
        |k, blob| crate::diskcache::put_persistent(dir, k, blob),
        render,
    )
}

/// Shared in-memory + single-flight engine, parameterized over the disk tier
/// (read/write closures). See lock discipline below: the `inflight` registry lock
/// is released before taking the per-key `flight` lock; `mem` is locked only
/// briefly, never across `render()` or `flight.lock()`. On `render` panic the
/// inflight entry leaks (bounded by distinct keys) — acceptable.
fn cached_single_flight_with<T>(
    mem: &Mutex<LruCache<String, T>>,
    inflight: &Mutex<HashMap<String, Arc<Mutex<()>>>>,
    key: &str,
    disk_get: impl Fn(&str) -> Option<Vec<u8>>,
    disk_put: impl Fn(&str, &[u8]),
    render: impl FnOnce() -> anyhow::Result<T>,
) -> anyhow::Result<T>
where
    T: Clone + Serialize + DeserializeOwned,
{
    if !crate::diskcache::cache_disabled() {
        if let Some(v) = mem.lock().unwrap().get(key) {
            return Ok(v.clone());
        }
    }
    if !crate::diskcache::cache_disabled() {
        if let Some(blob) = disk_get(key) {
            if let Ok(v) = serde_json::from_slice::<T>(&blob) {
                mem.lock().unwrap().put(key.to_owned(), v.clone());
                return Ok(v);
            }
        }
    }
    if crate::diskcache::cache_disabled() {
        return render();
    }
    let flight = {
        let mut reg = inflight.lock().unwrap();
        reg.entry(key.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    let _flight = flight.lock().unwrap();
    if let Some(v) = mem.lock().unwrap().get(key) {
        return Ok(v.clone());
    }
    let drop_inflight = || {
        let mut reg = inflight.lock().unwrap();
        if let Some(existing) = reg.get(key) {
            if Arc::ptr_eq(existing, &flight) {
                reg.remove(key);
            }
        }
    };
    let v = match render() {
        Ok(v) => v,
        Err(e) => {
            drop_inflight();
            return Err(e);
        }
    };
    if let Ok(blob) = serde_json::to_vec(&v) {
        disk_put(key, &blob);
    }
    mem.lock().unwrap().put(key.to_owned(), v.clone());
    drop_inflight();
    Ok(v)
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
    use std::num::NonZeroUsize;

    #[test]
    fn cached_single_flight_memoizes_and_separates_keys() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let dir = std::env::temp_dir().join(format!("cuprum-csflight-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // Local, isolated registries so this test is order-independent.
        let mem: Mutex<LruCache<String, u32>> =
            Mutex::new(LruCache::new(NonZeroUsize::new(8).unwrap()));
        let inflight: Mutex<HashMap<String, Arc<Mutex<()>>>> = Mutex::new(HashMap::new());
        let calls = AtomicUsize::new(0);
        let run = |key: &str, val: u32| {
            cached_single_flight(
                &mem,
                &inflight,
                &dir,
                key,
                1024 * 1024,
                Duration::from_secs(60),
                || {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(val)
                },
            )
            .expect("ok")
        };
        // (a) Same key twice → render runs once, value cached.
        assert_eq!(run("k1", 42), 42);
        assert_eq!(
            run("k1", 99),
            42,
            "second call serves cached value, not re-render"
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "render ran exactly once for k1"
        );
        // (b) Distinct key → render runs again.
        assert_eq!(run("k2", 7), 7);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "distinct key triggers a separate render"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

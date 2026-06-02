//! In-process render cache, keyed by file path + modification time.
//!
//! Rasterizing a Gerber is the expensive step, and the same file is rendered
//! repeatedly: the preview on every (re)load, and the native mask on every
//! Expose. The Tauri Rust process outlives webview reloads, so caching here
//! makes reloads and repeat-exposes instant. Entries auto-invalidate when the
//! file's mtime changes (you edited/re-exported the Gerber).

use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use anyhow::Result;
use lru::LruCache;
use serde::de::DeserializeOwned;
use serde::Serialize;

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

/// SVG cache key tag — single source of truth in `crate::artifact`.
const SVG_CACHE_TAG: &[u8] = crate::artifact::SVG_VERSION;

/// Disk cache budget/TTL for SVG entries. Centralized here now that SVG disk
/// caching lives in core.
const SVG_DISK_MAX_BYTES: u64 = 256 * 1024 * 1024; // 256 MB
const SVG_DISK_TTL: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 60 * 60);

const SVG_MEM_CAP: usize = 256;
fn svg_cache() -> &'static Mutex<LruCache<String, LayerGeometry>> {
    static C: OnceLock<Mutex<LruCache<String, LayerGeometry>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(LruCache::new(NonZeroUsize::new(SVG_MEM_CAP).unwrap())))
}

/// Per-key locks to de-duplicate concurrent cache misses (single-flight): two
/// threads missing the same key render once; the loser waits and reads the
/// winner's result from the in-memory cache. Distinct keys never serialize.
fn svg_inflight() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static C: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Render a gerber layer to SVG, going through the in-memory and disk caches.
/// Order: in-memory → disk → render. On a render, both caches are populated.
/// Keyed by `hash(SVG_CACHE_TAG + bytes)` so a layer is never recomputed while
/// its gerber bytes are unchanged. Honors `diskcache::cache_disabled()`.
///
/// `cache_dir` is the disk-cache directory. The SVG element id (scopes the
/// clear-polarity mask) is derived internally from the content hash.
pub fn layer_svg_cached(cache_dir: &Path, bytes: &[u8]) -> anyhow::Result<LayerGeometry> {
    let key = crate::diskcache::key_for(&[SVG_CACHE_TAG, bytes]);
    // SVG element id derived from the content hash — unique per gerber content,
    // scopes the clear-polarity mask. Derived here so the tag lives in one place.
    let id = format!("ly{}", &key[..8]);
    cached_single_flight(
        svg_cache(),
        svg_inflight(),
        cache_dir,
        &key,
        SVG_DISK_MAX_BYTES,
        SVG_DISK_TTL,
        || svg::render_layer_svg(bytes, &id),
    )
}

/// The content-hash key for a gerber's SVG artifact. Shared by the cache and by
/// `artifact::gc` so the valid-key set matches what's written.
pub fn svg_artifact_key(bytes: &[u8]) -> String {
    crate::diskcache::key_for(&[SVG_CACHE_TAG, bytes])
}

/// Project-scoped, PERSISTENT SVG render (no TTL/eviction): in-memory → persistent
/// disk → single-flight → render. Same key/output as `layer_svg_cached`; only the
/// disk tier differs (these blobs live in `<workdir>/artifacts/svg` and ship in the
/// `.cuprum`, reclaimed by `artifact::gc`).
pub fn layer_svg_artifact(artifacts_svg_dir: &Path, bytes: &[u8]) -> anyhow::Result<LayerGeometry> {
    let key = svg_artifact_key(bytes);
    let id = format!("ly{}", &key[..8]);
    cached_single_flight_persistent(svg_cache(), svg_inflight(), artifacts_svg_dir, &key, || {
        svg::render_layer_svg(bytes, &id)
    })
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
fn cached_single_flight<T>(
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

fn cached_single_flight_persistent<T>(
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

/// Metrics cache: in-memory LRU bound (metrics JSON blobs are larger than SVG —
/// silk/trace hotspots can be many — so a tighter cap) + content-keyed disk.
const METRICS_MEM_CAP: usize = 128;
const METRICS_DISK_MAX_BYTES: u64 = 256 * 1024 * 1024; // 256 MB
const METRICS_DISK_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);

fn metrics_cache() -> &'static Mutex<LruCache<String, crate::metrics::BoardMetrics>> {
    static C: OnceLock<Mutex<LruCache<String, crate::metrics::BoardMetrics>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(LruCache::new(NonZeroUsize::new(METRICS_MEM_CAP).unwrap())))
}
fn metrics_inflight() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static C: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Cached `board_metrics` with single-flight: in-memory LRU + disk, de-duping
/// concurrent cold misses of the same board (designs page renders many cards).
/// `key` is the caller-built content key (it owns the metrics version tag +
/// layer hashing). `render` computes the metrics (infallible) on a miss.
pub fn board_metrics_cached(
    cache_dir: &Path,
    key: &str,
    render: impl FnOnce() -> crate::metrics::BoardMetrics,
) -> crate::metrics::BoardMetrics {
    cached_single_flight(
        metrics_cache(),
        metrics_inflight(),
        cache_dir,
        key,
        METRICS_DISK_MAX_BYTES,
        METRICS_DISK_TTL,
        || Ok(render()),
    )
    .expect("board_metrics render is infallible")
}

/// Build the metrics artifact key from loaded layers. Mirrors the historical
/// `main.rs` construction (now centralized): version tag + per-layer
/// `{type-debug}` + lowercase rel (plating inferred from the name) + bytes.
/// Shared by the command and `artifact::gc`. `layers` is `(rel, type_debug, bytes)`.
pub fn metrics_artifact_key(layers: &[(String, String, Vec<u8>)]) -> String {
    let mut h = crate::diskcache::Hasher::new();
    h.add(crate::artifact::METRICS_VERSION);
    for (rel, type_debug, bytes) in layers {
        h.add(type_debug.as_bytes());
        h.add(rel.to_lowercase().as_bytes());
        h.add(bytes);
    }
    h.finish()
}

/// Project-scoped, PERSISTENT metrics (no TTL/eviction). `key` is built via
/// `metrics_artifact_key`. `render` computes the metrics (infallible) on a miss.
pub fn board_metrics_artifact(
    artifacts_metrics_dir: &Path,
    key: &str,
    render: impl FnOnce() -> crate::metrics::BoardMetrics,
) -> crate::metrics::BoardMetrics {
    cached_single_flight_persistent(
        metrics_cache(),
        metrics_inflight(),
        artifacts_metrics_dir,
        key,
        || Ok(render()),
    )
    .expect("board_metrics render is infallible")
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
        let a = layer_svg_cached(&dir, GBR).expect("render ok");
        // Wipe the disk cache: a second hit now can only come from the in-memory layer.
        let _ = std::fs::remove_dir_all(&dir);
        let b = layer_svg_cached(&dir, GBR).expect("memory hit ok");
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
        let a = layer_svg_cached(&dir, GBR).expect("ok");
        let b = layer_svg_cached(&dir, other).expect("ok");
        // Different aperture diameter → different geometry: distinct bytes are not
        // conflated into one cache entry.
        assert_ne!(a.bbox, b.bbox, "distinct gerbers yield distinct geometry");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn single_flight_renders_once_under_concurrency() {
        use crate::svg::BBox;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        let dir = std::env::temp_dir().join(format!("cuprum-svcflight-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let key = "svgflightkey";
        // The global caches outlive other tests; clear this key so the start is a
        // guaranteed miss regardless of test order.
        svg_cache().lock().unwrap().pop(key);
        svg_inflight().lock().unwrap().remove(key);
        let renders = Arc::new(AtomicUsize::new(0));
        let geom = LayerGeometry {
            svg_body: "<g></g>".to_string(),
            bbox: BBox {
                min_x: 0.0,
                min_y: 0.0,
                max_x: 1.0,
                max_y: 1.0,
            },
            snap: vec![],
        };
        let mut handles = vec![];
        for _ in 0..8 {
            let dir = dir.clone();
            let renders = Arc::clone(&renders);
            let geom = geom.clone();
            handles.push(std::thread::spawn(move || {
                cached_single_flight(
                    svg_cache(),
                    svg_inflight(),
                    &dir,
                    key,
                    SVG_DISK_MAX_BYTES,
                    SVG_DISK_TTL,
                    || {
                        renders.fetch_add(1, Ordering::SeqCst);
                        // simulate work so threads actually overlap on the per-key lock
                        std::thread::sleep(std::time::Duration::from_millis(20));
                        Ok(geom)
                    },
                )
                .expect("ok")
            }));
        }
        for h in handles {
            let g = h.join().expect("thread ok");
            assert_eq!(
                g.svg_body, "<g></g>",
                "all callers get the rendered geometry"
            );
        }
        assert_eq!(
            renders.load(Ordering::SeqCst),
            1,
            "render happens exactly once under single-flight"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn layer_svg_artifact_persists_and_keys_match() {
        // Use a fixture distinct from GBR so this test does not race with other
        // tests that also render GBR and share the same svg_cache() globals.
        const GBR2: &[u8] = b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,3.0*%\nD10*\nX0Y0D03*\nM02*\n";
        let dir = std::env::temp_dir().join(format!("cuprum-svgart-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let key = svg_artifact_key(GBR2);
        svg_cache().lock().unwrap().pop(&key);
        // Render → blob lands at <dir>/<svg_artifact_key>.bin (persistent).
        let g = layer_svg_artifact(&dir, GBR2).expect("render ok");
        let blob_path = dir.join(format!("{key}.bin"));
        assert!(
            blob_path.exists(),
            "persistent svg blob written at the keyed path"
        );
        // Wipe in-memory cache for this key so the next read can only come from disk.
        svg_cache().lock().unwrap().pop(&key);
        let g2 = layer_svg_artifact(&dir, GBR2).expect("disk hit ok");
        assert_eq!(g.svg_body, g2.svg_body, "disk-persisted svg identical");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn metrics_artifact_key_is_version_and_content_sensitive() {
        // (rel, layer_type_debug, bytes) tuples — mirrors how main.rs builds the key.
        let a = metrics_artifact_key(&[("top.gbr".into(), "TopCopper".into(), b"AAAA".to_vec())]);
        let b = metrics_artifact_key(&[("top.gbr".into(), "TopCopper".into(), b"BBBB".to_vec())]);
        let c = metrics_artifact_key(&[("top.gbr".into(), "TopCopper".into(), b"AAAA".to_vec())]);
        assert_ne!(a, b, "different bytes → different key");
        assert_eq!(a, c, "same inputs → same key (deterministic)");
    }

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

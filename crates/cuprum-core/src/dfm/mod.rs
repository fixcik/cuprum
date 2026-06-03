//! Design-for-Manufacturing (DFM): measure board facts and locate problem
//! spots, then turn them into a manufacturability verdict. All DFM-only code
//! lives here. Shared polygon-building stays in `crate::geometry`.

mod conductor;
mod metrics;
mod sweep;

/// Max located hotspots reported per problem family (worst-first; excess dropped
/// after a ~1 mm-cell dedup). High enough to show every real violation on a dense
/// board — so the stepper count is truthful — while staying a backstop against a
/// pathological board flooding `BoardMetrics`. Shared by the sweep dedup and the
/// per-family caps so all families behave consistently.
pub(crate) const HOT_N: usize = 500;

pub use metrics::{board_metrics, BoardMetrics, Hotspot, MetricLayerInput};
pub use sweep::{
    clearance_hotspots, clearance_width_hotspots, min_clearance_and_width, min_island_clearance,
    width_hotspots, Hot,
};

// ---- Board-metrics cache wrappers ----
//
// Cached entry points around `board_metrics`, sharing the single-flight engine in
// `crate::cache`. Live here (next to `BoardMetrics`) so the cache module doesn't
// reach into dfm to define them — it only re-exports these under `cache::` for the
// historical call paths (project/UI). Metrics JSON blobs are larger than SVG —
// silk/trace hotspots can be many — so a tighter in-memory cap.

use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use lru::LruCache;

use cuprum_cache::{cached_single_flight, cached_single_flight_persistent};

const METRICS_MEM_CAP: usize = 128;
const METRICS_DISK_MAX_BYTES: u64 = 256 * 1024 * 1024; // 256 MB
const METRICS_DISK_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);

fn metrics_cache() -> &'static Mutex<LruCache<String, BoardMetrics>> {
    static C: OnceLock<Mutex<LruCache<String, BoardMetrics>>> = OnceLock::new();
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
    render: impl FnOnce() -> BoardMetrics,
) -> BoardMetrics {
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
/// Takes borrowed byte slices to avoid cloning multi-MB gerber buffers on the hot path.
pub fn metrics_artifact_key<'a>(
    layers: impl IntoIterator<Item = (&'a str, &'a str, &'a [u8])>,
) -> String {
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
    render: impl FnOnce() -> BoardMetrics,
) -> BoardMetrics {
    cached_single_flight_persistent(
        metrics_cache(),
        metrics_inflight(),
        artifacts_metrics_dir,
        key,
        || Ok(render()),
    )
    .expect("board_metrics render is infallible")
}

#[cfg(test)]
mod metrics_cache_tests {
    use super::*;

    #[test]
    fn metrics_artifact_key_is_version_and_content_sensitive() {
        // (rel, layer_type_debug, bytes) tuples — mirrors how main.rs builds the key.
        let mk = |bytes: &'static [u8]| metrics_artifact_key([("top.gbr", "TopCopper", bytes)]);
        let a = mk(b"AAAA");
        let b = mk(b"BBBB");
        let c = mk(b"AAAA");
        assert_ne!(a, b, "different bytes → different key");
        assert_eq!(a, c, "same inputs → same key (deterministic)");
    }
}

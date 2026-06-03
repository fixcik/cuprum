//! Content-addressed on-disk cache for expensive derived artifacts (rendered
//! SVG, triangulated 3D meshes).
//!
//! The key is a hash of the SOURCE bytes (plus a small param/version tag), so an
//! entry stays valid as long as the input is byte-identical — re-importing the
//! same gerbers, reopening a project, or toggling layer types back and forth all
//! hit the cache. Two bounds keep it tidy: a sliding TTL (entries unused for
//! longer than `ttl` are dropped — `get` bumps mtime on a hit, so it's "since
//! last use") and a total-size budget (over budget → evict least-recently-used
//! first). Both are passed in by the caller (see the config block in `main.rs`).
//!
//! Split into [`hash`] (content-key building) and [`store`] (the disk tiers);
//! both are re-exported here so callers use the flat `diskcache::…` path.

mod hash;
mod store;

pub use hash::{key_for, Hasher};
pub use store::{get, get_persistent, put, put_persistent};

use std::sync::OnceLock;

/// Parse a `CUPRUM_NO_CACHE` value. Pure and testable.
pub(crate) fn parse_no_cache(value: Option<&str>) -> bool {
    matches!(value.map(str::trim), Some("1") | Some("on") | Some("true"))
}

/// True if caching is globally disabled this run (read once from `CUPRUM_NO_CACHE`).
/// Forces a cold path for profiling — both the disk cache here and the in-memory
/// caches in `cache.rs` honor it. Results are unchanged (recompute vs. serve).
pub fn cache_disabled() -> bool {
    static OFF: OnceLock<bool> = OnceLock::new();
    *OFF.get_or_init(|| parse_no_cache(std::env::var("CUPRUM_NO_CACHE").ok().as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_no_cache_maps_values() {
        assert!(!parse_no_cache(None));
        assert!(!parse_no_cache(Some("")));
        assert!(!parse_no_cache(Some("0")));
        assert!(!parse_no_cache(Some("off")));
        assert!(parse_no_cache(Some("1")));
        assert!(parse_no_cache(Some("on")));
        assert!(parse_no_cache(Some("true")));
        assert!(parse_no_cache(Some("  1  ")));
    }
}

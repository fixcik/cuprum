//! Shared single-flight cache engine: in-memory LRU + disk tier + per-key
//! single-flight de-dup of concurrent misses.
//!
//! Typed wrappers live with their domains (SVG renders, board metrics, gerber
//! parse) and call into [`cached_single_flight`]/[`cached_single_flight_persistent`]
//! here, parameterized over the disk tier (transient TTL/GC vs. persistent).

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cuprum_diskcache::diskcache;
use lru::LruCache;
use serde::de::DeserializeOwned;
use serde::Serialize;

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
pub fn cached_single_flight<T>(
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
        |k| diskcache::get(cache_dir, k, disk_ttl),
        |k, blob| diskcache::put(cache_dir, k, blob, disk_max_bytes, disk_ttl),
        render,
    )
}

pub fn cached_single_flight_persistent<T>(
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
        |k| diskcache::get_persistent(dir, k),
        |k, blob| diskcache::put_persistent(dir, k, blob),
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
    if !diskcache::cache_disabled() {
        if let Some(v) = mem.lock().unwrap().get(key) {
            return Ok(v.clone());
        }
    }
    if !diskcache::cache_disabled() {
        if let Some(blob) = disk_get(key) {
            if let Ok(v) = serde_json::from_slice::<T>(&blob) {
                mem.lock().unwrap().put(key.to_owned(), v.clone());
                return Ok(v);
            }
        }
    }
    if diskcache::cache_disabled() {
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

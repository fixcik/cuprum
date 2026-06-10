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

/// Lock a cache mutex, recovering from poisoning instead of propagating it. The
/// `mem`/`inflight`/per-key `flight` mutexes guard a derived cache, not an
/// invariant: if a thread panics mid-render while holding one, the data is
/// stale-but-valid, so a later locker takes the inner guard rather than
/// poison-panicking and bricking the cache for the whole process.
fn lock_recover<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Disk-blob format marker: blobs are `MAGIC ++ bincode(value)`. Binary encode/
/// decode is 2-10x cheaper than the JSON this engine used before (metrics carry
/// thousands of hotspots; SVG bodies paid per-character escaping). A blob
/// without the magic (e.g. a pre-binary JSON blob, including persistent
/// artifacts inside existing .cuprum files) or one that fails to decode is a
/// cache MISS: the value is recomputed and rewritten in the new format, so the
/// encoding migrates itself in both directions and the artifact version tags
/// stay untouched (the cached CONTENT is unchanged).
const BLOB_MAGIC: &[u8; 4] = b"CBC1";

/// Hard cap a decoded value's size: a corrupted/adversarial length field then
/// fails cleanly instead of attempting a giant allocation, regardless of the
/// reader backend. Generous — the largest disk tier (metrics) is capped at
/// 256 MB total.
const BLOB_SIZE_LIMIT: u64 = 256 * 1024 * 1024;

/// One options value for BOTH encode and decode — bincode settings (int
/// encoding, limits) must match between the two or blobs silently fail to
/// round-trip.
fn blob_options() -> impl bincode::Options {
    use bincode::Options;
    bincode::options().with_limit(BLOB_SIZE_LIMIT)
}

fn encode_blob<T: Serialize>(v: &T) -> Option<Vec<u8>> {
    use bincode::Options;
    let mut blob = Vec::from(*BLOB_MAGIC);
    blob_options().serialize_into(&mut blob, v).ok()?;
    Some(blob)
}

fn decode_blob<T: DeserializeOwned>(blob: &[u8]) -> Option<T> {
    use bincode::Options;
    let body = blob.strip_prefix(BLOB_MAGIC)?;
    blob_options().deserialize(body).ok()
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
        if let Some(v) = lock_recover(mem).get(key) {
            return Ok(v.clone());
        }
    }
    if !diskcache::cache_disabled() {
        if let Some(blob) = disk_get(key) {
            if let Some(v) = decode_blob::<T>(&blob) {
                lock_recover(mem).put(key.to_owned(), v.clone());
                return Ok(v);
            }
        }
    }
    if diskcache::cache_disabled() {
        return render();
    }
    let flight = {
        let mut reg = lock_recover(inflight);
        reg.entry(key.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    let _flight = lock_recover(&flight);
    if let Some(v) = lock_recover(mem).get(key) {
        return Ok(v.clone());
    }
    let drop_inflight = || {
        let mut reg = lock_recover(inflight);
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
    if let Some(blob) = encode_blob(&v) {
        disk_put(key, &blob);
    }
    lock_recover(mem).put(key.to_owned(), v.clone());
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

    use serde::{Deserialize, Serialize};
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    struct Payload {
        name: String,
        points: Vec<[f64; 2]>,
    }

    fn sample() -> Payload {
        Payload {
            name: "metrics".into(),
            points: vec![[0.0, 1.5], [2.25, -3.75]],
        }
    }

    const TTL: Duration = Duration::from_secs(60);
    const MAX: u64 = 1024 * 1024;

    fn fresh_mem() -> Mutex<LruCache<String, Payload>> {
        Mutex::new(LruCache::new(NonZeroUsize::new(8).unwrap()))
    }

    fn run_engine(
        mem: &Mutex<LruCache<String, Payload>>,
        dir: &Path,
        key: &str,
        calls: &AtomicUsize,
        val: Payload,
    ) -> Payload {
        let inflight: Mutex<HashMap<String, Arc<Mutex<()>>>> = Mutex::new(HashMap::new());
        cached_single_flight(mem, &inflight, dir, key, MAX, TTL, || {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(val)
        })
        .expect("ok")
    }

    #[test]
    fn disk_blob_roundtrips_in_binary_format() {
        let dir = std::env::temp_dir().join(format!("cuprum-bblob-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let calls = AtomicUsize::new(0);
        let v = run_engine(&fresh_mem(), &dir, "k", &calls, sample());
        assert_eq!(v, sample());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // On-disk blob carries the magic prefix (binary format, not JSON).
        let raw = diskcache::get(&dir, "k", TTL).expect("blob written");
        assert!(raw.starts_with(BLOB_MAGIC), "blob is magic-prefixed binary");
        // A fresh in-memory cache forces the DISK path: value served, no render.
        let v2 = run_engine(&fresh_mem(), &dir, "k", &calls, sample());
        assert_eq!(v2, sample());
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "disk hit — render not re-run"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_json_blob_is_a_miss_and_gets_rewritten() {
        let dir = std::env::temp_dir().join(format!("cuprum-bjson-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // A pre-binary build left a JSON blob under this key.
        let legacy = serde_json::to_vec(&sample()).unwrap();
        diskcache::put(&dir, "k", &legacy, MAX, TTL);
        let calls = AtomicUsize::new(0);
        let rendered = Payload {
            name: "fresh".into(),
            points: vec![[9.0, 9.0]],
        };
        let v = run_engine(&fresh_mem(), &dir, "k", &calls, rendered.clone());
        assert_eq!(v, rendered, "JSON blob rejected → value re-rendered");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // The blob is rewritten in the new format and decodes to the new value.
        let raw = diskcache::get(&dir, "k", TTL).expect("blob present");
        assert!(raw.starts_with(BLOB_MAGIC), "blob migrated to binary");
        assert_eq!(decode_blob::<Payload>(&raw), Some(rendered));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupted_blob_is_a_miss() {
        let dir = std::env::temp_dir().join(format!("cuprum-bcorr-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut garbage = BLOB_MAGIC.to_vec();
        garbage.extend_from_slice(b"\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff");
        diskcache::put(&dir, "k", &garbage, MAX, TTL);
        let calls = AtomicUsize::new(0);
        let v = run_engine(&fresh_mem(), &dir, "k", &calls, sample());
        assert_eq!(v, sample());
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "garbage decode → render ran"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

//! The on-disk cache tiers: a TTL + size-budget tier (`get`/`put`) and a
//! persistent, never-evicted tier (`get_persistent`/`put_persistent`).

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use super::cache_disabled;

fn entry_path(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{key}.bin"))
}

/// Read a cached blob; `None` on miss or if the entry is older than `ttl`
/// (expired entries are deleted). Bumps the entry's mtime on a hit, so the TTL
/// is "time since last use" and eviction is least-recently-USED.
#[tracing::instrument(skip_all, fields(hit = tracing::field::Empty))]
pub fn get(dir: &Path, key: &str, ttl: Duration) -> Option<Vec<u8>> {
    if cache_disabled() {
        return None;
    }
    let result = get_inner(dir, key, ttl);
    tracing::Span::current().record("hit", result.is_some());
    result
}

fn get_inner(dir: &Path, key: &str, ttl: Duration) -> Option<Vec<u8>> {
    let p = entry_path(dir, key);
    let meta = std::fs::metadata(&p).ok()?;
    if expired(&meta, ttl) {
        let _ = std::fs::remove_file(&p);
        return None;
    }
    let bytes = std::fs::read(&p).ok()?;
    if let Ok(f) = std::fs::OpenOptions::new().write(true).open(&p) {
        let _ = f.set_modified(SystemTime::now()); // best-effort LRU touch
    }
    Some(bytes)
}

/// Store a blob, then prune (expired + over-budget). Best-effort: any IO error
/// is swallowed (a cache failure must never break the command).
#[tracing::instrument(skip_all, fields(bytes = bytes.len()))]
pub fn put(dir: &Path, key: &str, bytes: &[u8], max_bytes: u64, ttl: Duration) {
    if cache_disabled() {
        return;
    }
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let tmp = dir.join(format!("{key}.tmp"));
    if std::fs::write(&tmp, bytes).is_err() {
        return;
    }
    let _ = std::fs::rename(&tmp, entry_path(dir, key));
    {
        let _s = tracing::info_span!("prune").entered();
        prune(dir, max_bytes, ttl);
    }
}

/// Persistent variants for PROJECT artifacts: no TTL (never age out) and no size
/// budget (never evicted). Used for the `<workdir>/artifacts/**` cache that ships
/// inside the `.cuprum` — those entries are reclaimed by `artifact::gc`, not here.
/// Still honors `cache_disabled()` so cold profiling works.
pub fn get_persistent(dir: &Path, key: &str) -> Option<Vec<u8>> {
    get(dir, key, Duration::MAX)
}

/// Store a persistent blob (no prune). Best-effort: IO errors are swallowed.
#[tracing::instrument(skip_all, fields(bytes = bytes.len()))]
pub fn put_persistent(dir: &Path, key: &str, bytes: &[u8]) {
    if cache_disabled() {
        return;
    }
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let tmp = dir.join(format!("{key}.tmp"));
    if std::fs::write(&tmp, bytes).is_err() {
        return;
    }
    let _ = std::fs::rename(&tmp, entry_path(dir, key));
}

fn expired(meta: &std::fs::Metadata, ttl: Duration) -> bool {
    let mt = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    SystemTime::now()
        .duration_since(mt)
        .map(|age| age > ttl)
        .unwrap_or(false)
}

/// Drop expired `.bin` entries, then evict least-recently-used ones until the
/// total is within `max_bytes`.
fn prune(dir: &Path, max_bytes: u64, ttl: Duration) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
    let mut total: u64 = 0;
    for e in rd.flatten() {
        let Ok(meta) = e.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let path = e.path();
        if path.extension().and_then(|s| s.to_str()) != Some("bin") {
            continue;
        }
        if expired(&meta, ttl) {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        let sz = meta.len();
        let mt = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        total += sz;
        entries.push((path, sz, mt));
    }
    if total <= max_bytes {
        return;
    }
    entries.sort_by_key(|(_, _, mt)| *mt); // oldest (LRU) first
    let mut over = total - max_bytes;
    for (p, sz, _) in entries {
        if over == 0 {
            break;
        }
        if std::fs::remove_file(&p).is_ok() {
            over = over.saturating_sub(sz);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Read the single JSON trace file written under `dir` as a string.
    fn read_trace_body(dir: &Path) -> String {
        let files: Vec<_> = std::fs::read_dir(dir)
            .expect("trace dir exists")
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
            .collect();
        assert_eq!(files.len(), 1, "exactly one trace file written");
        std::fs::read_to_string(&files[0]).unwrap()
    }

    // Exercise the diskcache spans through the trace module's real RoutingLayer
    // path (the same global subscriber the app installs). This avoids a competing
    // `set_global_default`, and `set_global_default` rebuilds the callsite interest
    // cache so previously no-subscriber-hit callsites are re-evaluated.
    #[test]
    fn put_and_put_persistent_emit_spans_via_trace() {
        let dir = std::env::temp_dir().join(format!("cuprum-dc-span-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let cache = dir.join("c");

        cuprum_trace::run_with_config(
            &cuprum_trace::TraceConfig::Dir(dir.clone()),
            "dc",
            &dir,
            || {
                put_persistent(&cache, "k", b"x");
                put(&cache, "k2", b"y", 1_000_000, Duration::from_secs(60));
            },
        );

        let body = read_trace_body(&dir);
        serde_json::from_str::<serde_json::Value>(&body).expect("trace is valid JSON");
        assert!(
            body.contains("put_persistent"),
            "expected put_persistent span in trace, got: {body}"
        );
        assert!(
            body.contains("prune"),
            "expected prune span in trace, got: {body}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn put_get_roundtrip_and_budget_evicts_lru() {
        let day = Duration::from_secs(86_400);
        let dir =
            std::env::temp_dir().join(format!("cuprum-diskcache-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        // Two 100-byte entries; budget 150 → second put must evict the first.
        put(&dir, "aaa", &[1u8; 100], 1_000, day);
        assert_eq!(get(&dir, "aaa", day).as_deref(), Some(&[1u8; 100][..]));

        // Pin "aaa" to an unambiguously older mtime so the LRU victim is
        // deterministic regardless of filesystem timestamp granularity — on a
        // fast runner the get() touch above and the put() below can otherwise
        // land in the same tick and tie.
        std::fs::OpenOptions::new()
            .write(true)
            .open(entry_path(&dir, "aaa"))
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(60))
            .unwrap();

        put(&dir, "bbb", &[2u8; 100], 150, day);
        // "aaa" was older (and not touched after) → evicted; "bbb" stays.
        assert!(
            get(&dir, "aaa", day).is_none(),
            "oldest entry should be evicted"
        );
        assert_eq!(get(&dir, "bbb", day).as_deref(), Some(&[2u8; 100][..]));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn expired_entry_is_dropped() {
        let dir = std::env::temp_dir().join(format!("cuprum-diskcache-ttl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        put(&dir, "old", &[7u8; 10], 1_000, Duration::from_secs(86_400));
        // TTL of zero → already expired on read.
        assert!(
            get(&dir, "old", Duration::ZERO).is_none(),
            "zero-TTL entry must expire"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn persistent_survives_age_and_budget() {
        let dir =
            std::env::temp_dir().join(format!("cuprum-diskcache-persist-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        // Write a persistent entry, then backdate its mtime far past any TTL.
        put_persistent(&dir, "keep", &[9u8; 100]);
        std::fs::OpenOptions::new()
            .write(true)
            .open(entry_path(&dir, "keep"))
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(10 * 365 * 24 * 60 * 60))
            .unwrap();

        // A second persistent write of a large blob must NOT evict "keep"
        // (persistent has no budget), and "keep" must NOT be expired by age.
        put_persistent(&dir, "big", &[1u8; 10_000]);
        assert_eq!(
            get_persistent(&dir, "keep").as_deref(),
            Some(&[9u8; 100][..]),
            "persistent entry survives age + a large later write"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

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

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use md5::{Digest, Md5};

/// Streaming key builder — hash large inputs (multi-MB gerbers) without cloning.
pub struct Hasher(Md5);

impl Default for Hasher {
    fn default() -> Self {
        Self::new()
    }
}

impl Hasher {
    pub fn new() -> Self {
        Hasher(Md5::new())
    }

    /// Feed a chunk. Length-prefixed so `add(a)+add(b)` can't collide with
    /// `add(a concat b)`.
    pub fn add(&mut self, chunk: &[u8]) {
        self.0.update((chunk.len() as u64).to_le_bytes());
        self.0.update(chunk);
    }

    /// Finalise to a 32-char hex key.
    pub fn finish(self) -> String {
        let d = self.0.finalize();
        let mut s = String::with_capacity(32);
        for b in d {
            s.push_str(&format!("{b:02x}"));
        }
        s
    }
}

/// Convenience: hash a fixed set of parts into a key.
pub fn key_for(parts: &[&[u8]]) -> String {
    let mut h = Hasher::new();
    for p in parts {
        h.add(p);
    }
    h.finish()
}

fn entry_path(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{key}.bin"))
}

/// Read a cached blob; `None` on miss or if the entry is older than `ttl`
/// (expired entries are deleted). Bumps the entry's mtime on a hit, so the TTL
/// is "time since last use" and eviction is least-recently-USED.
#[tracing::instrument(skip_all, fields(hit = tracing::field::Empty))]
pub fn get(dir: &Path, key: &str, ttl: Duration) -> Option<Vec<u8>> {
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
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let tmp = dir.join(format!("{key}.tmp"));
    if std::fs::write(&tmp, bytes).is_err() {
        return;
    }
    let _ = std::fs::rename(&tmp, entry_path(dir, key));
    prune(dir, max_bytes, ttl);
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
    fn key_is_order_and_boundary_sensitive() {
        assert_ne!(key_for(&[b"ab", b"c"]), key_for(&[b"a", b"bc"]));
        assert_eq!(key_for(&[b"x", b"y"]), key_for(&[b"x", b"y"]));
    }
}

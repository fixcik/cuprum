//! Content-hash key building for cache entries.

use xxhash_rust::xxh3::Xxh3;

/// Streaming key builder — hash large inputs (multi-MB gerbers) without cloning.
///
/// Backed by xxh3-128: a non-cryptographic hash, but these are content-cache
/// keys (artifact filenames), not a security boundary — 128 bits gives a
/// collision space large enough that an accidental clash is astronomically
/// unlikely at our scale, and it runs ~10× faster than the MD5 it replaced
/// (the dominant cost when hashing every gerber on each pack/flush). 128 bits
/// keeps the key 32 hex chars, identical in width to the old MD5 keys.
pub struct Hasher(Xxh3);

impl Default for Hasher {
    fn default() -> Self {
        Self::new()
    }
}

impl Hasher {
    pub fn new() -> Self {
        Hasher(Xxh3::new())
    }

    /// Feed a chunk. Length-prefixed so `add(a)+add(b)` can't collide with
    /// `add(a concat b)`.
    pub fn add(&mut self, chunk: &[u8]) {
        self.0.update(&(chunk.len() as u64).to_le_bytes());
        self.0.update(chunk);
    }

    /// Finalise to a 32-char hex key.
    pub fn finish(self) -> String {
        format!("{:032x}", self.0.digest128())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_is_order_and_boundary_sensitive() {
        assert_ne!(key_for(&[b"ab", b"c"]), key_for(&[b"a", b"bc"]));
        assert_eq!(key_for(&[b"x", b"y"]), key_for(&[b"x", b"y"]));
    }
}

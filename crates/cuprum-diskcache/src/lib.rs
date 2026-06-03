//! On-disk cache infrastructure for Cuprum's derived artifacts.
//!
//! - [`diskcache`] — the generic content-keyed disk cache (`hash(source + tag)`):
//!   TTL/size-bounded and persistent (no-eviction) tiers, plus the hashing helper.
//! - [`artifact`] — version tags for the persistent render artifacts that ship
//!   inside a `.cuprum`, and the GC that reclaims stale blobs.
//!
//! Kept as its own leaf crate (only `tracing` + `xxhash-rust` at runtime) so the
//! heavy render crates depend on a small, fast-building cache primitive.

pub mod artifact;
pub mod diskcache;

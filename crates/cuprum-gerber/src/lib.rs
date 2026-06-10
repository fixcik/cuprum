//! Gerber parsing, rendering and 2D polygon geometry for copper layers.
//!
//! This crate owns the read side of a fab package: parse a Gerber into the
//! forked parsing core ([`viewer`]) primitive stream ([`gerber`]), rasterize / SVG-render
//! a layer ([`gerber`], [`svg`]), turn primitives into clean filled polygons
//! ([`geometry`]), tessellate aperture strokes ([`strokes`]) and parse Excellon
//! drill files ([`drill`]).
//!
//! Layered below the heavier `cuprum-core` consumers (mesh, DFM, compose): it
//! depends only on the leaf crates `cuprum-cache` (single-flight render cache),
//! `cuprum-goo` (screen geometry) and `cuprum-diskcache` (content-keyed disk
//! cache + artifact versioning).

pub mod drill;
pub mod geometry;
pub mod gerber;
pub mod strokes;
pub mod svg;

mod viewer;

use std::sync::{Mutex, MutexGuard, PoisonError};

/// Lock a process-wide cache mutex, recovering from poisoning instead of
/// propagating it. These mutexes guard derived caches (parsed layers, rendered
/// SVG geometry, single-flight registries), not invariants: if a thread panics
/// mid-render while holding the lock, the cache holds stale-but-valid data, so a
/// later locker should take the inner guard rather than poison-panic and brick
/// the cache for the whole process.
pub(crate) fn lock_recover<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

// Re-export the parsing core (forked gerber-viewer) under cuprum-gerber so
// downstream crates use a single import path.
pub use viewer::{Exposure, GerberLayer, GerberPrimitive};
// External, untouched crates.io parser/types — re-exported for one import path.
pub use gerber_parser;
pub use gerber_types;

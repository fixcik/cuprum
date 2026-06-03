//! Gerber parsing, rendering and 2D polygon geometry for copper layers.
//!
//! This crate owns the read side of a fab package: parse a Gerber into the
//! vendored `gerber_viewer` primitive stream ([`gerber`]), rasterize / SVG-render
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

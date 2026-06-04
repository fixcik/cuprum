//! Gerber parsing core — forked and trimmed from MakerPnP `gerber-viewer`
//! (https://github.com/MakerPnP/gerber-viewer), licensed MIT OR Apache-2.0,
//! Copyright (c) Dominic Clifton. This fork keeps only the parsing core
//! (Gerber commands -> `GerberPrimitive` stream) and drops all egui rendering.
//! See crates/cuprum-gerber/LICENSE-APACHE and LICENSE-MIT.

mod expressions;
mod geometry;
mod layer;
mod spacial;
mod types;

#[cfg(test)]
mod testing;

pub use geometry::*;
pub use layer::*;
pub use types::Exposure;

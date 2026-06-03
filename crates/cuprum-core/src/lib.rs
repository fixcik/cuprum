//! Cuprum core: drive an Elegoo Saturn 4 Ultra 16K as a UV exposure unit for
//! PCB photolithography. Reusable across the CLI prototype and a future Tauri 2 UI.

pub mod cache;
pub mod cal;
pub mod compose;
pub mod dfm;
pub mod drill;
pub mod geometry;
pub mod gerber;
pub mod goo;
pub mod mesh;
pub mod preview;
pub mod sdcp;
pub mod strokes;
pub mod svg;

// Tracing now lives in its own leaf crate; re-export under the historical path so
// `cuprum_core::trace::…` (and in-crate `crate::trace::…`) keep resolving.
pub use cuprum_trace as trace;

// Disk-cache + artifact-versioning infra live in their own leaf crate; re-export
// under the historical paths so `cuprum_core::{diskcache,artifact}::…` (and in-crate
// `crate::{diskcache,artifact}::…`) keep resolving.
pub use cuprum_diskcache::{artifact, diskcache};

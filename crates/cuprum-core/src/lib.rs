//! Cuprum core: drive an Elegoo Saturn 4 Ultra 16K as a UV exposure unit for
//! PCB photolithography. Reusable across the CLI prototype and a future Tauri 2 UI.

pub mod cache;
pub mod cal;
pub mod compose;
pub mod preview;

// Tracing now lives in its own leaf crate; re-export under the historical path so
// `cuprum_core::trace::…` (and in-crate `crate::trace::…`) keep resolving.
pub use cuprum_trace as trace;

// Disk-cache + artifact-versioning infra live in their own leaf crate; re-export
// under the historical paths so `cuprum_core::{diskcache,artifact}::…` (and in-crate
// `crate::{diskcache,artifact}::…`) keep resolving.
pub use cuprum_diskcache::{artifact, diskcache};

// Printer protocol lives in its own leaf crate; re-export under the historical path
// so `cuprum_core::sdcp::…` keeps resolving for the CLI and the UI.
pub use cuprum_sdcp as sdcp;

// `.goo` exposure encoding + screen geometry live in their own leaf crate; re-export
// under the historical path so `cuprum_core::goo::…` (and in-crate `crate::goo::…`)
// keep resolving for the CLI, the UI, gerber and compose.
pub use cuprum_goo as goo;

// Gerber/Excellon parse, layer render and copper polygon geometry live in their own
// crate; re-export each module under the historical paths so `cuprum_core::{gerber,
// svg,geometry,strokes,drill}::…` (and in-crate `crate::…`) keep resolving for the
// CLI, the UI, and the in-core consumers (cache, mesh, dfm, compose, preview).
pub use cuprum_gerber::{drill, geometry, gerber, strokes, svg};

// Full 3D board mesh triangulation lives in its own crate; re-export under the
// historical path so `cuprum_core::mesh::…` (and in-crate `crate::mesh::…`) keep
// resolving for the UI and the in-core consumers (preview, dfm).
pub use cuprum_mesh as mesh;

// DFM metrics + hotspot sweep + verdict live in their own crate; re-export under
// the historical path so `cuprum_core::dfm::…` (and in-crate `crate::dfm::…`, e.g.
// the cache-wrapper facade) keep resolving for the CLI and the UI.
pub use cuprum_dfm as dfm;

// GRBL machine client lives in its own leaf crate; re-export under `cuprum_core::grbl`
// so the UI (Tauri machine commands) reaches it through the core facade, like sdcp.
pub use cuprum_grbl as grbl;

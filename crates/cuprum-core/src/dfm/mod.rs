//! Design-for-Manufacturing (DFM): measure board facts and locate problem
//! spots, then turn them into a manufacturability verdict. All DFM-only code
//! lives here. Shared polygon-building stays in `crate::geometry`.

mod conductor;
mod metrics;
mod sweep;

/// Max located hotspots reported per problem family (worst-first; excess dropped
/// after a ~1 mm-cell dedup). High enough to show every real violation on a dense
/// board — so the stepper count is truthful — while staying a backstop against a
/// pathological board flooding `BoardMetrics`. Shared by the sweep dedup and the
/// per-family caps so all families behave consistently.
pub(crate) const HOT_N: usize = 500;

pub use metrics::{board_metrics, BoardMetrics, Hotspot, MetricLayerInput};
pub use sweep::{
    clearance_hotspots, clearance_width_hotspots, min_clearance_and_width, min_island_clearance,
    width_hotspots, Hot,
};

//! Design-for-Manufacturing (DFM): measure board facts and locate problem
//! spots, then turn them into a manufacturability verdict. All DFM-only code
//! lives here. Shared polygon-building stays in `crate::geometry`.

mod conductor;
mod metrics;
mod sweep;

pub use metrics::{board_metrics, BoardMetrics, Hotspot, MetricLayerInput};
pub use sweep::{
    clearance_hotspots, clearance_width_hotspots, min_clearance_and_width, min_island_clearance,
    width_hotspots, Hot,
};

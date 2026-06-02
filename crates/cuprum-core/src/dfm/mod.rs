//! Design-for-Manufacturing (DFM): measure board facts and locate problem
//! spots, then turn them into a manufacturability verdict. All DFM-only code
//! lives here. Shared polygon-building stays in `crate::geometry`.

mod conductor;
mod metrics;

pub use metrics::{board_metrics, BoardMetrics, Hotspot, MetricLayerInput};

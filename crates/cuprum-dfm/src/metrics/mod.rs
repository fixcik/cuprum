//! Measured manufacturing facts about a board, extracted from its gerber/Excellon
//! layers — the input to a design-for-manufacturing (DFM) feasibility check.
//!
//! This module only MEASURES (board size, layer inventory, minimum trace width,
//! drill statistics). It makes no judgement about whether the board can be built;
//! that comparison against a machine "capability profile" lives in the frontend,
//! so editing thresholds re-evaluates instantly without recomputing geometry.
//!
//! Phase 1 deliberately computes only the CHEAP metrics (a single pass over the
//! already-parsed primitives, or [`cuprum_gerber::drill::parse_drill`]). The expensive
//! geometric checks — minimum copper-to-copper clearance, annular ring, copper
//! coverage, routed-slot detection — are Phase 2/3 and intentionally absent here.
//!
//! The core stays free of `cuprum-project`: callers describe each layer with the
//! geometry-level [`cuprum_mesh::Role`]/[`cuprum_mesh::Side`] plus two booleans
//! (`inner` copper, `plated` drill) and map their own `LayerType` onto those.

mod aggregate;
mod copper;
mod drill;
mod geo;
mod parse;
mod types;

#[cfg(test)]
pub(crate) use types::{BoardDims, CopperLayerMetric, DrillMetrics, GeoMetrics, LayerSummary};
pub use types::{BoardMetrics, Hotspot, MetricLayerInput};

use cuprum_mesh::Side;

/// The 2D face a layer's issues belong to. Inner copper maps to "top" (its
/// stacking side); it isn't shown separately in the 2D preview.
pub(super) fn layer_side(l: &MetricLayerInput) -> &'static str {
    match l.side {
        Side::Top => "top",
        Side::Bottom => "bottom",
        Side::Both => "both",
    }
}

/// Measure every cheap manufacturing fact for the given layers.
#[tracing::instrument(skip_all, fields(layers = layers.len()))]
pub fn board_metrics(layers: &[MetricLayerInput]) -> BoardMetrics {
    let parsed = parse::parse_all(layers);
    let drills = parse::parse_all_drills(layers);
    BoardMetrics {
        board: geo::board_dims(layers),
        layers: geo::layer_summary(layers),
        copper: copper::copper_metrics(layers, &parsed),
        drill: drill::drill_metrics(layers, &drills),
        geo: geo::geo_metrics(layers, &parsed, &drills),
    }
}

#[cfg(test)]
mod tests;

//! Layer parsing helpers: Gerber → `GerberLayer`, Excellon → drill data.

use std::sync::Arc;

use gerber_viewer::GerberLayer;
use rayon::prelude::*;

use crate::mesh::Role;

use super::types::MetricLayerInput;

/// All layers parsed once, indexed parallel to the `layers` slice (`None` where a
/// layer failed to parse — same skip semantics as before). Goes through the shared
/// cross-operation parse cache (`gerber::parse_layer_cached`) so a layer is parsed
/// once across metrics/mesh/SVG, not re-parsed per op. Parsed in parallel: wall ≈
/// the single largest layer, not the serial sum.
#[tracing::instrument(skip_all)]
pub(super) fn parse_all(layers: &[MetricLayerInput]) -> Vec<Option<Arc<GerberLayer>>> {
    let dh = crate::trace::capture_dispatch();
    layers
        .par_iter()
        .map(|l| dh.run(|| crate::gerber::parse_layer_cached(l.bytes).ok()))
        .collect()
}

/// Excellon data parsed once per drill layer (holes + slots), indexed parallel to
/// `layers` (`None` for non-drill layers).
pub(super) struct DrillData {
    pub(super) holes: Vec<crate::drill::Hole>,
    pub(super) slots: Vec<crate::drill::Slot>,
}

pub(super) fn parse_all_drills(layers: &[MetricLayerInput]) -> Vec<Option<DrillData>> {
    layers
        .iter()
        .map(|l| {
            (l.role == Role::Drill).then(|| DrillData {
                holes: crate::drill::parse_drill(l.bytes).unwrap_or_default(),
                slots: crate::drill::parse_slots(l.bytes),
            })
        })
        .collect()
}

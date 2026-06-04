//! Public data-model types for board manufacturing metrics.

use serde::{Deserialize, Serialize};

/// One layer handed to [`super::board_metrics`]: its geometric role/side, whether it is
/// an inner copper layer (`role == Copper`), whether its drills are plated
/// (`role == Drill`), and the raw gerber/Excellon bytes.
pub struct MetricLayerInput<'a> {
    pub role: cuprum_mesh::Role,
    pub side: cuprum_mesh::Side,
    /// Inner copper layer — disambiguates from top/bottom (Role/Side alone can't,
    /// since inner copper is mapped onto the top side for stacking).
    pub inner: bool,
    /// Plated drill file (PTH) vs non-plated (NPTH). Excellon can't carry this;
    /// the caller derives it from the filename.
    pub plated: bool,
    pub bytes: &'a [u8],
}

/// All measured facts for one board.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardMetrics {
    pub board: BoardDims,
    pub layers: LayerSummary,
    pub copper: Vec<CopperLayerMetric>,
    pub drill: DrillMetrics,
    pub geo: GeoMetrics,
}

/// A located DFM issue: the two closest mm points and the measured value (mm),
/// for drawing a dimension marker on the board preview. `side` ("top" | "bottom"
/// | "both") tells the frontend which 2D face the issue lives on, so a bottom-
/// side marker isn't drawn while the top is being viewed (and vice versa). Holes
/// and other through-features are "both".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hotspot {
    pub a: [f32; 2],
    pub b: [f32; 2],
    pub v: f32,
    pub side: String,
}

/// Geometric DFM measurements (the heavier Phase-2/3 facts). The `min_*`/scalar
/// fields feed the metrics tab; the `*_hotspots` lists carry the worst located
/// issues (sorted worst-first) for preview markers. Pure measurements — the
/// frontend judges them against the profile.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoMetrics {
    pub copper_coverage_pct: Option<f32>,
    pub min_silk_line_mm: Option<f32>,
    /// Distinct silk stroke widths (sorted asc) — frontend drops sub-artefact ones.
    pub silk_line_widths_mm: Vec<f32>,
    pub min_clearance_mm: Option<f32>,
    pub min_copper_width_mm: Option<f32>,
    pub min_annular_mm: Option<f32>,
    pub min_mask_dam_mm: Option<f32>,
    /// Max overshoot of any non-edge layer beyond the board outline bbox (mm).
    pub layer_overshoot_mm: Option<f32>,
    pub slot_count: u32,
    pub min_slot_width_mm: Option<f32>,
    pub clearance_hotspots: Vec<Hotspot>,
    /// Copper-width necks measured on REGION copper only (pads + zone fills, no
    /// routed strokes). Traces are judged by the conductor model, not here.
    pub copper_width_hotspots: Vec<Hotspot>,
    /// Routed conductors thin enough to possibly fail a min-width check: bbox
    /// corners in `a`/`b`, neck width in `v`, side-tagged. Drives the per-trace
    /// hover/tooltip of the thin-trace finding.
    pub thin_trace_conductors: Vec<Hotspot>,
    /// Total routed-conductor count across copper layers (geometric, not nets).
    pub trace_count: u32,
    /// Total routed length across all conductors (mm).
    pub trace_total_length_mm: f32,
    pub annular_hotspots: Vec<Hotspot>,
    pub mask_dam_hotspots: Vec<Hotspot>,
    pub overshoot_hotspots: Vec<Hotspot>,
    /// Thin-feature locations (stroke endpoints + width) for box markers.
    pub silk_hotspots: Vec<Hotspot>,
    pub trace_hotspots: Vec<Hotspot>,
    /// Drill-hole locations (bbox + diameter) for box markers.
    pub drill_hotspots: Vec<Hotspot>,
}

impl GeoMetrics {
    /// Drop all located-hotspot lists (keeps scalar measurements). Used by the
    /// CLI to emit lean output unless `--hotspots` is given.
    pub fn clear_hotspots(&mut self) {
        self.clearance_hotspots.clear();
        self.copper_width_hotspots.clear();
        self.thin_trace_conductors.clear();
        self.annular_hotspots.clear();
        self.mask_dam_hotspots.clear();
        self.overshoot_hotspots.clear();
        self.silk_hotspots.clear();
        self.trace_hotspots.clear();
        self.drill_hotspots.clear();
    }

    /// All located-hotspot lists with stable labels, worst-first. For reporting.
    pub fn hotspot_groups(&self) -> Vec<(&'static str, &[Hotspot])> {
        vec![
            ("clearance", &self.clearance_hotspots),
            ("copperWidth", &self.copper_width_hotspots),
            ("thinTrace", &self.thin_trace_conductors),
            ("annular", &self.annular_hotspots),
            ("maskDam", &self.mask_dam_hotspots),
            ("overshoot", &self.overshoot_hotspots),
            ("silk", &self.silk_hotspots),
            ("trace", &self.trace_hotspots),
            ("drill", &self.drill_hotspots),
        ]
    }
}

impl BoardMetrics {
    /// Drop all located hotspots (delegates to geo). See [`GeoMetrics::clear_hotspots`].
    pub fn clear_hotspots(&mut self) {
        self.geo.clear_hotspots();
    }
}

/// Board outline facts, from the Edge_Cuts layer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardDims {
    pub width_mm: f32,
    pub height_mm: f32,
    /// Did the perimeter stitch into a closed loop? (Open → size is an estimate.)
    pub outline_closed: bool,
    /// Inner cutouts (holes in the board outline), = loops − 1.
    pub cutout_count: u32,
    /// Was an Edge_Cuts layer present at all?
    pub has_edge_layer: bool,
}

/// Which layers the board carries (the inventory that drives feasibility).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerSummary {
    pub copper_top: bool,
    pub copper_bottom: bool,
    pub inner_copper_count: u32,
    pub has_mask_top: bool,
    pub has_mask_bottom: bool,
    pub has_silk_top: bool,
    pub has_silk_bottom: bool,
    pub has_paste: bool,
    /// top + bottom + inner — the number that matters for "how many layers".
    pub copper_layer_count: u32,
}

/// Per-copper-layer metrics.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopperLayerMetric {
    /// "top" | "bottom" | "inner" — for display.
    pub side: String,
    /// Narrowest routed trace (min of Line/Arc stroke widths, Add polarity only);
    /// `None` if the layer has no traces (only flashed pads / pours).
    pub min_trace_mm: Option<f32>,
    /// Distinct stroke widths (sorted asc) — lets the frontend drop sub-artefact
    /// widths before taking the min.
    pub trace_widths_mm: Vec<f32>,
    pub primitive_count: u32,
}

/// Drilling facts, aggregated across all drill files.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrillMetrics {
    pub total_holes: u32,
    /// Distinct tool diameters (mm), sorted ascending.
    pub unique_tool_diameters_mm: Vec<f32>,
    pub min_hole_mm: Option<f32>,
    pub plated_hole_count: u32,
    pub nonplated_hole_count: u32,
    /// (diameter_mm, count), sorted by diameter — lets the frontend apply a
    /// configurable "via ≤ d" threshold for the via heuristic.
    pub diameter_histogram: Vec<(f32, u32)>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_hotspot(v: f32) -> Hotspot {
        Hotspot {
            a: [0.0, 0.0],
            b: [0.1, 0.0],
            v,
            side: "top".into(),
        }
    }

    #[test]
    fn clear_hotspots_empties_all_groups() {
        let mut geo = GeoMetrics {
            clearance_hotspots: vec![make_hotspot(0.1)],
            copper_width_hotspots: vec![make_hotspot(0.2)],
            ..Default::default()
        };
        // Groups report the hotspots before clearing.
        let before: usize = geo.hotspot_groups().iter().map(|(_, g)| g.len()).sum();
        assert_eq!(before, 2, "two hotspots before clear");

        geo.clear_hotspots();

        assert!(
            geo.hotspot_groups().iter().all(|(_, g)| g.is_empty()),
            "all groups must be empty after clear_hotspots"
        );
    }

    #[test]
    fn board_metrics_clear_hotspots_delegates_to_geo() {
        let mut m = BoardMetrics {
            board: BoardDims {
                width_mm: 10.0,
                height_mm: 10.0,
                outline_closed: true,
                cutout_count: 0,
                has_edge_layer: true,
            },
            layers: LayerSummary::default(),
            copper: vec![],
            drill: DrillMetrics::default(),
            geo: GeoMetrics {
                annular_hotspots: vec![make_hotspot(0.3)],
                ..Default::default()
            },
        };
        m.clear_hotspots();
        assert!(m.geo.annular_hotspots.is_empty());
    }
}

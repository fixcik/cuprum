//! Geometric DFM measurements: clearance, copper width, annular ring, coverage,
//! silk, mask dam, overshoot, conductor model, drill markers, slots.

use std::collections::BTreeSet;
use std::sync::Arc;

use cuprum_gerber::GerberLayer;

use crate::sweep;
use crate::HOT_N;
use cuprum_gerber::geometry::{self, Poly};
use cuprum_mesh::{Role, Side};

use super::aggregate::{cell_dedup_top, hotspot_cmp, to_hotspot};
use super::copper::{
    annular_hotspots, copper_clearance_width_hotspots, ring_area_abs, stroke_widths,
    thin_stroke_hotspots, HIGHLIGHT_CAP, HIGHLIGHT_MAX_W,
};
use super::parse::DrillData;
use super::types::{BoardDims, GeoMetrics, Hotspot, LayerSummary, MetricLayerInput};

/// Outputs of the "zone 3" DFM analyses: conductor model, annular ring, silk
/// widths, thin-stroke locations, drill markers, mask dam, overshoot, slots.
/// Bundled so `geo_metrics` can compute them in one closure concurrently with the
/// clearance/width hotspot scan via `rayon::join`.
pub(super) struct Zone3 {
    pub(super) trace_count: u32,
    pub(super) trace_total_length_mm: f32,
    pub(super) thin_trace_conductors: Vec<Hotspot>,
    pub(super) annular_hots: Vec<Hotspot>,
    pub(super) min_annular: Option<f32>,
    pub(super) silk_line_widths: Vec<f32>,
    pub(super) min_silk_line: Option<f32>,
    pub(super) silk_hots: Vec<Hotspot>,
    pub(super) trace_hots: Vec<Hotspot>,
    pub(super) drill_hots: Vec<Hotspot>,
    pub(super) mask_hots: Vec<Hotspot>,
    pub(super) min_mask_dam: Option<f32>,
    pub(super) overshoot_hots: Vec<Hotspot>,
    pub(super) layer_overshoot: Option<f32>,
    pub(super) slot_count: u32,
    pub(super) min_slot_width_mm: Option<f32>,
}

/// Board outline dimensions: width, height, closed flag, cutout count.
pub(super) fn board_dims(layers: &[MetricLayerInput]) -> BoardDims {
    let Some(edge) = layers.iter().find(|l| l.role == Role::Edge) else {
        return BoardDims {
            width_mm: 0.0,
            height_mm: 0.0,
            origin_x_mm: 0.0,
            origin_y_mm: 0.0,
            outline_closed: false,
            cutout_count: 0,
            has_edge_layer: false,
        };
    };
    let (loops, perimeter_closed) = cuprum_mesh::outline_info(edge.bytes);
    let Some(perimeter) = loops.first() else {
        return BoardDims {
            width_mm: 0.0,
            height_mm: 0.0,
            origin_x_mm: 0.0,
            origin_y_mm: 0.0,
            outline_closed: false,
            cutout_count: 0,
            has_edge_layer: true,
        };
    };
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for p in perimeter {
        min_x = min_x.min(p[0]);
        min_y = min_y.min(p[1]);
        max_x = max_x.max(p[0]);
        max_y = max_y.max(p[1]);
    }
    BoardDims {
        width_mm: (max_x - min_x) as f32,
        height_mm: (max_y - min_y) as f32,
        origin_x_mm: min_x as f32,
        origin_y_mm: min_y as f32,
        outline_closed: perimeter_closed,
        cutout_count: (loops.len() - 1) as u32,
        has_edge_layer: true,
    }
}

/// Layer inventory: which sides/roles are present (no parsing — pure metadata).
pub(super) fn layer_summary(layers: &[MetricLayerInput]) -> LayerSummary {
    let mut s = LayerSummary::default();
    for l in layers {
        match l.role {
            Role::Copper => {
                if l.inner {
                    s.inner_copper_count += 1;
                } else if l.side == Side::Bottom {
                    s.copper_bottom = true;
                } else {
                    s.copper_top = true;
                }
            }
            Role::Mask => {
                if l.side == Side::Bottom {
                    s.has_mask_bottom = true;
                } else {
                    s.has_mask_top = true;
                }
            }
            Role::Silk => {
                if l.side == Side::Bottom {
                    s.has_silk_bottom = true;
                } else {
                    s.has_silk_top = true;
                }
            }
            Role::Paste => s.has_paste = true,
            _ => {}
        }
    }
    s.copper_layer_count = s.copper_top as u32 + s.copper_bottom as u32 + s.inner_copper_count;
    s
}

/// Everything in `GeoMetrics` that does NOT depend on the clearance/width hotspot
/// scan. Pulled into its own function so `geo_metrics` can run it concurrently
/// with `copper_clearance_width_hotspots` (the sweep-bound branch). Reads its
/// inputs immutably and every sub-analysis is pure, so the result is bit-identical
/// to inlining it — guarded by `board_metrics_deterministic_and_structured`.
pub(super) fn compute_zone3(
    layers: &[MetricLayerInput],
    copper_layers: &[(&str, Vec<Poly>)],
    board_bbox: Option<[f64; 4]>,
    parsed: &[Option<Arc<GerberLayer>>],
    drills: &[Option<DrillData>],
) -> Zone3 {
    let layer_side_fn = super::layer_side;

    // Conductor model: connected routed-stroke runs per copper layer. Neck = the
    // thin-trace value; count + total length feed the metrics tab.
    let mut runs: Vec<(crate::conductor::Conductor, &'static str)> = Vec::new();
    {
        let _cm = tracing::info_span!("conductor_model").entered();
        for (i, l) in layers
            .iter()
            .enumerate()
            .filter(|(_, l)| l.role == Role::Copper)
        {
            let Some(lay) = parsed[i].as_ref() else {
                continue;
            };
            let side = layer_side_fn(l);
            for c in crate::conductor::conductors(lay) {
                runs.push((c, side));
            }
        }
    }
    let trace_count = runs.len() as u32;
    let trace_total_length_mm = runs.iter().map(|(c, _)| c.length_mm).sum::<f64>() as f32;
    let mut thin_trace_conductors: Vec<Hotspot> = runs
        .iter()
        .filter(|(c, _)| c.neck_mm <= HIGHLIGHT_MAX_W)
        .map(|(c, side)| to_hotspot((c.min, c.max, c.neck_mm), side))
        .collect();
    thin_trace_conductors.sort_by(hotspot_cmp);
    thin_trace_conductors.truncate(HIGHLIGHT_CAP);

    // Annular ring: plated holes vs solid copper pads. Through-holes → side "both".
    let plated_holes: Vec<[f64; 3]> = layers
        .iter()
        .enumerate()
        .filter(|(_, l)| l.role == Role::Drill && l.plated)
        .filter_map(|(i, _)| drills[i].as_ref())
        .flat_map(|d| {
            d.holes
                .iter()
                .map(|h| [h.x_mm as f64, h.y_mm as f64, h.d_mm as f64])
        })
        .collect();
    let annular_hots: Vec<Hotspot> = annular_hotspots(copper_layers, &plated_holes)
        .into_iter()
        .map(|(h, side)| to_hotspot(h, side))
        .collect();
    let min_annular = annular_hots.first().map(|h| h.v);

    // Silk stroke widths (distinct, sorted) across silk layers.
    let mut silk_set: BTreeSet<u32> = BTreeSet::new();
    for (i, _l) in layers
        .iter()
        .enumerate()
        .filter(|(_, l)| l.role == Role::Silk)
    {
        if let Some(lay) = parsed[i].as_ref() {
            for w in stroke_widths(lay) {
                silk_set.insert((w * 1000.0).round() as u32);
            }
        }
    }
    let silk_line_widths: Vec<f32> = silk_set.iter().map(|um| *um as f32 / 1000.0).collect();
    let min_silk_line = silk_line_widths.first().copied();

    // Thin-feature locations: EVERY stroke narrow enough to possibly fail (the
    // frontend highlights the actual failing lines, so we send them all — not
    // clustered representatives — and the frontend clusters only for navigation).
    // Strokes wider than `HIGHLIGHT_MAX_W` can't fail any realistic min-width, so
    // they're skipped to bound the volume; the whole set is capped as a backstop.
    let silk_hots = thin_stroke_hotspots(layers, parsed, Role::Silk);
    let trace_hots = thin_stroke_hotspots(layers, parsed, Role::Copper);

    // Drill holes (box markers): each hole's bbox + diameter. Worst-first (smallest
    // diameter), deduped per ~1 mm cell and capped at HOT_N — same discipline as
    // clearance/width so the stepper count is consistent across families. Holes go
    // through the board → side "both".
    let drill_input: Vec<sweep::Hot> = layers
        .iter()
        .enumerate()
        .filter(|(_, l)| l.role == Role::Drill)
        .filter_map(|(i, _)| drills[i].as_ref())
        .flat_map(|d| d.holes.iter().copied())
        .filter(|h| h.d_mm > 0.0)
        .map(|h| {
            let (x, y, r) = (h.x_mm as f64, h.y_mm as f64, (h.d_mm / 2.0) as f64);
            ([x - r, y - r], [x + r, y + r], h.d_mm as f64)
        })
        .collect();
    let drill_hots: Vec<Hotspot> = cell_dedup_top(drill_input, 1.0, HOT_N)
        .into_iter()
        .map(|h| to_hotspot(h, "both"))
        .collect();

    // Mask dam: clearance between mask openings, per side (top vs bottom mask).
    let mut mask_hots: Vec<Hotspot> = Vec::new();
    for face in ["top", "bottom", "both"] {
        let openings: Vec<Poly> = layers
            .iter()
            .enumerate()
            .filter(|(_, l)| l.role == Role::Mask && layer_side_fn(l) == face)
            .filter_map(|(i, _)| parsed[i].as_ref())
            .flat_map(|lay| geometry::layer_polygons_from(lay, &[]))
            .collect();
        if openings.len() >= 2 {
            mask_hots.extend(
                sweep::clearance_hotspots(&openings)
                    .into_iter()
                    .map(|h| to_hotspot(h, face)),
            );
        }
    }
    mask_hots.sort_by(hotspot_cmp);
    let min_mask_dam = mask_hots.first().map(|h| h.v);

    // Overshoot: per non-edge layer, where its bbox sticks out past the board edge.
    let mut overshoot_hots: Vec<Hotspot> = Vec::new();
    if let Some(bb) = board_bbox {
        for (i, l) in layers
            .iter()
            .enumerate()
            .filter(|(_, l)| l.role != Role::Edge)
        {
            let Some(lay) = parsed[i].as_ref() else {
                continue;
            };
            let Some(b) = lay.try_bounding_box() else {
                continue;
            };
            let side = layer_side_fn(l);
            let cy = ((b.min.y + b.max.y) / 2.0).clamp(bb[1], bb[3]);
            let cx = ((b.min.x + b.max.x) / 2.0).clamp(bb[0], bb[2]);
            if b.max.x > bb[2] {
                overshoot_hots.push(to_hotspot(
                    ([b.max.x, cy], [bb[2], cy], b.max.x - bb[2]),
                    side,
                ));
            }
            if b.min.x < bb[0] {
                overshoot_hots.push(to_hotspot(
                    ([b.min.x, cy], [bb[0], cy], bb[0] - b.min.x),
                    side,
                ));
            }
            if b.max.y > bb[3] {
                overshoot_hots.push(to_hotspot(
                    ([cx, b.max.y], [cx, bb[3]], b.max.y - bb[3]),
                    side,
                ));
            }
            if b.min.y < bb[1] {
                overshoot_hots.push(to_hotspot(
                    ([cx, b.min.y], [cx, bb[1]], bb[1] - b.min.y),
                    side,
                ));
            }
        }
    }
    // Overshoot is "worst = largest" → sort descending.
    overshoot_hots.sort_by(|a, b| hotspot_cmp(b, a));
    overshoot_hots.truncate(HOT_N);
    let layer_overshoot = overshoot_hots.first().map(|h| h.v);

    // Routed slots from drill layers.
    let slots: Vec<cuprum_gerber::drill::Slot> = layers
        .iter()
        .enumerate()
        .filter(|(_, l)| l.role == Role::Drill)
        .filter_map(|(i, _)| drills[i].as_ref())
        .flat_map(|d| d.slots.iter().copied())
        .collect();
    let slot_count = slots.len() as u32;
    let min_slot_width_mm = slots
        .iter()
        .map(|s| s.w_mm)
        .fold(None::<f32>, |acc, v| Some(acc.map_or(v, |a| a.min(v))));

    Zone3 {
        trace_count,
        trace_total_length_mm,
        thin_trace_conductors,
        annular_hots,
        min_annular,
        silk_line_widths,
        min_silk_line,
        silk_hots,
        trace_hots,
        drill_hots,
        mask_hots,
        min_mask_dam,
        overshoot_hots,
        layer_overshoot,
        slot_count,
        min_slot_width_mm,
    }
}

/// Geometric DFM measurements (clearance, copper width, annular, coverage, silk,
/// mask dam, overshoot, slots). Pure measurements; the frontend judges them.
pub(super) fn geo_metrics(
    layers: &[MetricLayerInput],
    parsed: &[Option<Arc<GerberLayer>>],
    drills: &[Option<DrillData>],
) -> GeoMetrics {
    let layer_side_fn = super::layer_side;

    // Board area + outline bbox from Edge_Cuts (perimeter minus inner cutouts).
    let (board_area, board_bbox) = match layers.iter().find(|l| l.role == Role::Edge) {
        Some(e) => {
            let (loops, _) = cuprum_mesh::outline_info(e.bytes);
            match loops.first() {
                Some(perimeter) => {
                    let area = ring_area_abs(perimeter)
                        - loops.iter().skip(1).map(|r| ring_area_abs(r)).sum::<f64>();
                    let mut bb = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
                    for p in perimeter {
                        bb[0] = bb[0].min(p[0]);
                        bb[1] = bb[1].min(p[1]);
                        bb[2] = bb[2].max(p[0]);
                        bb[3] = bb[3].max(p[1]);
                    }
                    ((area > 0.0).then_some(area), Some(bb))
                }
                None => (None, None),
            }
        }
        None => (None, None),
    };

    // Solid copper pads per copper layer (no drill subtraction), tagged with the
    // layer's 2D side so the frontend can hide markers for the hidden face.
    let copper_layers: Vec<(&str, Vec<Poly>)> = layers
        .iter()
        .enumerate()
        .filter(|(_, l)| l.role == Role::Copper)
        .filter_map(|(i, l)| {
            parsed[i]
                .as_ref()
                .map(|layer| (layer_side_fn(l), geometry::layer_polygons_from(layer, &[])))
        })
        .filter(|(_, p)| !p.is_empty())
        .collect();

    // Coverage = densest single copper layer's area / board area.
    let copper_coverage_pct = board_area
        .and_then(|ba| {
            copper_layers
                .iter()
                .map(|(_, polys)| geometry::polys_area(polys) / ba * 100.0)
                .fold(None::<f64>, |acc, v| Some(acc.map_or(v, |a| a.max(v))))
        })
        .map(|v| v as f32);

    // Clearance (shorts) from the FULL union — needs all copper. Copper-WIDTH
    // necks from REGION copper only (pads + zone fills, no routed strokes): a
    // trace's width is its aperture (judged by the conductor model in zone 3), so
    // cross-measuring unioned trace bends here only produced artefacts.
    //
    // Zones 1+2 (clearance/width, sweep-bound) run CONCURRENTLY with zone 3
    // (conductor model, annular, silk, thin-stroke, drill, mask, overshoot, slots)
    // via `rayon::join` — overlapping the serial "gray zone" with the pool-heavy
    // hotspot scan. Both branches read the shared inputs immutably and every
    // sub-analysis is pure, so the result is bit-identical to running them in
    // sequence (guarded by `board_metrics_deterministic_and_structured` +
    // `copper_hotspots_match_sequential_reference`). Propagate the tracing
    // dispatcher + span onto the worker threads so each branch's spans land in the
    // operation's trace instead of vanishing.
    let dh = cuprum_trace::capture_dispatch();
    let ((clear_hots, width_hots), zone3) = rayon::join(
        || dh.run(|| copper_clearance_width_hotspots(&copper_layers, layers, parsed)),
        || dh.run(|| compute_zone3(layers, &copper_layers, board_bbox, parsed, drills)),
    );

    let min_clear = clear_hots
        .iter()
        .map(|h| h.v)
        .fold(None::<f32>, |a, v| Some(a.map_or(v, |a| a.min(v))));
    let min_width = width_hots
        .iter()
        .map(|h| h.v)
        .fold(None::<f32>, |a, v| Some(a.map_or(v, |a| a.min(v))));

    let Zone3 {
        trace_count,
        trace_total_length_mm,
        thin_trace_conductors,
        annular_hots,
        min_annular,
        silk_line_widths,
        min_silk_line,
        silk_hots,
        trace_hots,
        drill_hots,
        mask_hots,
        min_mask_dam,
        overshoot_hots,
        layer_overshoot,
        slot_count,
        min_slot_width_mm,
    } = zone3;

    GeoMetrics {
        copper_coverage_pct,
        min_silk_line_mm: min_silk_line,
        silk_line_widths_mm: silk_line_widths,
        min_clearance_mm: min_clear,
        min_copper_width_mm: min_width,
        min_annular_mm: min_annular,
        min_mask_dam_mm: min_mask_dam,
        layer_overshoot_mm: layer_overshoot,
        slot_count,
        min_slot_width_mm,
        clearance_hotspots: clear_hots,
        copper_width_hotspots: width_hots,
        thin_trace_conductors,
        trace_count,
        trace_total_length_mm,
        annular_hotspots: annular_hots,
        mask_dam_hotspots: mask_hots,
        overshoot_hotspots: overshoot_hots,
        silk_hotspots: silk_hots,
        trace_hotspots: trace_hots,
        drill_hotspots: drill_hots,
    }
}

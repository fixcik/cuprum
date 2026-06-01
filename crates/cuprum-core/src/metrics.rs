//! Measured manufacturing facts about a board, extracted from its gerber/Excellon
//! layers — the input to a design-for-manufacturing (DFM) feasibility check.
//!
//! This module only MEASURES (board size, layer inventory, minimum trace width,
//! drill statistics). It makes no judgement about whether the board can be built;
//! that comparison against a machine "capability profile" lives in the frontend,
//! so editing thresholds re-evaluates instantly without recomputing geometry.
//!
//! Phase 1 deliberately computes only the CHEAP metrics (a single pass over the
//! already-parsed primitives, or [`crate::drill::parse_drill`]). The expensive
//! geometric checks — minimum copper-to-copper clearance, annular ring, copper
//! coverage, routed-slot detection — are Phase 2/3 and intentionally absent here.
//!
//! The core stays free of `cuprum-project`: callers describe each layer with the
//! geometry-level [`crate::mesh::Role`]/[`crate::mesh::Side`] plus two booleans
//! (`inner` copper, `plated` drill) and map their own `LayerType` onto those.

use std::collections::{BTreeMap, BTreeSet};

use gerber_viewer::{Exposure, GerberLayer, GerberPrimitive};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::geometry::{self, Poly};
use crate::mesh::{Role, Side};

/// One layer handed to [`board_metrics`]: its geometric role/side, whether it is
/// an inner copper layer (`role == Copper`), whether its drills are plated
/// (`role == Drill`), and the raw gerber/Excellon bytes.
pub struct MetricLayerInput<'a> {
    pub role: Role,
    pub side: Side,
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

fn to_hotspot(h: geometry::Hot, side: &str) -> Hotspot {
    Hotspot {
        a: [h.0[0] as f32, h.0[1] as f32],
        b: [h.1[0] as f32, h.1[1] as f32],
        v: h.2 as f32,
        side: side.to_string(),
    }
}

/// The 2D face a layer's issues belong to. Inner copper maps to "top" (its
/// stacking side); it isn't shown separately in the 2D preview.
fn layer_side(l: &MetricLayerInput) -> &'static str {
    match l.side {
        Side::Top => "top",
        Side::Bottom => "bottom",
        Side::Both => "both",
    }
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

/// Measure every cheap manufacturing fact for the given layers.
#[tracing::instrument(skip_all, fields(layers = layers.len()))]
pub fn board_metrics(layers: &[MetricLayerInput]) -> BoardMetrics {
    BoardMetrics {
        board: board_dims(layers),
        layers: layer_summary(layers),
        copper: copper_metrics(layers),
        drill: drill_metrics(layers),
        geo: geo_metrics(layers),
    }
}

/// Board size + cutouts + closed flag from the Edge_Cuts layer (reuses the exact
/// same stitching the 3D mesh uses, so the measured size matches the render).
fn board_dims(layers: &[MetricLayerInput]) -> BoardDims {
    let Some(edge) = layers.iter().find(|l| l.role == Role::Edge) else {
        return BoardDims {
            width_mm: 0.0,
            height_mm: 0.0,
            outline_closed: false,
            cutout_count: 0,
            has_edge_layer: false,
        };
    };
    let (loops, perimeter_closed) = crate::mesh::outline_info(edge.bytes);
    let Some(perimeter) = loops.first() else {
        return BoardDims {
            width_mm: 0.0,
            height_mm: 0.0,
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
        outline_closed: perimeter_closed,
        cutout_count: (loops.len() - 1) as u32,
        has_edge_layer: true,
    }
}

/// Layer inventory: which sides/roles are present (no parsing — pure metadata).
fn layer_summary(layers: &[MetricLayerInput]) -> LayerSummary {
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

/// Per-copper-layer minimum trace width + primitive count.
fn copper_metrics(layers: &[MetricLayerInput]) -> Vec<CopperLayerMetric> {
    layers
        .iter()
        .filter(|l| l.role == Role::Copper)
        .map(|l| {
            let side = if l.inner {
                "inner"
            } else if l.side == Side::Bottom {
                "bottom"
            } else {
                "top"
            };
            let (min_trace_mm, trace_widths_mm, primitive_count) = match parse_layer(l.bytes) {
                Some(layer) => {
                    let ws = stroke_widths(&layer);
                    (
                        ws.first().copied().map(|w| w as f32),
                        ws.iter().map(|w| *w as f32).collect(),
                        layer.primitives().len() as u32,
                    )
                }
                None => (None, Vec::new(), 0),
            };
            CopperLayerMetric {
                side: side.to_string(),
                min_trace_mm,
                trace_widths_mm,
                primitive_count,
            }
        })
        .collect()
}

/// Distinct routed-stroke widths (Line/Arc, Add polarity only), sorted ascending.
/// The frontend drops sub-artefact widths (a tiny 10 µm marker aperture) before
/// taking the min — a single global minimum would otherwise be poisoned by it.
fn stroke_widths(layer: &GerberLayer) -> Vec<f64> {
    let mut set: BTreeSet<u32> = BTreeSet::new(); // µm, deduped
    for prim in layer.primitives() {
        let w = match prim {
            GerberPrimitive::Line(l) if l.exposure == Exposure::Add => Some(l.width),
            GerberPrimitive::Arc(a) if a.exposure == Exposure::Add => Some(a.width),
            _ => None,
        };
        if let Some(w) = w {
            if w > 0.0 {
                set.insert((w * 1000.0).round() as u32);
            }
        }
    }
    set.into_iter().map(|um| um as f64 / 1000.0).collect()
}

/// Aggregate drill statistics across all drill files.
fn drill_metrics(layers: &[MetricLayerInput]) -> DrillMetrics {
    // Bucket by diameter in integer micrometres to dedupe float noise.
    let mut hist: BTreeMap<u32, u32> = BTreeMap::new();
    let mut m = DrillMetrics::default();
    for l in layers.iter().filter(|l| l.role == Role::Drill) {
        let holes = crate::drill::parse_drill(l.bytes).unwrap_or_default();
        for h in &holes {
            if h.d_mm <= 0.0 {
                continue;
            }
            m.total_holes += 1;
            if l.plated {
                m.plated_hole_count += 1;
            } else {
                m.nonplated_hole_count += 1;
            }
            let um = (h.d_mm * 1000.0).round() as u32;
            *hist.entry(um).or_insert(0) += 1;
            m.min_hole_mm = Some(m.min_hole_mm.map_or(h.d_mm, |cur| cur.min(h.d_mm)));
        }
    }
    m.unique_tool_diameters_mm = hist.keys().map(|um| *um as f32 / 1000.0).collect();
    m.diameter_histogram = hist
        .iter()
        .map(|(um, c)| (*um as f32 / 1000.0, *c))
        .collect();
    m
}

/// Parse gerber bytes into a `GerberLayer` (same triple as `geometry`/`mesh`).
fn parse_layer(bytes: &[u8]) -> Option<GerberLayer> {
    let reader = std::io::BufReader::new(std::io::Cursor::new(bytes));
    let doc = gerber_viewer::gerber_parser::parse(reader).ok()?;
    Some(GerberLayer::new(doc.into_commands()))
}

/// |shoelace area| of a ring.
fn ring_area_abs(ring: &[[f64; 2]]) -> f64 {
    let n = ring.len();
    if n < 3 {
        return 0.0;
    }
    let mut s = 0.0;
    for i in 0..n {
        let a = ring[i];
        let b = ring[(i + 1) % n];
        s += a[0] * b[1] - b[0] * a[1];
    }
    (s / 2.0).abs()
}

/// Sort hotspots worst-first (smallest value) and cap the count.
fn top_n(mut v: Vec<geometry::Hot>, n: usize) -> Vec<geometry::Hot> {
    v.sort_by(|a, b| a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal));
    v.truncate(n);
    v
}

/// Padding (mm) when testing two hotspot boxes for overlap before merging.
const MERGE_PAD_MM: f64 = 0.1;

/// Longer side of a hotspot's bounding box (mm) — its "extent".
fn hot_extent(h: &geometry::Hot) -> f64 {
    (h.0[0] - h.1[0]).abs().max((h.0[1] - h.1[1]).abs())
}

/// Do two hotspots' (padded) bounding boxes overlap? Used to fold the two arms of
/// an L-shaped silk/trace stroke that meet at a corner into a single marker
/// instead of two stacked boxes.
fn hots_overlap(a: &geometry::Hot, b: &geometry::Hot, pad: f64) -> bool {
    let bb = |h: &geometry::Hot| {
        (
            h.0[0].min(h.1[0]) - pad,
            h.0[1].min(h.1[1]) - pad,
            h.0[0].max(h.1[0]) + pad,
            h.0[1].max(h.1[1]) + pad,
        )
    };
    let (ax0, ay0, ax1, ay1) = bb(a);
    let (bx0, by0, bx1, by1) = bb(b);
    ax0 <= bx1 && bx0 <= ax1 && ay0 <= by1 && by0 <= ay1
}

/// Drop hotspots whose box overlaps one already kept (longest-first), so two
/// markers that visually intersect collapse into one.
fn merge_overlapping(mut v: Vec<geometry::Hot>) -> Vec<geometry::Hot> {
    v.sort_by(|a, b| {
        hot_extent(b)
            .partial_cmp(&hot_extent(a))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut kept: Vec<geometry::Hot> = Vec::new();
    for h in v {
        if !kept.iter().any(|k| hots_overlap(k, &h, MERGE_PAD_MM)) {
            kept.push(h);
        }
    }
    kept
}

/// Midpoint of a hotspot's two points.
fn hot_mid(h: &geometry::Hot) -> [f64; 2] {
    [(h.0[0] + h.1[0]) / 2.0, (h.0[1] + h.1[1]) / 2.0]
}

/// Greedily cluster hotspots whose midpoints fall within `radius` mm of an
/// already-kept one — keeping the longest as the representative. Collapses a
/// swarm of nearby strokes (e.g. every glyph of a silk text block) into a few
/// markers instead of one per letter.
fn cluster_by_radius(mut v: Vec<geometry::Hot>, radius: f64) -> Vec<geometry::Hot> {
    v.sort_by(|a, b| {
        hot_extent(b)
            .partial_cmp(&hot_extent(a))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut kept: Vec<geometry::Hot> = Vec::new();
    for h in v {
        let m = hot_mid(&h);
        if !kept.iter().any(|k| {
            let km = hot_mid(k);
            (km[0] - m[0]).hypot(km[1] - m[1]) < radius
        }) {
            kept.push(h);
        }
    }
    kept
}

/// Keep up to `per_value` spatially-spread representatives PER distinct value
/// (width/diameter, rounded to µm). Unlike a global "thinnest N" cap — which a
/// swarm of sub-artefact 10 µm strokes would monopolise — this preserves every
/// value, so the frontend's artefact filter always leaves survivors. Every
/// survivor is tagged with `side` (these are computed per source layer).
/// `cluster_mm` sets how aggressively nearby instances collapse (≈3 mm for silk
/// text, ≈1 mm for traces/holes).
fn dedup_by_value(
    hots: Vec<geometry::Hot>,
    per_value: usize,
    side: &str,
    cluster_mm: f64,
) -> Vec<Hotspot> {
    let mut by_v: BTreeMap<u32, Vec<geometry::Hot>> = BTreeMap::new();
    for h in hots {
        by_v.entry((h.2 * 1000.0).round() as u32)
            .or_default()
            .push(h);
    }
    let mut out = Vec::new();
    for (_um, group) in by_v {
        // Cluster nearby instances, then fold overlapping boxes (e.g. two arms of
        // an L meeting at a corner, whose midpoints are far apart) into one.
        let mut v = merge_overlapping(cluster_by_radius(group, cluster_mm));
        if v.len() > per_value {
            let step = (v.len() / per_value).max(1);
            v = v.into_iter().step_by(step).take(per_value).collect();
        }
        out.extend(v.into_iter().map(|h| to_hotspot(h, side)));
    }
    out
}

/// Strokes wider than this can't fail any realistic min-width, so they're never
/// sent as thin-feature highlights.
const HIGHLIGHT_MAX_W: f64 = 0.5;
/// Backstop cap on highlight strokes per role (thinnest kept first).
const HIGHLIGHT_CAP: usize = 4000;

/// Every Add stroke (Line/Arc) of `role`'s layers narrow enough to possibly fail
/// a min-width check, as a side-tagged hotspot (endpoints + width). The frontend
/// draws ALL of these as the failing-feature highlight (and clusters them itself
/// for the stepper), so nothing is dropped to clustering here. Thinnest first.
fn thin_stroke_hotspots(layers: &[MetricLayerInput], role: Role) -> Vec<Hotspot> {
    let mut hots: Vec<Hotspot> = Vec::new();
    for l in layers.iter().filter(|l| l.role == role) {
        let Some(lay) = parse_layer(l.bytes) else {
            continue;
        };
        let side = layer_side(l);
        for h in stroke_hotspots(&lay) {
            if h.2 <= HIGHLIGHT_MAX_W {
                hots.push(to_hotspot(h, side));
            }
        }
    }
    hots.sort_by(|a, b| a.v.partial_cmp(&b.v).unwrap_or(std::cmp::Ordering::Equal));
    hots.truncate(HIGHLIGHT_CAP);
    hots
}

/// Each routed stroke (Line/Arc, Add) as a hotspot: its endpoints + width. Used
/// to LOCATE thin silk/trace features (the box marker bounds the stroke).
fn stroke_hotspots(layer: &GerberLayer) -> Vec<geometry::Hot> {
    let mut hots = Vec::new();
    for prim in layer.primitives() {
        match prim {
            GerberPrimitive::Line(l) if l.exposure == Exposure::Add && l.width > 0.0 => {
                hots.push(([l.start.x, l.start.y], [l.end.x, l.end.y], l.width));
            }
            GerberPrimitive::Arc(a) if a.exposure == Exposure::Add && a.width > 0.0 => {
                // Tessellate the arc into short chords (~8.6° each) so the line
                // highlight follows the curve instead of cutting a straight chord
                // across it (a silk circle was drawn as a few crooked lines).
                let steps = ((a.sweep_angle.abs() / 0.15).ceil() as usize).clamp(2, 96);
                let pt = |ang: f64| {
                    [
                        a.center.x + a.radius * ang.cos(),
                        a.center.y + a.radius * ang.sin(),
                    ]
                };
                let mut prev = pt(a.start_angle);
                for k in 1..=steps {
                    let ang = a.start_angle + a.sweep_angle * (k as f64 / steps as f64);
                    let cur = pt(ang);
                    hots.push((prev, cur, a.width));
                    prev = cur;
                }
            }
            _ => {}
        }
    }
    hots
}

/// Per-plated-hole annular hotspots: hole centre → nearest pad edge, value =
/// annular ring (pad radius − hole radius). A hole with no pad yields a zero
/// hotspot at the hole. Worst-first, capped. Through-holes → side "both".
fn annular_hotspots(
    copper_layers: &[(&str, Vec<Poly>)],
    plated_holes: &[[f64; 3]],
) -> Vec<geometry::Hot> {
    let mut hots: Vec<geometry::Hot> = Vec::new();
    for h in plated_holes {
        let p = [h[0], h[1]];
        let hole_r = h[2] / 2.0;
        // The covering pad with the largest radius (across copper layers).
        let mut best: Option<([f64; 2], f64)> = None;
        for (_side, polys) in copper_layers {
            if let Some(poly) = geometry::poly_containing(polys, p) {
                let (q, d) = geometry::point_ring_closest(p, &poly.outer);
                if best.is_none_or(|(_, r)| d > r) {
                    best = Some((q, d));
                }
            }
        }
        match best {
            Some((edge, pad_r)) => hots.push((p, edge, pad_r - hole_r)),
            None => hots.push((p, p, 0.0)),
        }
    }
    top_n(hots, 40)
}

/// Per-copper-layer clearance + width hotspots. Clearance from each layer's full
/// copper polygons; copper-WIDTH necks from REGION copper only (pads + zone fills,
/// no routed strokes — a trace's width is its aperture, judged by the conductor
/// model). Split out so the per-layer work can be parallelized while keeping the
/// reported order identical to a sequential pass (layer order preserved).
fn copper_clearance_width_hotspots(
    copper_layers: &[(&str, Vec<Poly>)],
    layers: &[MetricLayerInput],
) -> (Vec<Hotspot>, Vec<Hotspot>) {
    // Per-layer work runs in parallel. rayon preserves input order on `collect`
    // — for the indexed `map` path AND the filtered `width` path (implementation
    // behavior, exercised by rayon's own test suite) — and each
    // `clearance_width_hotspots` call is pure, so the concatenated result is
    // identical to a sequential pass (bit-for-bit), guarded by
    // `copper_hotspots_match_sequential_reference`.
    let clear_hots: Vec<Hotspot> = copper_layers
        .par_iter()
        .map(|(side, polys)| {
            let (c, _) = geometry::clearance_width_hotspots(polys);
            top_n(c, 40)
                .into_iter()
                .map(|h| to_hotspot(h, side))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>()
        .into_iter()
        .flatten()
        .collect();

    let width_hots: Vec<Hotspot> = layers
        .par_iter()
        .filter(|l| l.role == Role::Copper)
        .filter_map(|l| {
            let region = geometry::region_polygons(l.bytes, &[]).ok()?;
            if region.is_empty() {
                return None;
            }
            let side = layer_side(l);
            let (_, w) = geometry::clearance_width_hotspots(&region);
            Some(
                top_n(w, 40)
                    .into_iter()
                    .map(|h| to_hotspot(h, side))
                    .collect::<Vec<_>>(),
            )
        })
        .collect::<Vec<_>>()
        .into_iter()
        .flatten()
        .collect();

    (clear_hots, width_hots)
}

/// Geometric DFM measurements (clearance, copper width, annular, coverage, silk,
/// mask dam, overshoot, slots). Pure measurements; the frontend judges them.
fn geo_metrics(layers: &[MetricLayerInput]) -> GeoMetrics {
    // Board area + outline bbox from Edge_Cuts (perimeter minus inner cutouts).
    let (board_area, board_bbox) = match layers.iter().find(|l| l.role == Role::Edge) {
        Some(e) => {
            let (loops, _) = crate::mesh::outline_info(e.bytes);
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
        .filter(|l| l.role == Role::Copper)
        .filter_map(|l| {
            geometry::layer_polygons(l.bytes, &[])
                .ok()
                .map(|p| (layer_side(l), p))
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
    // trace's width is its aperture (judged by the conductor model below), so
    // cross-measuring unioned trace bends here only produced artefacts.
    let (clear_hots, width_hots) = copper_clearance_width_hotspots(&copper_layers, layers);

    // Conductor model: connected routed-stroke runs per copper layer. Neck = the
    // thin-trace value; count + total length feed the metrics tab.
    let mut runs: Vec<(crate::conductor::Conductor, &'static str)> = Vec::new();
    for l in layers.iter().filter(|l| l.role == Role::Copper) {
        let Some(lay) = parse_layer(l.bytes) else {
            continue;
        };
        let side = layer_side(l);
        for c in crate::conductor::conductors(&lay) {
            runs.push((c, side));
        }
    }
    let trace_count = runs.len() as u32;
    let trace_total_length_mm = runs.iter().map(|(c, _)| c.length_mm).sum::<f64>() as f32;
    let mut thin_trace_conductors: Vec<Hotspot> = runs
        .iter()
        .filter(|(c, _)| c.neck_mm <= HIGHLIGHT_MAX_W)
        .map(|(c, side)| to_hotspot((c.min, c.max, c.neck_mm), side))
        .collect();
    thin_trace_conductors
        .sort_by(|a, b| a.v.partial_cmp(&b.v).unwrap_or(std::cmp::Ordering::Equal));
    thin_trace_conductors.truncate(HIGHLIGHT_CAP);
    let min_clear = clear_hots
        .iter()
        .map(|h| h.v)
        .fold(None::<f32>, |a, v| Some(a.map_or(v, |a| a.min(v))));
    let min_width = width_hots
        .iter()
        .map(|h| h.v)
        .fold(None::<f32>, |a, v| Some(a.map_or(v, |a| a.min(v))));

    // Annular ring: plated holes vs solid copper pads. Through-holes → side "both".
    let plated_holes: Vec<[f64; 3]> = layers
        .iter()
        .filter(|l| l.role == Role::Drill && l.plated)
        .flat_map(|l| crate::drill::parse_drill(l.bytes).unwrap_or_default())
        .map(|h| [h.x_mm as f64, h.y_mm as f64, h.d_mm as f64])
        .collect();
    let annular_hots: Vec<Hotspot> = annular_hotspots(&copper_layers, &plated_holes)
        .into_iter()
        .map(|h| to_hotspot(h, "both"))
        .collect();
    let min_annular = annular_hots.first().map(|h| h.v);

    // Silk stroke widths (distinct, sorted) across silk layers.
    let mut silk_set: BTreeSet<u32> = BTreeSet::new();
    for l in layers.iter().filter(|l| l.role == Role::Silk) {
        if let Some(lay) = parse_layer(l.bytes) {
            for w in stroke_widths(&lay) {
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
    let silk_hots = thin_stroke_hotspots(layers, Role::Silk);
    let trace_hots = thin_stroke_hotspots(layers, Role::Copper);

    // Drill holes (box markers): each hole's bbox + diameter, per-diameter sample.
    // Holes go through the board → side "both".
    let drill_hots = dedup_by_value(
        layers
            .iter()
            .filter(|l| l.role == Role::Drill)
            .flat_map(|l| crate::drill::parse_drill(l.bytes).unwrap_or_default())
            .filter(|h| h.d_mm > 0.0)
            .map(|h| {
                let (x, y, r) = (h.x_mm as f64, h.y_mm as f64, (h.d_mm / 2.0) as f64);
                ([x - r, y - r], [x + r, y + r], h.d_mm as f64)
            })
            .collect(),
        12,
        "both",
        1.0,
    );

    // Mask dam: clearance between mask openings, per side (top vs bottom mask).
    let mut mask_hots: Vec<Hotspot> = Vec::new();
    for face in ["top", "bottom", "both"] {
        let openings: Vec<Poly> = layers
            .iter()
            .filter(|l| l.role == Role::Mask && layer_side(l) == face)
            .filter_map(|l| geometry::layer_polygons(l.bytes, &[]).ok())
            .flatten()
            .collect();
        if openings.len() >= 2 {
            mask_hots.extend(
                geometry::clearance_hotspots(&openings)
                    .into_iter()
                    .map(|h| to_hotspot(h, face)),
            );
        }
    }
    mask_hots.sort_by(|a, b| a.v.partial_cmp(&b.v).unwrap_or(std::cmp::Ordering::Equal));
    let min_mask_dam = mask_hots.first().map(|h| h.v);

    // Overshoot: per non-edge layer, where its bbox sticks out past the board edge.
    let mut overshoot_hots: Vec<Hotspot> = Vec::new();
    if let Some(bb) = board_bbox {
        for l in layers.iter().filter(|l| l.role != Role::Edge) {
            let Some(lay) = parse_layer(l.bytes) else {
                continue;
            };
            let Some(b) = lay.try_bounding_box() else {
                continue;
            };
            let side = layer_side(l);
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
    overshoot_hots.sort_by(|a, b| b.v.partial_cmp(&a.v).unwrap_or(std::cmp::Ordering::Equal));
    overshoot_hots.truncate(40);
    let layer_overshoot = overshoot_hots.first().map(|h| h.v);

    // Routed slots from drill layers.
    let slots: Vec<crate::drill::Slot> = layers
        .iter()
        .filter(|l| l.role == Role::Drill)
        .flat_map(|l| crate::drill::parse_slots(l.bytes))
        .collect();
    let min_slot_width_mm = slots
        .iter()
        .map(|s| s.w_mm)
        .fold(None::<f32>, |acc, v| Some(acc.map_or(v, |a| a.min(v))));

    GeoMetrics {
        copper_coverage_pct,
        min_silk_line_mm: min_silk_line,
        silk_line_widths_mm: silk_line_widths,
        min_clearance_mm: min_clear,
        min_copper_width_mm: min_width,
        min_annular_mm: min_annular,
        min_mask_dam_mm: min_mask_dam,
        layer_overshoot_mm: layer_overshoot,
        slot_count: slots.len() as u32,
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

#[cfg(test)]
mod tests {
    use super::*;

    // 10×10 mm rectangular Edge_Cuts outline (4 stroked sides).
    const EDGE_SQUARE: &[u8] = b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,0.1*%\nD10*\nX0Y0D02*\nX0100000Y0D01*\nX0100000Y0100000D01*\nX0Y0100000D01*\nX0Y0D01*\nM02*\n";
    // A copper layer with one 0.2 mm horizontal trace from (0,0) to (10,0).
    const CU_TRACE: &[u8] =
        b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,0.2*%\nD10*\nX0Y0D02*\nX0100000Y0D01*\nM02*\n";
    // PTH drill: two 0.3 mm holes and one 0.8 mm hole.
    const PTH: &[u8] =
        b"M48\nMETRIC,TZ\nT1C0.300\nT2C0.800\n%\nT1\nX1.0Y1.0\nX2.0Y1.0\nT2\nX3.0Y3.0\nM30\n";
    // NPTH drill: one 3.2 mm mounting hole.
    const NPTH: &[u8] = b"M48\nMETRIC,TZ\nT1C3.200\n%\nT1\nX5.0Y5.0\nM30\n";

    fn edge(bytes: &'static [u8]) -> MetricLayerInput<'static> {
        MetricLayerInput {
            role: Role::Edge,
            side: Side::Both,
            inner: false,
            plated: false,
            bytes,
        }
    }

    // Real multi-primitive gerbers → non-trivial clearance/width hotspots.
    const CU_LAYER_A: &[u8] = include_bytes!("../../../testdata/gerber/two_square_boxes.gbr");
    const CU_LAYER_B: &[u8] =
        include_bytes!("../../../testdata/gerber/polarities_and_apertures.gbr");

    // Bit-identical guard for the parallelized hotspot loops (Phase 1): the
    // production helper must match an in-process SEQUENTIAL recomputation exactly
    // — same per-layer order, same values. In-process so it is platform-independent
    // (float results cancel) and catches any reordering/divergence from rayon.
    #[test]
    fn copper_hotspots_match_sequential_reference() {
        let copper = |bytes: &'static [u8], side: Side| MetricLayerInput {
            role: Role::Copper,
            side,
            inner: false,
            plated: false,
            bytes,
        };
        let layers = vec![
            copper(CU_LAYER_A, Side::Top),
            copper(CU_LAYER_B, Side::Bottom),
        ];
        let copper_layers: Vec<(&str, Vec<Poly>)> = layers
            .iter()
            .filter_map(|l| {
                geometry::layer_polygons(l.bytes, &[])
                    .ok()
                    .map(|p| (layer_side(l), p))
            })
            .filter(|(_, p)| !p.is_empty())
            .collect();

        // Production path (parallel after Phase 1).
        let (clear, width) = copper_clearance_width_hotspots(&copper_layers, &layers);

        // Sequential reference, recomputed here in the same process.
        let mut ref_clear: Vec<Hotspot> = Vec::new();
        for (side, polys) in &copper_layers {
            let (c, _) = geometry::clearance_width_hotspots(polys);
            ref_clear.extend(top_n(c, 40).into_iter().map(|h| to_hotspot(h, side)));
        }
        let mut ref_width: Vec<Hotspot> = Vec::new();
        for l in layers.iter().filter(|l| l.role == Role::Copper) {
            let Ok(region) = geometry::region_polygons(l.bytes, &[]) else {
                continue;
            };
            if region.is_empty() {
                continue;
            }
            let side = layer_side(l);
            let (_, w) = geometry::clearance_width_hotspots(&region);
            ref_width.extend(top_n(w, 40).into_iter().map(|h| to_hotspot(h, side)));
        }

        assert_eq!(clear, ref_clear, "clearance hotspots must match sequential");
        assert_eq!(width, ref_width, "width hotspots must match sequential");
        // Sanity: at least one path yields hotspots on these fixtures (here it's
        // the width path), so the equivalence check above compares real data, not
        // two empty vectors. (clearance is empty here — the two shapes sit beyond
        // the DRC gap radius — so don't tighten this to `!clear.is_empty()`.)
        assert!(
            !clear.is_empty() || !width.is_empty(),
            "fixtures should yield at least one hotspot"
        );
    }

    #[test]
    fn board_size_from_edge_square() {
        let m = board_metrics(&[edge(EDGE_SQUARE)]);
        assert!(
            (m.board.width_mm - 10.0).abs() < 0.01,
            "w={}",
            m.board.width_mm
        );
        assert!(
            (m.board.height_mm - 10.0).abs() < 0.01,
            "h={}",
            m.board.height_mm
        );
        assert!(m.board.outline_closed, "square outline should be closed");
        assert_eq!(m.board.cutout_count, 0);
        assert!(m.board.has_edge_layer);
    }

    #[test]
    fn no_edge_layer_is_flagged() {
        let m = board_metrics(&[MetricLayerInput {
            role: Role::Copper,
            side: Side::Top,
            inner: false,
            plated: false,
            bytes: CU_TRACE,
        }]);
        assert!(!m.board.has_edge_layer);
        assert_eq!(m.board.width_mm, 0.0);
    }

    #[test]
    fn min_trace_from_copper() {
        let m = board_metrics(&[MetricLayerInput {
            role: Role::Copper,
            side: Side::Top,
            inner: false,
            plated: false,
            bytes: CU_TRACE,
        }]);
        assert_eq!(m.layers.copper_layer_count, 1);
        assert!(m.layers.copper_top);
        assert_eq!(m.copper.len(), 1);
        let t = m.copper[0].min_trace_mm.expect("trace width");
        assert!((t - 0.2).abs() < 0.01, "min_trace={t}");
        assert_eq!(m.copper[0].side, "top");
    }

    #[test]
    fn layer_summary_counts_sides_and_inner() {
        let layers = vec![
            MetricLayerInput {
                role: Role::Copper,
                side: Side::Top,
                inner: false,
                plated: false,
                bytes: CU_TRACE,
            },
            MetricLayerInput {
                role: Role::Copper,
                side: Side::Bottom,
                inner: false,
                plated: false,
                bytes: CU_TRACE,
            },
            // Inner copper is mapped to Side::Top by the caller; `inner` disambiguates it.
            MetricLayerInput {
                role: Role::Copper,
                side: Side::Top,
                inner: true,
                plated: false,
                bytes: CU_TRACE,
            },
            MetricLayerInput {
                role: Role::Mask,
                side: Side::Top,
                inner: false,
                plated: false,
                bytes: CU_TRACE,
            },
        ];
        let m = board_metrics(&layers);
        assert!(m.layers.copper_top && m.layers.copper_bottom);
        assert_eq!(m.layers.inner_copper_count, 1);
        assert_eq!(m.layers.copper_layer_count, 3);
        assert!(m.layers.has_mask_top && !m.layers.has_mask_bottom);
    }

    #[test]
    fn drill_stats_split_plated_and_tools() {
        let layers = vec![
            MetricLayerInput {
                role: Role::Drill,
                side: Side::Both,
                inner: false,
                plated: true,
                bytes: PTH,
            },
            MetricLayerInput {
                role: Role::Drill,
                side: Side::Both,
                inner: false,
                plated: false,
                bytes: NPTH,
            },
        ];
        let m = board_metrics(&layers);
        assert_eq!(m.drill.total_holes, 4, "3 PTH + 1 NPTH");
        assert_eq!(m.drill.plated_hole_count, 3);
        assert_eq!(m.drill.nonplated_hole_count, 1);
        assert_eq!(m.drill.unique_tool_diameters_mm, vec![0.3, 0.8, 3.2]);
        assert!((m.drill.min_hole_mm.unwrap() - 0.3).abs() < 0.001);
        // histogram: 0.3→2, 0.8→1, 3.2→1
        assert_eq!(
            m.drill.diameter_histogram,
            vec![(0.3, 2), (0.8, 1), (3.2, 1)]
        );
        // Holes go through the board → their hotspots are side "both".
        assert!(
            m.geo.drill_hotspots.iter().all(|h| h.side == "both"),
            "drill hotspots are both-sided"
        );
    }

    #[test]
    fn geo_coverage_and_no_slots() {
        let m = board_metrics(&[
            edge(EDGE_SQUARE),
            MetricLayerInput {
                role: Role::Copper,
                side: Side::Top,
                inner: false,
                plated: false,
                bytes: CU_TRACE,
            },
        ]);
        let cov = m.geo.copper_coverage_pct.expect("coverage measured");
        assert!(cov > 0.0 && cov < 100.0, "0–100% coverage: {cov}");
        assert_eq!(m.geo.slot_count, 0);
        assert!(m.geo.min_slot_width_mm.is_none());
        // A top-copper trace's hotspots are tagged "top" (so the preview can hide
        // them while the bottom face is being viewed).
        assert!(
            m.geo.trace_hotspots.iter().all(|h| h.side == "top"),
            "trace hotspots are top-sided"
        );
    }

    #[test]
    fn silk_widths_keep_artefact_and_real_stroke() {
        // A silk layer with a 0.01 mm artefact stroke + a real 0.07 mm stroke:
        // the backend must surface BOTH (sorted), so the frontend can drop the
        // sub-artefact one before taking the min (a single global min would hide
        // the real 0.07 mm thin silk).
        const SILK: &[u8] = b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,0.01*%\n%ADD11C,0.07*%\nD10*\nX0Y0D02*\nX0010000Y0D01*\nD11*\nX0Y0010000D02*\nX0010000Y0010000D01*\nM02*\n";
        let m = board_metrics(&[MetricLayerInput {
            role: Role::Silk,
            side: Side::Top,
            inner: false,
            plated: false,
            bytes: SILK,
        }]);
        assert_eq!(
            m.geo.silk_line_widths_mm,
            vec![0.01, 0.07],
            "both widths, sorted"
        );
        assert_eq!(
            m.geo.min_silk_line_mm,
            Some(0.01),
            "raw min is the artefact"
        );
        // Hotspots keep BOTH widths (per-value sampling), so the frontend's
        // artefact filter still leaves the real 0.07 stroke to mark.
        let mut widths: Vec<u32> = m
            .geo
            .silk_hotspots
            .iter()
            .map(|h| (h.v * 1000.0).round() as u32)
            .collect();
        widths.sort_unstable();
        widths.dedup();
        assert_eq!(
            widths,
            vec![10, 70],
            "hotspots keep the artefact AND the real width"
        );
        // The silk layer is Side::Top → every silk hotspot is tagged "top".
        assert!(
            m.geo.silk_hotspots.iter().all(|h| h.side == "top"),
            "silk hotspots are top-sided"
        );
    }

    #[test]
    fn thin_trace_reported_via_conductor_not_region() {
        // One copper layer: a 1mm pad + a 0.1mm trace from it. The conductor model
        // must surface the thin trace; the region width-check must stay silent (no
        // zone fill present).
        const CU: &[u8] = b"%FSLAX46Y46*%\n%MOMM*%\n%ADD10C,1.0*%\n%ADD11C,0.1*%\n\
            D10*\nX0Y0D03*\nD11*\nX0Y0D02*\nX5000000Y0D01*\nM02*\n";
        let inputs = vec![MetricLayerInput {
            role: Role::Copper,
            side: Side::Top,
            inner: false,
            plated: false,
            bytes: CU,
        }];
        let g = geo_metrics(&inputs);
        assert!(
            g.trace_count >= 1,
            "expected a conductor: {}",
            g.trace_count
        );
        assert!(
            g.thin_trace_conductors.iter().any(|h| h.v < 0.15),
            "thin conductor expected: {:?}",
            g.thin_trace_conductors
        );
        assert!(
            !g.copper_width_hotspots.iter().any(|h| h.v < 0.15),
            "region width-check must not flag the trace: {:?}",
            g.copper_width_hotspots
        );
        assert!(
            g.trace_total_length_mm > 4.0,
            "routed length: {}",
            g.trace_total_length_mm
        );
    }

    #[test]
    fn geo_detects_a_routed_slot() {
        const SLOT: &[u8] = b"M48\nMETRIC,TZ\nT1C1.000\n%\nT1\nX2.0Y2.0G85X6.0Y2.0\nM30\n";
        let m = board_metrics(&[MetricLayerInput {
            role: Role::Drill,
            side: Side::Both,
            inner: false,
            plated: false,
            bytes: SLOT,
        }]);
        assert_eq!(m.geo.slot_count, 1);
        assert!((m.geo.min_slot_width_mm.unwrap() - 1.0).abs() < 0.01);
    }
}

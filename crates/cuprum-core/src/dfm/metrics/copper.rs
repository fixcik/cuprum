//! Per-copper-layer metrics: trace widths, clearance/width hotspots, annular ring,
//! thin-stroke locations.

use std::collections::BTreeSet;
use std::sync::Arc;

use gerber_viewer::{Exposure, GerberLayer, GerberPrimitive};
use rayon::prelude::*;

use crate::dfm::sweep;
use crate::dfm::HOT_N;
use crate::geometry::{self, Poly};
use crate::mesh::{Role, Side};

use super::aggregate::{hotspot_cmp, to_hotspot, top_n};
use super::types::{CopperLayerMetric, Hotspot, MetricLayerInput};

/// Strokes wider than this can't fail any realistic min-width, so they're never
/// sent as thin-feature highlights.
pub(super) const HIGHLIGHT_MAX_W: f64 = 0.5;
/// Backstop cap on highlight strokes per role (thinnest kept first).
pub(super) const HIGHLIGHT_CAP: usize = 4000;

/// Per-copper-layer minimum trace width + primitive count.
pub(super) fn copper_metrics(
    layers: &[MetricLayerInput],
    parsed: &[Option<Arc<GerberLayer>>],
) -> Vec<CopperLayerMetric> {
    layers
        .iter()
        .enumerate()
        .filter(|(_, l)| l.role == Role::Copper)
        .map(|(i, l)| {
            let side = if l.inner {
                "inner"
            } else if l.side == Side::Bottom {
                "bottom"
            } else {
                "top"
            };
            let (min_trace_mm, trace_widths_mm, primitive_count) = match parsed[i].as_ref() {
                Some(layer) => {
                    let ws = stroke_widths(layer);
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
pub(super) fn stroke_widths(layer: &GerberLayer) -> Vec<f64> {
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

/// Per-copper-layer clearance + width hotspots. Clearance from each layer's full
/// copper polygons; copper-WIDTH necks from REGION copper only (pads + zone fills,
/// no routed strokes — a trace's width is its aperture, judged by the conductor
/// model). Split out so the per-layer work can be parallelized while keeping the
/// reported order identical to a sequential pass (layer order preserved).
pub(super) fn copper_clearance_width_hotspots(
    copper_layers: &[(&str, Vec<Poly>)],
    layers: &[MetricLayerInput],
    parsed: &[Option<Arc<GerberLayer>>],
) -> (Vec<Hotspot>, Vec<Hotspot>) {
    // Per-layer work runs in parallel. rayon preserves input order on `collect`
    // — for the indexed `map` path AND the filtered `width` path (implementation
    // behavior, exercised by rayon's own test suite) — and each
    // `clearance_width_hotspots` call is pure, so the concatenated result is
    // identical to a sequential pass (bit-for-bit), guarded by
    // `copper_hotspots_match_sequential_reference`.
    //
    // Propagate the current tracing dispatcher + span onto the rayon workers so the
    // per-layer spans (and their `grid_build`/`sweep`/`width_filter` children) are
    // captured in the operation's trace instead of vanishing on worker threads.
    let dh = crate::trace::capture_dispatch();

    // Clearance and width are independent (full-copper polys vs region polys,
    // separate outputs), so run the two parallel collections concurrently via
    // `rayon::join` — all per-layer calls of both contend for the pool at once,
    // instead of clearance-loop-then-width-loop with a barrier between. Order
    // within each is still preserved → bit-identical.
    let (clear_hots, width_hots): (Vec<Hotspot>, Vec<Hotspot>) = rayon::join(
        || {
            copper_layers
                .par_iter()
                .map(|(side, polys)| {
                    dh.run(|| {
                        let c = sweep::clearance_hotspots(polys);
                        top_n(c, HOT_N)
                            .into_iter()
                            .map(|h| to_hotspot(h, side))
                            .collect::<Vec<_>>()
                    })
                })
                .collect::<Vec<_>>()
                .into_iter()
                .flatten()
                .collect()
        },
        || {
            // Indexed parallel iterator (`enumerate` keeps order) so `collect`
            // preserves input order → bit-identical. Reuses the once-parsed layer
            // via `region_polygons_from` instead of re-parsing the bytes.
            layers
                .par_iter()
                .enumerate()
                .map(|(i, l)| {
                    dh.run(|| {
                        if l.role != Role::Copper {
                            return Vec::new();
                        }
                        let Some(layer) = parsed[i].as_ref() else {
                            return Vec::new();
                        };
                        let region = geometry::region_polygons_from(layer, &[]);
                        if region.is_empty() {
                            return Vec::new();
                        }
                        let side = super::layer_side(l);
                        let w = sweep::width_hotspots(&region);
                        top_n(w, HOT_N)
                            .into_iter()
                            .map(|h| to_hotspot(h, side))
                            .collect::<Vec<_>>()
                    })
                })
                .collect::<Vec<_>>()
                .into_iter()
                .flatten()
                .collect()
        },
    );

    (clear_hots, width_hots)
}

/// Per-plated-hole annular hotspots: hole centre → nearest pad edge, value =
/// annular ring (pad radius − hole radius). A hole with no pad yields a zero
/// hotspot at the hole. Worst-first, capped. Each hotspot carries the copper
/// side of the pad that was chosen (largest-radius pad across all copper layers);
/// bare holes with no covering pad anywhere are tagged "both".
#[tracing::instrument(skip_all)]
pub(super) fn annular_hotspots<'a>(
    copper_layers: &'a [(&'a str, Vec<Poly>)],
    plated_holes: &[[f64; 3]],
) -> Vec<(sweep::Hot, &'a str)> {
    let mut hots: Vec<(sweep::Hot, &'a str)> = Vec::new();
    for h in plated_holes {
        let p = [h[0], h[1]];
        let hole_r = h[2] / 2.0;
        // The covering pad with the largest radius, and the copper side it sits on.
        let mut best: Option<([f64; 2], f64, &'a str)> = None;
        for (side, polys) in copper_layers {
            if let Some(poly) = geometry::poly_containing(polys, p) {
                let (q, d) = geometry::point_ring_closest(p, &poly.outer);
                if best.is_none_or(|(_, r, _)| d > r) {
                    best = Some((q, d, *side));
                }
            }
        }
        match best {
            Some((edge, pad_r, side)) => hots.push(((p, edge, pad_r - hole_r), side)),
            // No covering pad anywhere → a bare through-hole, not side-specific.
            None => hots.push(((p, p, 0.0), "both")),
        }
    }
    // Worst (smallest annular) first, capped — same ordering as `top_n`, on the
    // hotspot value (`.0.2`); stable so equal values keep plated-hole order.
    hots.sort_by(|a, b| {
        a.0 .2
            .partial_cmp(&b.0 .2)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    hots.truncate(HOT_N);
    hots
}

/// Every Add stroke (Line/Arc) of `role`'s layers narrow enough to possibly fail
/// a min-width check, as a side-tagged hotspot (endpoints + width). The frontend
/// draws ALL of these as the failing-feature highlight (and clusters them itself
/// for the stepper), so nothing is dropped to clustering here. Thinnest first.
#[tracing::instrument(skip_all, fields(role = ?role))]
pub(super) fn thin_stroke_hotspots(
    layers: &[MetricLayerInput],
    parsed: &[Option<Arc<GerberLayer>>],
    role: Role,
) -> Vec<Hotspot> {
    let mut hots: Vec<Hotspot> = Vec::new();
    for (i, l) in layers.iter().enumerate().filter(|(_, l)| l.role == role) {
        let Some(lay) = parsed[i].as_ref() else {
            continue;
        };
        let side = super::layer_side(l);
        for h in stroke_hotspots(lay) {
            if h.2 <= HIGHLIGHT_MAX_W {
                hots.push(to_hotspot(h, side));
            }
        }
    }
    hots.sort_by(hotspot_cmp);
    hots.truncate(HIGHLIGHT_CAP);
    hots
}

/// Each routed stroke (Line/Arc, Add) as a hotspot: its endpoints + width. Used
/// to LOCATE thin silk/trace features (the box marker bounds the stroke).
pub(super) fn stroke_hotspots(layer: &GerberLayer) -> Vec<sweep::Hot> {
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

/// |shoelace area| of a ring.
pub(super) fn ring_area_abs(ring: &[[f64; 2]]) -> f64 {
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

//! Post-processing helpers for `sweep::Hot` collections: sorting, deduplication,
//! spatial clustering, and conversion to [`Hotspot`].

use std::collections::BTreeMap;

use crate::dfm::sweep;

use super::types::Hotspot;

/// Convert a raw sweep hotspot to the public [`Hotspot`] type with a side tag.
pub(super) fn to_hotspot(h: sweep::Hot, side: &str) -> Hotspot {
    Hotspot {
        a: [h.0[0] as f32, h.0[1] as f32],
        b: [h.1[0] as f32, h.1[1] as f32],
        v: h.2 as f32,
        side: side.to_string(),
    }
}

/// Total order on hotspots, worst-first (ascending `v`), with a coordinate
/// tie-break so equal-value hotspots have a deterministic order independent of
/// upstream iteration order (e.g. `conductor::conductors` is HashMap-ordered).
/// Without the tie-break, `board_metrics` output (and thus the disk cache) varies
/// run-to-run. For descending order (overshoot: worst = largest), compare reversed.
pub(super) fn hotspot_cmp(a: &Hotspot, b: &Hotspot) -> std::cmp::Ordering {
    a.v.total_cmp(&b.v)
        .then(a.a[0].total_cmp(&b.a[0]))
        .then(a.a[1].total_cmp(&b.a[1]))
        .then(a.b[0].total_cmp(&b.b[0]))
        .then(a.b[1].total_cmp(&b.b[1]))
}

/// Sort hotspots worst-first (smallest value) and cap the count.
pub(super) fn top_n(mut v: Vec<sweep::Hot>, n: usize) -> Vec<sweep::Hot> {
    v.sort_by(|a, b| a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal));
    v.truncate(n);
    v
}

/// Padding (mm) when testing two hotspot boxes for overlap before merging.
pub(super) const MERGE_PAD_MM: f64 = 0.1;

/// Longer side of a hotspot's bounding box (mm) — its "extent".
pub(super) fn hot_extent(h: &sweep::Hot) -> f64 {
    (h.0[0] - h.1[0]).abs().max((h.0[1] - h.1[1]).abs())
}

/// Do two hotspots' (padded) bounding boxes overlap? Used to fold the two arms of
/// an L-shaped silk/trace stroke that meet at a corner into a single marker
/// instead of two stacked boxes.
pub(super) fn hots_overlap(a: &sweep::Hot, b: &sweep::Hot, pad: f64) -> bool {
    let bb = |h: &sweep::Hot| {
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
pub(super) fn merge_overlapping(mut v: Vec<sweep::Hot>) -> Vec<sweep::Hot> {
    v.sort_by(|a, b| {
        hot_extent(b)
            .partial_cmp(&hot_extent(a))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut kept: Vec<sweep::Hot> = Vec::new();
    for h in v {
        if !kept.iter().any(|k| hots_overlap(k, &h, MERGE_PAD_MM)) {
            kept.push(h);
        }
    }
    kept
}

/// Midpoint of a hotspot's two points.
pub(super) fn hot_mid(h: &sweep::Hot) -> [f64; 2] {
    [(h.0[0] + h.1[0]) / 2.0, (h.0[1] + h.1[1]) / 2.0]
}

/// Greedily cluster hotspots whose midpoints fall within `radius` mm of an
/// already-kept one — keeping the longest as the representative. Collapses a
/// swarm of nearby strokes (e.g. every glyph of a silk text block) into a few
/// markers instead of one per letter.
pub(super) fn cluster_by_radius(mut v: Vec<sweep::Hot>, radius: f64) -> Vec<sweep::Hot> {
    v.sort_by(|a, b| {
        hot_extent(b)
            .partial_cmp(&hot_extent(a))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut kept: Vec<sweep::Hot> = Vec::new();
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
pub(super) fn dedup_by_value(
    hots: Vec<sweep::Hot>,
    per_value: usize,
    side: &str,
    cluster_mm: f64,
) -> Vec<Hotspot> {
    let mut by_v: BTreeMap<u32, Vec<sweep::Hot>> = BTreeMap::new();
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

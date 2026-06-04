//! Post-processing helpers for `sweep::Hot` collections: sorting, deduplication,
//! spatial clustering, and conversion to [`Hotspot`].

use crate::sweep;

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

/// Spatially dedupe a hotspot set: keep the WORST (smallest value) per ~`cell_mm`
/// cell (so a cluster of nearby holes/violations doesn't become dozens of stacked
/// markers), sort worst-first, cap to `n`. The metrics-side mirror of the sweep's
/// `dedup_top` — used so drill/via hotspots share the same cap discipline as
/// clearance/width instead of per-diameter sampling. The coordinate tie-break
/// keeps the (truncated) set deterministic regardless of input/HashMap order.
pub(super) fn cell_dedup_top(hots: Vec<sweep::Hot>, cell_mm: f64, n: usize) -> Vec<sweep::Hot> {
    let mut best: std::collections::HashMap<(i64, i64), sweep::Hot> =
        std::collections::HashMap::new();
    for h in hots {
        let mx = ((h.0[0] + h.1[0]) / 2.0 / cell_mm).round() as i64;
        let my = ((h.0[1] + h.1[1]) / 2.0 / cell_mm).round() as i64;
        best.entry((mx, my))
            .and_modify(|b| {
                if h.2 < b.2 {
                    *b = h;
                }
            })
            .or_insert(h);
    }
    let mut v: Vec<sweep::Hot> = best.into_values().collect();
    v.sort_by(|a, b| {
        a.2.partial_cmp(&b.2)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0[0].total_cmp(&b.0[0]))
            .then(a.0[1].total_cmp(&b.0[1]))
            .then(a.1[0].total_cmp(&b.1[0]))
            .then(a.1[1].total_cmp(&b.1[1]))
    });
    v.truncate(n);
    v
}

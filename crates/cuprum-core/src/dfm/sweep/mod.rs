//! DFM sweep: the clearance/width hotspot scan over copper polygons and the
//! geometric helpers it needs. Pure measurement — depends on `crate::geometry`
//! for polygon types and shared primitives, never the reverse.

mod edges;
mod neck;
mod scan;
mod segments;

pub use scan::Hot;
use scan::{hotspots, Want};

use crate::geometry::Poly;

/// (min clearance, min copper width) — the worst values, for the metrics tab.
pub fn min_clearance_and_width(polys: &[Poly]) -> (Option<f64>, Option<f64>) {
    let (c, w) = clearance_width_hotspots(polys);
    (c.first().map(|h| h.2), w.first().map(|h| h.2))
}

/// Both sides at once. Retained for `min_clearance_and_width` and the bit-identical
/// guard tests; hot callers use the one-sided `clearance_hotspots` / `width_hotspots`.
pub fn clearance_width_hotspots(polys: &[Poly]) -> (Vec<Hot>, Vec<Hot>) {
    hotspots(polys, Want::Both)
}

/// Clearance hotspots only (cross-polygon gaps) — e.g. the full copper union, mask
/// openings. Skips the copper-width branch entirely.
pub fn clearance_hotspots(polys: &[Poly]) -> Vec<Hot> {
    hotspots(polys, Want::Clearance).0
}

/// Copper-width (neck) hotspots only — e.g. the region copper set. Skips the
/// clearance branch entirely.
pub fn width_hotspots(polys: &[Poly]) -> Vec<Hot> {
    hotspots(polys, Want::Width).1
}

/// Min clearance between distinct polygons only (e.g. for mask openings).
pub fn min_island_clearance(polys: &[Poly]) -> Option<f64> {
    clearance_hotspots(polys).first().map(|h| h.2)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::{layer_polygons, region_polygons};

    // Shared Gerber fixture: a 1 mm pad flash (D10/D03) plus a 0.1 mm trace draw
    // (D11/D01). Used by region_polygons_excludes_trace_strokes and the from-layer
    // equivalence tests below.
    const PAD_AND_TRACE: &[u8] = b"%FSLAX46Y46*%\n%MOMM*%\n\
        %ADD10C,1.0*%\n%ADD11C,0.1*%\n\
        D10*\nX0Y0D03*\n\
        D11*\nX0Y0D02*\nX5000000Y0D01*\nM02*\n";

    /// Simplification must NOT erase a genuine thin feature: a 0.1 mm-wide copper
    /// rectangle still reports a copper-width hotspot ≈ 0.1 mm.
    #[test]
    fn simplify_keeps_a_real_thin_neck() {
        use crate::geometry::fill_polygons;
        let rect = vec![[0.0, 0.0], [5.0, 0.0], [5.0, 0.1], [0.0, 0.1]];
        let polys = fill_polygons(&[rect], &[]);
        let (_c, w) = clearance_width_hotspots(&polys);
        let mw = w.iter().map(|h| h.2).fold(f64::INFINITY, f64::min);
        assert!((mw - 0.1).abs() < 0.03, "thin copper width preserved: {mw}");
    }

    #[test]
    fn min_clearance_between_two_islands() {
        use crate::geometry::fill_polygons;
        // Two unit squares with a 0.2 mm gap in x → two disjoint polys.
        let a = vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
        let b = vec![[1.2, 0.0], [2.2, 0.0], [2.2, 1.0], [1.2, 1.0]];
        let polys = fill_polygons(&[a, b], &[]);
        assert_eq!(polys.len(), 2, "expected two islands: {polys:?}");
        let (clear, _) = min_clearance_and_width(&polys);
        assert!(
            (clear.unwrap() - 0.2).abs() < 0.02,
            "clearance ≈ 0.2: {clear:?}"
        );
    }

    /// A BAY (deep narrow notch) is a void between two outward-facing faces of
    /// the SAME piece — NOT a copper neck. The slot is 0.1 mm wide but it's empty,
    /// so it must NOT be reported as 0.1 mm copper width. (Interiorness filter.)
    #[test]
    fn bay_notch_is_not_reported_as_thin_copper() {
        use crate::geometry::fill_polygons;
        // 2×2 block with a 0.1 mm-wide slot cut from the top down to y=0.5.
        let notched = vec![
            [0.0, 0.0],
            [2.0, 0.0],
            [2.0, 2.0],
            [1.05, 2.0],
            [1.05, 0.5],
            [0.95, 0.5],
            [0.95, 2.0],
            [0.0, 2.0],
        ];
        let polys = fill_polygons(&[notched], &[]);
        let (_c, w) = clearance_width_hotspots(&polys);
        // No hotspot should sit in the empty slot (mid x≈1.0, y in 0.5..2.0).
        let in_slot = w.iter().any(|h| {
            let mx = (h.0[0] + h.1[0]) / 2.0;
            let my = (h.0[1] + h.1[1]) / 2.0;
            (0.9..=1.1).contains(&mx) && (0.5..=2.0).contains(&my) && h.2 < 0.15
        });
        assert!(
            !in_slot,
            "slot void must not be reported as thin copper: {w:?}"
        );
    }

    /// A WEDGE at an acute convex corner is solid copper but not a neck: its two
    /// bounding faces meet at an acute angle (not anti-parallel). It must NOT be
    /// flagged. (Anti-parallel-faces filter.)
    #[test]
    fn acute_wedge_corner_is_not_reported_as_thin_copper() {
        use crate::geometry::fill_polygons;
        // A thin 30° triangular spike off a body — faces near the tip are at an
        // acute angle, so the tiny cross-distance there is a wedge, not a neck.
        let spike = vec![[0.0, 0.0], [5.0, 0.2], [5.0, -0.2]];
        let polys = fill_polygons(&[spike], &[]);
        let (_c, w) = clearance_width_hotspots(&polys);
        // Near the sharp tip (x≈4.8..5.0) the faces are acute → no neck there.
        let at_tip = w.iter().any(|h| {
            let mx = (h.0[0] + h.1[0]) / 2.0;
            (4.6..=5.0).contains(&mx) && h.2 < 0.15
        });
        assert!(
            !at_tip,
            "acute wedge tip must not be reported as thin copper: {w:?}"
        );
    }

    /// A trace that BENDS is solid copper, not a thin neck: the union of the two
    /// segments + their round line caps makes a concave seam on the inner side of
    /// the turn, and a naive cross-distance there reads as "thin copper" even
    /// though the copper is a full-width trace. (Persistence filter — the narrow
    /// reading does not extend along any corridor.)
    ///
    /// The features are lifted verbatim from a real board (water-meter-cam
    /// led_board, net D1-K): a roundrect pad with a 0.2 mm conductor running +x
    /// then turning 45° down. The pad↔trace union seam at the bend produced a
    /// false 0.11 mm "thin copper" reading. (The pad is required to reproduce it —
    /// the union places a vertex on the trace's bottom edge at the seam.)
    #[test]
    fn trace_bend_is_not_reported_as_thin_copper() {
        use crate::geometry::copper_polygons;
        const BEND: &[u8] = b"%FSLAX46Y46*%\n%MOMM*%\n\
            %AMRoundRect*\n4,1,4,$2,$3,$4,$5,$6,$7,$8,$9,$2,$3,0*\n\
            1,1,$1+$1,$2,$3*\n1,1,$1+$1,$4,$5*\n1,1,$1+$1,$6,$7*\n1,1,$1+$1,$8,$9*\n\
            20,1,$1+$1,$2,$3,$4,$5,0*\n20,1,$1+$1,$4,$5,$6,$7,0*\n\
            20,1,$1+$1,$6,$7,$8,$9,0*\n20,1,$1+$1,$8,$9,$2,$3,0*\n%\n\
            %ADD10RoundRect,0.165000X-0.885000X0.385000X-0.885000X-0.385000X0.885000X-0.385000X0.885000X0.385000X0*%\n\
            %ADD15C,0.200000*%\n\
            D10*\nX57800000Y-50700000D03*\n\
            D15*\n\
            X57800000Y-50700000D02*\nX59000000Y-50700000D01*\n\
            X59000000Y-50700000D02*\nX60400000Y-52100000D01*\nM02*\n";
        let polys = copper_polygons(BEND, &[]).unwrap();
        assert_eq!(polys.len(), 1, "the bent trace is one island: {polys:?}");
        let (_c, width) = clearance_width_hotspots(&polys);
        // The bend sits at the junction (x≈59.0, y≈-50.8). No sub-limit copper-
        // width hotspot may land there — the copper is a solid 0.2 mm trace.
        let at_bend = width.iter().any(|h| {
            let mx = (h.0[0] + h.1[0]) / 2.0;
            let my = (h.0[1] + h.1[1]) / 2.0;
            (58.6..=59.4).contains(&mx) && (-51.1..=-50.5).contains(&my) && h.2 < 0.15
        });
        assert!(
            !at_bend,
            "trace bend must not be reported as thin copper: {width:?}"
        );
    }

    #[test]
    fn region_polygons_excludes_trace_strokes() {
        // A pad flash (D03) plus a thin trace draw (D01). region_polygons must keep
        // the pad and drop the trace → no thin neck to find on the region set.
        let regions = region_polygons(PAD_AND_TRACE, &[]).unwrap();
        let full = layer_polygons(PAD_AND_TRACE, &[]).unwrap();
        let (_c, full_w) = clearance_width_hotspots(&full);
        assert!(
            full_w.iter().any(|h| h.2 < 0.15),
            "trace neck should show in full union: {full_w:?}"
        );
        let (_c, region_w) = clearance_width_hotspots(&regions);
        assert!(
            !region_w.iter().any(|h| h.2 < 0.15),
            "region set must have no thin neck: {region_w:?}"
        );
    }

    #[test]
    fn min_copper_width_of_a_thin_trace() {
        use crate::geometry::fill_polygons;
        // A 0.1 mm wide, 5 mm long bar: the two long edges are 0.1 mm apart.
        let bar = vec![[0.0, 0.0], [5.0, 0.0], [5.0, 0.1], [0.0, 0.1]];
        let polys = fill_polygons(&[bar], &[]);
        assert_eq!(polys.len(), 1);
        let (clear, width) = min_clearance_and_width(&polys);
        assert!(clear.is_none(), "single island → no clearance: {clear:?}");
        assert!(
            (width.unwrap() - 0.1).abs() < 0.02,
            "width ≈ 0.1: {width:?}"
        );
    }

    /// Two parallel horizontal 0.2 mm-wide traces separated by a 0.3 mm centre-to-centre
    /// gap → edge-to-edge clearance = 0.3 - 0.2 = 0.1 mm. Verifies that coalesced
    /// polyline stroking (PR2) preserves the correct clearance measurement.
    #[test]
    fn coalesced_traces_clearance_matches_gap() {
        // Two 2mm-long horizontal traces, width 0.2mm, at y=0 and y=0.3mm.
        // In 4.6 format (mm): 1 unit = 1e-6 mm, so 2mm = 2000000, 0.3mm = 300000.
        const TWO_TRACES: &[u8] = b"%FSLAX46Y46*%\n%MOMM*%\n\
            %ADD10C,0.200000*%\n\
            D10*\nX0Y0D02*\nX2000000Y0D01*\n\
            X0Y300000D02*\nX2000000Y300000D01*\nM02*\n";
        let polys = layer_polygons(TWO_TRACES, &[]).unwrap();
        assert_eq!(
            polys.len(),
            2,
            "two separate trace islands expected: {polys:?}"
        );
        let (clear, _) = min_clearance_and_width(&polys);
        // Edge-to-edge gap = centre gap (0.3) - width (0.2) = 0.1 mm.
        let expected = 0.1;
        assert!(
            (clear.unwrap() - expected).abs() < 0.02,
            "clearance ≈ {expected}: got {:?}",
            clear
        );
    }

    #[test]
    fn clearance_hotspot_lands_in_the_gap() {
        use crate::geometry::fill_polygons;
        let a = vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
        let b = vec![[1.2, 0.0], [2.2, 0.0], [2.2, 1.0], [1.2, 1.0]];
        let polys = fill_polygons(&[a, b], &[]);
        let (clear, _) = clearance_width_hotspots(&polys);
        assert!(!clear.is_empty(), "expected a clearance hotspot");
        let h = clear[0];
        assert!((h.2 - 0.2).abs() < 0.02, "gap value ≈ 0.2: {}", h.2);
        let midx = (h.0[0] + h.1[0]) / 2.0;
        assert!(
            (1.0..=1.2).contains(&midx),
            "hotspot midpoint sits in the gap: {midx}"
        );
    }
}

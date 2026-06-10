//! Isolation-milling DFM: which copper gaps a given cutter cannot isolate.
//!
//! An isolation pass removes a channel along each copper edge — the cutter
//! offset by half its effective width on both sides. When the gap between two
//! distinct copper features is narrower than that effective cut width, the two
//! channels merge and the tool bridges the features into one: an electrical
//! short instead of an isolation gap. FlatCAM silently merges these; we surface
//! them as locatable findings so the user can pick a finer bit, reduce the cut
//! depth (V-bit narrows the channel), or fall back to UV.

use cuprum_gerber::geometry::Poly;

use crate::clearance_hotspots;
use crate::Hotspot;

/// Side tag carried on isolation-gap findings (mirrors the `side` convention of
/// the other DFM hotspot families).
const ISO_GAP_SIDE: &str = "iso-gap";

/// Copper gaps too narrow for a cutter of effective `cut_width` to isolate.
///
/// Returns the clearance hotspots whose edge-to-edge gap is below `cut_width`,
/// worst (narrowest) first — exactly the spots where an isolation pass would
/// bridge two conductors. `cut_width` is the cutter's effective channel width
/// (cylindrical: its diameter; V-bit: `cuprum_gerber::geometry::vbit_cut_width`).
/// A non-positive `cut_width` (or empty copper) yields no findings.
pub fn isolation_gap_violations(copper: &[Poly], cut_width: f64) -> Vec<Hotspot> {
    if cut_width <= 0.0 {
        return Vec::new();
    }
    clearance_hotspots(copper)
        .into_iter()
        .filter(|h| h.2 < cut_width)
        .map(|h| Hotspot {
            a: [h.0[0] as f32, h.0[1] as f32],
            b: [h.1[0] as f32, h.1[1] as f32],
            v: h.2 as f32,
            side: ISO_GAP_SIDE.to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use cuprum_gerber::geometry::fill_polygons;

    /// Two unit squares with a 0.2 mm gap → two distinct conductors.
    fn two_squares(gap: f64) -> Vec<Poly> {
        let a = vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
        let b = vec![
            [1.0 + gap, 0.0],
            [2.0 + gap, 0.0],
            [2.0 + gap, 1.0],
            [1.0 + gap, 1.0],
        ];
        let polys = fill_polygons(&[a, b], &[]);
        assert_eq!(polys.len(), 2, "expected two islands: {polys:?}");
        polys
    }

    #[test]
    fn gap_narrower_than_cut_is_flagged() {
        // 0.1 mm gap, 0.2 mm cutter → would bridge → one finding at ~0.1 mm.
        let polys = two_squares(0.1);
        let v = isolation_gap_violations(&polys, 0.2);
        assert!(!v.is_empty(), "0.1 gap < 0.2 cut must be flagged: {v:?}");
        let worst = v[0].v;
        assert!(
            (worst - 0.1).abs() < 0.03,
            "worst gap ≈ 0.1 mm, got {worst}"
        );
        assert_eq!(v[0].side, ISO_GAP_SIDE);
    }

    #[test]
    fn gap_wider_than_cut_is_clean() {
        // 0.3 mm gap, 0.2 mm cutter → isolates fine → no findings.
        let polys = two_squares(0.3);
        let v = isolation_gap_violations(&polys, 0.2);
        assert!(v.is_empty(), "0.3 gap > 0.2 cut must be clean: {v:?}");
    }

    #[test]
    fn non_positive_cut_or_empty_copper_yields_nothing() {
        let polys = two_squares(0.1);
        assert!(isolation_gap_violations(&polys, 0.0).is_empty());
        assert!(isolation_gap_violations(&polys, -1.0).is_empty());
        assert!(isolation_gap_violations(&[], 0.2).is_empty());
    }

    #[test]
    fn single_conductor_has_no_gap_to_violate() {
        // One polygon → no inter-copper clearance pairs → nothing to flag.
        let polys = two_squares(0.1);
        let single = &polys[..1];
        assert!(isolation_gap_violations(single, 0.2).is_empty());
    }

    #[test]
    fn findings_sorted_worst_first() {
        // A 0.1 mm gap and a 0.25 mm gap; cutter 0.3 mm flags both, narrowest first.
        let a = vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
        let b = vec![[1.1, 0.0], [2.0, 0.0], [2.0, 1.0], [1.1, 1.0]];
        let c = vec![[2.25, 0.0], [3.0, 0.0], [3.0, 1.0], [2.25, 1.0]];
        let polys = fill_polygons(&[a, b, c], &[]);
        let v = isolation_gap_violations(&polys, 0.3);
        assert!(v.len() >= 2, "both gaps flagged: {v:?}");
        assert!(
            v[0].v <= v[1].v,
            "worst (narrowest) first: {:?}",
            v.iter().map(|h| h.v).collect::<Vec<_>>()
        );
    }
}

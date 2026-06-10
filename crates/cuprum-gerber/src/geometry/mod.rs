//! 2D polygon boolean geometry for copper layers.
//!
//! The frontend used to do the expensive copper boolean work (union of all
//! pad/pour fills, then subtract drill holes) in single-threaded JS with
//! `polygon-clipping`, which THROWS "Unable to complete output ring" on a
//! self-touching ground pour and wipes the whole layer. We move that work here,
//! into Rust, using `i_overlay` (robust to self-intersection).
//!
//! This walks the SAME `crate::GerberPrimitive` enum as [`crate::svg`]
//! (read that module for the parse + arc-tessellation conventions): coordinates
//! are absolute millimetres, Y up. Output is a set of CLEAN, simple,
//! non-overlapping filled polygons (outer ring + holes).
//!
//! Scope is COPPER only for now, but [`fill_polygons`] is layer-agnostic
//! (Add-only union + hole subtraction), so it can serve other layers later.
//!
//! Split into: [`tess`] (primitive → contour tessellation + winding), [`build`]
//! (the layer/region/mask polygon builders), [`measure`] (area / point-in-ring /
//! nearest-point queries used by DFM and mesh).

mod build;
mod isolation;
mod measure;
mod tess;

pub use build::{
    copper_polygons, fill_polygons, layer_polygons, layer_polygons_from, mask_polygons,
    region_polygons, region_polygons_from, shapes_to_polys,
};
pub use isolation::{isolation_paths, vbit_cut_width};
pub use measure::{
    point_in_ring, point_ring_closest, point_seg_closest, poly_containing, polys_area,
};
pub use tess::circle;

/// A drill hole to subtract, in absolute millimetres.
#[derive(Clone, Copy, Debug)]
pub struct Hole {
    pub x: f64,
    pub y: f64,
    pub d: f64,
}

/// A clean simple polygon: one outer ring plus zero or more hole rings.
/// Rings are lists of `[x, y]` in absolute millimetres, Y up.
#[derive(Clone, Debug, PartialEq)]
pub struct Poly {
    pub outer: Vec<[f32; 2]>,
    pub holes: Vec<Vec<[f32; 2]>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::GerberLayer;

    // Shared Gerber fixture: a 1 mm pad flash (D10/D03) plus a 0.1 mm trace draw
    // (D11/D01). Used by region_polygons_excludes_trace_strokes and the from-layer
    // equivalence tests below.
    const PAD_AND_TRACE: &[u8] = b"%FSLAX46Y46*%\n%MOMM*%\n\
        %ADD10C,1.0*%\n%ADD11C,0.1*%\n\
        D10*\nX0Y0D03*\n\
        D11*\nX0Y0D02*\nX5000000Y0D01*\nM02*\n";

    #[test]
    fn layer_polygons_from_matches_bytes() {
        let reader = std::io::BufReader::new(std::io::Cursor::new(PAD_AND_TRACE));
        let doc = crate::gerber_parser::parse(reader).unwrap();
        let layer = GerberLayer::new(doc.into_commands());
        let from_layer = layer_polygons_from(&layer, &[]);
        let from_bytes = layer_polygons(PAD_AND_TRACE, &[]).unwrap();
        assert_eq!(
            from_layer, from_bytes,
            "layer_polygons_from must equal the bytes path"
        );
        assert!(!from_layer.is_empty(), "fixture should yield polygons");
    }

    #[test]
    fn region_polygons_from_matches_bytes() {
        let reader = std::io::BufReader::new(std::io::Cursor::new(PAD_AND_TRACE));
        let doc = crate::gerber_parser::parse(reader).unwrap();
        let layer = GerberLayer::new(doc.into_commands());
        let from_layer = region_polygons_from(&layer, &[]);
        let from_bytes = region_polygons(PAD_AND_TRACE, &[]).unwrap();
        assert_eq!(
            from_layer, from_bytes,
            "region_polygons_from must equal the bytes path"
        );
    }

    /// Two overlapping unit squares should union into a SINGLE polygon.
    #[test]
    fn two_overlapping_rects_become_one_polygon() {
        let a = vec![[0.0, 0.0], [2.0, 0.0], [2.0, 2.0], [0.0, 2.0]];
        let b = vec![[1.0, 1.0], [3.0, 1.0], [3.0, 3.0], [1.0, 3.0]];
        let polys = fill_polygons(&[a, b], &[]);
        assert_eq!(
            polys.len(),
            1,
            "overlapping rects must union to one polygon: {polys:?}"
        );
        assert!(polys[0].holes.is_empty(), "no holes expected");
        // The L-shaped union outline has 6 corners (the overlap removes 2).
        assert!(polys[0].outer.len() >= 6, "outline: {:?}", polys[0].outer);
    }

    /// Opposite-wound overlapping contours must union to a SINGLE solid polygon
    /// with no hole — the "mouse bites" bug was winding cancellation under the
    /// NonZero rule at trace/silk bends.
    #[test]
    fn opposite_wound_overlap_has_no_cancellation_hole() {
        let cw = vec![[0.0, 0.0], [0.0, 2.0], [2.0, 2.0], [2.0, 0.0]]; // clockwise
        let ccw = vec![[1.0, 1.0], [3.0, 1.0], [3.0, 3.0], [1.0, 3.0]]; // counter-clockwise
        let polys = fill_polygons(&[cw, ccw], &[]);
        assert_eq!(polys.len(), 1, "should union to one polygon: {polys:?}");
        assert!(
            polys[0].holes.is_empty(),
            "no winding-cancellation hole: {polys:?}"
        );
    }

    /// Subtracting a hole that sits fully inside a square yields one polygon
    /// with one hole ring.
    #[test]
    fn drill_hole_punches_a_hole() {
        let sq = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]];
        let polys = fill_polygons(
            &[sq],
            &[Hole {
                x: 5.0,
                y: 5.0,
                d: 2.0,
            }],
        );
        assert_eq!(polys.len(), 1, "one outer polygon expected");
        assert_eq!(polys[0].holes.len(), 1, "one hole ring expected: {polys:?}");
    }

    /// A flashed circle aperture parses end-to-end into a non-empty polygon.
    #[test]
    fn flash_circle_yields_a_polygon() {
        const FLASH_CIRCLE: &[u8] =
            b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,1.0*%\nD10*\nX0Y0D03*\nM02*\n";
        let polys = copper_polygons(FLASH_CIRCLE, &[]).unwrap();
        assert_eq!(polys.len(), 1, "expected one disc polygon: {polys:?}");
        assert!(polys[0].outer.len() >= 3);
    }

    /// Silk (a generic fill layer) must have drill holes subtracted: a flashed
    /// pad straddling a drill yields a polygon with one hole ring.
    #[test]
    fn silk_fill_subtracts_a_drill() {
        // A 4mm circle pad centred at origin, with a 1mm drill through its centre.
        const FLASH_PAD: &[u8] = b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,4.0*%\nD10*\nX0Y0D03*\nM02*\n";
        let polys = layer_polygons(
            FLASH_PAD,
            &[Hole {
                x: 0.0,
                y: 0.0,
                d: 1.0,
            }],
        )
        .unwrap();
        assert_eq!(polys.len(), 1, "one outer polygon expected: {polys:?}");
        assert_eq!(
            polys[0].holes.len(),
            1,
            "drill must cut a hole in silk fill: {polys:?}"
        );
    }

    /// Mask = board MINUS openings: a board square with a centred opening pad
    /// yields one polygon with one hole ring (the opening cut out).
    #[test]
    fn mask_difference_cuts_an_opening() {
        let board = vec![vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]]];
        // A 2mm mask opening flashed at the board centre (5,5).
        // 5mm in 2.4 format == 0050000.
        const OPENING: &[u8] =
            b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,2.0*%\nD10*\nX0050000Y0050000D03*\nM02*\n";
        let polys = mask_polygons(&board, OPENING).unwrap();
        assert_eq!(polys.len(), 1, "one mask polygon expected: {polys:?}");
        assert_eq!(
            polys[0].holes.len(),
            1,
            "opening must be cut out of the mask: {polys:?}"
        );
    }

    /// A roundrect mask opening (rect + corner circles, mixed winding) must be
    /// cut from the mask COMPLETELY — the corners used to survive (winding
    /// cancellation under NonZero) and leave dark "bites" over the pad.
    #[test]
    fn roundrect_mask_opening_subtracts_fully() {
        const RR: &[u8] = b"%FSLAX46Y46*%\n%MOMM*%\n%AMRoundRect*\n0 Rounded rectangle*\n4,1,4,$2,$3,$4,$5,$6,$7,$8,$9,$2,$3,0*\n1,1,$1+$1,$2,$3*\n1,1,$1+$1,$4,$5*\n1,1,$1+$1,$6,$7*\n1,1,$1+$1,$8,$9*\n20,1,$1+$1,$2,$3,$4,$5,0*\n20,1,$1+$1,$4,$5,$6,$7,0*\n20,1,$1+$1,$6,$7,$8,$9,0*\n20,1,$1+$1,$8,$9,$2,$3,0*\n%\n%ADD10RoundRect,0.25X0.25X0.25X-0.25X0.25X-0.25X-0.25X0.25X-0.25X0*%\nD10*\nX0Y0D03*\nM02*\n";
        let area = |r: &[[f32; 2]]| {
            let n = r.len();
            let mut s = 0.0f64;
            for i in 0..n {
                let a = r[i];
                let b = r[(i + 1) % n];
                s += a[0] as f64 * b[1] as f64 - b[0] as f64 * a[1] as f64;
            }
            s.abs() / 2.0
        };
        // The standalone pad area (copper path is already CCW-correct).
        let pad_area: f64 = layer_polygons(RR, &[])
            .unwrap()
            .iter()
            .map(|p| area(&p.outer))
            .sum();
        assert!(pad_area > 0.5, "sanity: roundrect pad has area: {pad_area}");
        // Same opening cut from a 4×4 board.
        let board = vec![vec![[-2.0, -2.0], [2.0, -2.0], [2.0, 2.0], [-2.0, 2.0]]];
        let polys = mask_polygons(&board, RR).unwrap();
        assert_eq!(polys.len(), 1, "one mask polygon: {polys:?}");
        let hole_area: f64 = polys[0].holes.iter().map(|h| area(h)).sum();
        assert!(
            hole_area > pad_area * 0.95,
            "opening under-cut (corners survived): hole={hole_area} pad={pad_area}",
        );
    }

    /// Mask with no openings = the whole board is masked (one polygon, no holes).
    #[test]
    fn mask_with_no_openings_is_full_board() {
        let board = vec![vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]]];
        const EMPTY: &[u8] = b"%FSLAX24Y24*%\n%MOMM*%\nM02*\n";
        let polys = mask_polygons(&board, EMPTY).unwrap();
        assert_eq!(polys.len(), 1, "full board polygon expected: {polys:?}");
        assert!(
            polys[0].holes.is_empty(),
            "no openings → no holes: {polys:?}"
        );
    }

    #[test]
    fn polys_area_counts_outer_minus_holes() {
        let sq = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]];
        let solid = fill_polygons(std::slice::from_ref(&sq), &[]);
        assert!(
            (polys_area(&solid) - 100.0).abs() < 0.01,
            "10×10 = 100: {}",
            polys_area(&solid)
        );
        // A 2mm drill removes ~π mm².
        let drilled = fill_polygons(
            &[sq],
            &[Hole {
                x: 5.0,
                y: 5.0,
                d: 2.0,
            }],
        );
        assert!((polys_area(&drilled) - (100.0 - std::f64::consts::PI)).abs() < 0.1);
    }

    // A 2mm-long straight trace (two collinear 1mm segments) of width 1mm:
    // union area ~= 2*1 (body) + pi*0.5^2 (the two end half-caps = one circle) ~= 2.785 mm^2.
    const STRAIGHT_TRACE: &[u8] =
        b"%FSLAX46Y46*%\n%MOMM*%\n%ADD10C,1.000000*%\nD10*\nX0Y0D02*\nX1000000Y0D01*\nX2000000Y0D01*\nM02*\n";

    #[test]
    fn coalesced_straight_trace_area_matches_capsule() {
        let polys = layer_polygons(STRAIGHT_TRACE, &[]).unwrap();
        let area = polys_area(&polys);
        let expected = 2.0 + std::f64::consts::PI * 0.25;
        assert!(
            (area - expected).abs() < 0.05,
            "area={area}, expected~{expected}"
        );
    }

    #[test]
    fn containment_and_point_to_boundary() {
        let polys = fill_polygons(
            &[vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]]],
            &[],
        );
        let hit = poly_containing(&polys, [5.0, 5.0]).expect("centre is inside");
        assert!(
            (point_ring_closest([5.0, 5.0], &hit.outer).1 - 5.0).abs() < 0.01,
            "centre is 5mm from edges"
        );
        assert!(
            poly_containing(&polys, [20.0, 20.0]).is_none(),
            "outside point not contained"
        );
    }
}

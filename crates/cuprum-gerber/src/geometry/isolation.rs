//! Isolation-milling path geometry and V-bit cut-width model.
//!
//! Isolation milling clears the copper *around* the conductors with a small
//! end-mill (cylindrical) or a V-shaped engraving bit, leaving the traces
//! standing. The toolpaths are concentric offset rings around every copper
//! body: pass 0 runs with the tool edge tangent to the copper edge (its centre
//! offset out by half the cut width), and each further pass steps outward by
//! `cut_width * (1 - overlap)` to widen the cleared gap.
//!
//! This module produces ONLY the path geometry as [`Poly`] rings (one ring per
//! offset body per pass). It does not emit G-code, depth control, or ordering —
//! those belong to later phases. Output is new and does not feed the
//! svg/metrics/mesh/preview disk-cache tiers, so no version tag is bumped.
//!
//! For a V-bit the effective cut width depends on how deep it plunges (a deeper
//! cut is wider), so the caller computes it with [`vbit_cut_width`]; a
//! cylindrical mill just passes its diameter as the cut width directly.

use i_overlay::mesh::outline::offset::OutlineOffset;
use i_overlay::mesh::style::{LineJoin, OutlineStyle};

use super::tess::to_ccw;
use super::{shapes_to_polys, Poly};

/// Effective cut width of a V-shaped engraving bit at a given plunge depth.
///
/// A V-bit removes a triangular kerf: at depth `d` with full tip angle `2a` the
/// half-width is `d * tan(a)`, plus any flat at the very tip (`tip_flat_mm`, the
/// ground tip width). So the full cut width is
/// `2 * d * tan(angle/2) + tip_flat`. Deeper cuts are wider; a cylindrical mill
/// does not use this — it passes its diameter as the cut width directly.
pub fn vbit_cut_width(depth_mm: f64, tip_angle_deg: f64, tip_flat_mm: f64) -> f64 {
    2.0 * depth_mm * (tip_angle_deg.to_radians() / 2.0).tan() + tip_flat_mm
}

/// Build concentric isolation-milling toolpaths around copper bodies.
///
/// For `passes` concentric passes, each copper body is offset outward by
///
/// ```text
/// offset_i = (2*i + 1)/2 * cut_width - i * overlap * cut_width
/// ```
///
/// so pass 0 sits half a cut-width out (tool edge tangent to copper), and the
/// step between passes is `cut_width * (1 - overlap)`. All copper bodies are
/// offset together in one call so that rings from neighbouring conductors that
/// run into each other are merged by the offset solver (a wide pass over a
/// narrow gap fuses — the bit cannot fit, which Phase 2 will flag).
///
/// `climb` selects the cut direction: `true` (climb) keeps the natural offset
/// winding; `false` (conventional) reverses every output contour. FlatCAM uses
/// conventional milling on the copper edge by reversing the path order
/// (`FlatCAMObj.py:533-549`). MVP keeps it coarse: conventional reverses ALL
/// outer rings of ALL passes. TODO: FlatCAM only reverses the innermost
/// (edge-adjacent) pass; per-pass direction is left for a later phase.
///
/// Returns all passes' rings, ordered pass 0..N (inner to outer). Empty copper
/// or `passes == 0` yields an empty vector; a pass that degenerates to nothing
/// is skipped without panicking.
pub fn isolation_paths(
    copper: &[Poly],
    cut_width: f64,
    passes: u32,
    overlap: f64,
    climb: bool,
) -> Vec<Poly> {
    if copper.is_empty() || passes == 0 || cut_width <= 0.0 {
        return Vec::new();
    }

    // All copper bodies as one multi-body shape set so overlapping offsets fuse.
    // i_overlay wants outer rings CCW and holes CW; Poly.outer is already CCW.
    let bodies: Vec<Vec<Vec<[f64; 2]>>> = copper
        .iter()
        .map(|p| {
            let mut shape: Vec<Vec<[f64; 2]>> = Vec::with_capacity(1 + p.holes.len());
            shape.push(to_ccw(ring_to_f64(&p.outer)));
            for h in &p.holes {
                shape.push(to_cw(ring_to_f64(h)));
            }
            shape
        })
        .collect();

    // `LineJoin::Round(x)` is the max arc-step ANGLE in radians (i_overlay clamps
    // it to [0.01·π, 0.25·π]), not a distance. ~9° keeps corner arcs smooth while
    // emitting few facets; chord error at the largest offsets stays well under a
    // few microns.
    let arc_step_rad = std::f64::consts::PI * 0.05;

    let mut out: Vec<Poly> = Vec::new();
    for i in 0..passes {
        let offset_i = (2.0 * i as f64 + 1.0) / 2.0 * cut_width - i as f64 * overlap * cut_width;
        if offset_i <= 0.0 {
            continue;
        }
        let style = OutlineStyle::new(offset_i).line_join(LineJoin::Round(arc_step_rad));
        let shapes = bodies.outline(&style);
        let mut polys = shapes_to_polys(shapes);
        if !climb {
            // Conventional milling: reverse the traversal of every contour.
            for poly in &mut polys {
                poly.outer.reverse();
                for hole in &mut poly.holes {
                    hole.reverse();
                }
            }
        }
        out.append(&mut polys);
    }
    out
}

fn ring_to_f64(ring: &[[f32; 2]]) -> Vec<[f64; 2]> {
    ring.iter().map(|&[x, y]| [x as f64, y as f64]).collect()
}

/// Reverse a ring if it's counter-clockwise, so it ends up clockwise (hole).
fn to_cw(mut ring: Vec<[f64; 2]>) -> Vec<[f64; 2]> {
    let mut s = 0.0;
    let n = ring.len();
    for i in 0..n {
        let a = ring[i];
        let b = ring[(i + 1) % n];
        s += a[0] * b[1] - b[0] * a[1];
    }
    if s > 0.0 {
        ring.reverse();
    }
    ring
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit_square(side: f64) -> Poly {
        Poly {
            outer: vec![
                [0.0, 0.0],
                [side as f32, 0.0],
                [side as f32, side as f32],
                [0.0, side as f32],
            ],
            holes: Vec::new(),
        }
    }

    fn square_at(x: f64, y: f64, side: f64) -> Poly {
        let (x, y, s) = (x as f32, y as f32, side as f32);
        Poly {
            outer: vec![[x, y], [x + s, y], [x + s, y + s], [x, y + s]],
            holes: Vec::new(),
        }
    }

    fn bbox(polys: &[Poly]) -> (f32, f32, f32, f32) {
        let mut min_x = f32::MAX;
        let mut min_y = f32::MAX;
        let mut max_x = f32::MIN;
        let mut max_y = f32::MIN;
        for p in polys {
            for &[x, y] in &p.outer {
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
            }
        }
        (min_x, min_y, max_x, max_y)
    }

    fn outer_bbox(poly: &Poly) -> (f32, f32, f32, f32) {
        bbox(std::slice::from_ref(poly))
    }

    #[test]
    fn vbit_cut_width_90deg() {
        // 90deg full angle, half-angle 45deg, tan(45)=1 → 2*0.05*1 = 0.1.
        let w = vbit_cut_width(0.05, 90.0, 0.0);
        assert!((w - 0.1).abs() < 1e-9, "w={w}");
    }

    #[test]
    fn vbit_cut_width_tip_flat_offsets() {
        let base = vbit_cut_width(0.05, 90.0, 0.0);
        let flat = vbit_cut_width(0.05, 90.0, 0.03);
        assert!((flat - base - 0.03).abs() < 1e-9, "flat={flat} base={base}");
    }

    #[test]
    fn single_pass_ring_grows_bbox_by_half_cut_width() {
        let copper = vec![unit_square(1.0)];
        let cut = 0.2;
        let paths = isolation_paths(&copper, cut, 1, 0.0, true);
        assert_eq!(paths.len(), 1, "one offset body expected: {paths:?}");
        // Pass 0 offset = cut/2 = 0.1 outward on every side.
        let (min_x, min_y, max_x, max_y) = outer_bbox(&paths[0]);
        let tol = 0.02; // corner rounding
        assert!((min_x - (-0.1)).abs() < tol, "min_x={min_x}");
        assert!((min_y - (-0.1)).abs() < tol, "min_y={min_y}");
        assert!((max_x - 1.1).abs() < tol, "max_x={max_x}");
        assert!((max_y - 1.1).abs() < tol, "max_y={max_y}");
    }

    #[test]
    fn three_passes_grow_by_cut_width_each() {
        let copper = vec![unit_square(1.0)];
        let cut = 0.2;
        let paths = isolation_paths(&copper, cut, 3, 0.0, true);
        assert_eq!(paths.len(), 3, "three rings expected: {paths:?}");
        // Outward extent per pass: cut/2, 3cut/2, 5cut/2 = 0.1, 0.3, 0.5.
        let tol = 0.03;
        for (i, expect) in [0.1f32, 0.3, 0.5].iter().enumerate() {
            let (_, _, max_x, _) = outer_bbox(&paths[i]);
            assert!(
                (max_x - (1.0 + expect)).abs() < tol,
                "pass {i}: max_x={max_x} expect={}",
                1.0 + expect
            );
        }
    }

    #[test]
    fn overlap_shrinks_pass_step() {
        let copper = vec![unit_square(1.0)];
        let cut = 0.2;
        let overlap = 0.25;
        let paths = isolation_paths(&copper, cut, 3, overlap, true);
        assert_eq!(paths.len(), 3);
        // step = cut * (1 - overlap) = 0.15; offsets 0.1, 0.25, 0.4.
        let tol = 0.03;
        for (i, expect) in [0.1f32, 0.25, 0.4].iter().enumerate() {
            let (_, _, max_x, _) = outer_bbox(&paths[i]);
            assert!(
                (max_x - (1.0 + expect)).abs() < tol,
                "pass {i}: max_x={max_x} expect={}",
                1.0 + expect
            );
        }
    }

    #[test]
    fn empty_copper_yields_empty() {
        assert!(isolation_paths(&[], 0.2, 3, 0.0, true).is_empty());
    }

    #[test]
    fn zero_passes_yields_empty() {
        let copper = vec![unit_square(1.0)];
        assert!(isolation_paths(&copper, 0.2, 0, 0.0, true).is_empty());
    }

    #[test]
    fn conventional_reverses_winding_vs_climb() {
        let copper = vec![unit_square(1.0)];
        let cut = 0.2;
        let climb = isolation_paths(&copper, cut, 1, 0.0, true);
        let conv = isolation_paths(&copper, cut, 1, 0.0, false);
        assert_eq!(climb.len(), 1);
        assert_eq!(conv.len(), 1);
        // Same geometry, opposite traversal: the outer ring is the reverse.
        let mut conv_rev = conv[0].outer.clone();
        conv_rev.reverse();
        assert_eq!(
            conv_rev, climb[0].outer,
            "conventional outer must be the reverse of climb"
        );
    }

    /// Two copper squares closer than one cut width: their pass-0 offset rings
    /// run into each other and the solver merges them into a SINGLE body. This
    /// documents the "bit can't fit the gap" behaviour (detection is Phase 2).
    #[test]
    fn close_squares_offset_rings_merge() {
        // Two 1x1 squares with a 0.1mm gap; cut 0.2 → each side offsets 0.1, the
        // two pass-0 rings touch/overlap in the gap and fuse.
        let copper = vec![square_at(0.0, 0.0, 1.0), square_at(1.1, 0.0, 1.0)];
        let merged = isolation_paths(&copper, 0.2, 1, 0.0, true);
        assert_eq!(
            merged.len(),
            1,
            "close squares must fuse into one offset body: {merged:?}"
        );
        // Far apart (2mm gap) they stay separate.
        let copper_far = vec![square_at(0.0, 0.0, 1.0), square_at(3.0, 0.0, 1.0)];
        let separate = isolation_paths(&copper_far, 0.2, 1, 0.0, true);
        assert_eq!(separate.len(), 2, "far squares stay separate: {separate:?}");
    }
}

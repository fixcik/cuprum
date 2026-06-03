//! 2D polygon boolean geometry for copper layers.
//!
//! The frontend used to do the expensive copper boolean work (union of all
//! pad/pour fills, then subtract drill holes) in single-threaded JS with
//! `polygon-clipping`, which THROWS "Unable to complete output ring" on a
//! self-touching ground pour and wipes the whole layer. We move that work here,
//! into Rust, using `i_overlay` (robust to self-intersection).
//!
//! This walks the SAME `gerber_viewer::GerberPrimitive` enum as [`crate::svg`]
//! (read that module for the parse + arc-tessellation conventions): coordinates
//! are absolute millimetres, Y up. Output is a set of CLEAN, simple,
//! non-overlapping filled polygons (outer ring + holes).
//!
//! Scope is COPPER only for now, but [`fill_polygons`] is layer-agnostic
//! (Add-only union + hole subtraction), so it can serve other layers later.

use anyhow::Result;
use gerber_viewer::{GerberLayer, GerberPrimitive};
use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::overlay::FloatOverlay;

/// Arc tessellation steps — matches the visual fidelity of [`crate::svg`].
const ARC_STEPS: usize = 64;
/// Sides for a circle / round line-cap approximation.
const CIRCLE_SEGS: usize = 32;

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

/// Compute clean filled polygons from raw gerber bytes and drill holes, for ANY
/// generic fill layer (copper, silk, paste, other). They all share the same
/// path: union the primitive contours, then subtract the drill holes (so holes
/// cut the silk, pour, etc.).
///
/// 1. Parse like [`crate::svg`] (`parse` → `GerberLayer::new` → `primitives()`).
/// 2. Convert every primitive to one or more solid contours (Add-only).
/// 3. Union all contours into clean, non-self-intersecting shapes.
/// 4. Subtract the drill holes.
///
/// Returns outer-ring + holes polygons ready to triangulate on the frontend.
#[tracing::instrument(skip_all, fields(holes = holes.len()))]
pub fn layer_polygons(bytes: &[u8], holes: &[Hole]) -> Result<Vec<Poly>> {
    // Shared cross-operation parse: metrics/mesh/SVG reuse one parsed layer.
    let layer = crate::gerber::parse_layer_cached(bytes)?;
    Ok(layer_polygons_from(&layer, holes))
}

/// Like [`layer_polygons`] but from an already-parsed layer — used by callers that
/// parse each layer once and share it across analyses (see `metrics`'s parse-once).
pub fn layer_polygons_from(layer: &GerberLayer, holes: &[Hole]) -> Vec<Poly> {
    let contours = contours_of(layer.primitives());
    fill_polygons(&contours, holes)
}

/// Backwards-compatible alias for the original copper-only entry point. Copper
/// is just a generic fill layer, so this forwards to [`layer_polygons`].
#[tracing::instrument(skip_all, fields(holes = holes.len()))]
pub fn copper_polygons(bytes: &[u8], holes: &[Hole]) -> Result<Vec<Poly>> {
    layer_polygons(bytes, holes)
}

/// Like [`layer_polygons`] but from FILL primitives only — flashes (Circle,
/// Rectangle, Polygon) and region fills (G36) — skipping routed strokes
/// (Line/Arc). The copper-WIDTH (neck) check runs on THIS set: a trace's width is
/// its aperture (measured via the conductor model), so unioning trace strokes and
/// cross-measuring their concave bends only produced artefacts. Genuine necks live
/// in zone fills, which this preserves.
#[tracing::instrument(skip_all, fields(holes = holes.len()))]
pub fn region_polygons(bytes: &[u8], holes: &[Hole]) -> Result<Vec<Poly>> {
    // Shared cross-operation parse: metrics/mesh/SVG reuse one parsed layer.
    let layer = crate::gerber::parse_layer_cached(bytes)?;
    Ok(region_polygons_from(&layer, holes))
}

/// Like [`region_polygons`] (FILL primitives only) but from an already-parsed layer.
pub fn region_polygons_from(layer: &GerberLayer, holes: &[Hole]) -> Vec<Poly> {
    let mut contours: Vec<Vec<[f64; 2]>> = Vec::new();
    for prim in layer.primitives() {
        if matches!(prim, GerberPrimitive::Line(_) | GerberPrimitive::Arc(_)) {
            continue;
        }
        contours_for(prim, &mut contours);
    }
    fill_polygons(&contours, holes)
}

/// Compute the soldermask geometry: the board region MINUS the mask openings.
///
/// The board outline (a set of CCW/CW rings — outer perimeter plus inner
/// cutouts) is stitched on the frontend from Edge_Cuts (see
/// `cuprum-ui/src/lib/boardOutline.ts`) and passed in as `outline_rings`. We do
/// NOT re-implement Edge_Cuts stitching here.
///
/// The mask gerber's primitives are the openings (where there is NO mask, e.g.
/// exposed pads). We build them as solid contours and subtract them from the
/// board, so the result is the green soldermask film with the pad openings cut
/// out — `difference(board_outline, openings)`.
#[tracing::instrument(skip_all, fields(rings = outline_rings.len()))]
pub fn mask_polygons(outline_rings: &[Vec<[f64; 2]>], mask_bytes: &[u8]) -> Result<Vec<Poly>> {
    let board: Vec<Vec<[f64; 2]>> = outline_rings
        .iter()
        .filter(|r| r.len() >= 3)
        .cloned()
        .collect();
    if board.is_empty() {
        return Ok(Vec::new());
    }

    // Shared cross-operation parse: metrics/mesh/SVG reuse one parsed layer.
    let layer = crate::gerber::parse_layer_cached(mask_bytes)?;
    // Normalize every opening contour to CCW before the difference. An opening
    // (e.g. a roundrect pad = rect + corner circles) is built from several
    // primitives of mixed winding; under NonZero they cancel to winding 0 at the
    // overlaps (pad corners), so that area isn't part of the clip and is NOT cut
    // out → the mask covers the pad corners (dark "bites"). All-CCW makes each
    // opening a solid clip that subtracts fully. (Same root cause as the copper
    // "mouse bites" — see fill_polygons.)
    let openings: Vec<Vec<[f64; 2]>> = contours_of(layer.primitives())
        .into_iter()
        .map(to_ccw)
        .collect();

    // No openings → the whole board is masked.
    let shapes = if openings.is_empty() {
        FloatOverlay::with_subj(&board).overlay(OverlayRule::Subject, FillRule::NonZero)
    } else {
        FloatOverlay::with_subj_and_clip(&board, &openings)
            .overlay(OverlayRule::Difference, FillRule::NonZero)
    };

    Ok(shapes_to_polys(shapes))
}

/// Build clean polygons from a set of (possibly overlapping / self-touching)
/// solid contours and a set of drill holes to subtract. Layer-agnostic so
/// other layers can reuse it.
#[tracing::instrument(skip_all, fields(contours = contours.len()))]
pub fn fill_polygons(contours: &[Vec<[f64; 2]>], holes: &[Hole]) -> Vec<Poly> {
    if contours.is_empty() {
        return Vec::new();
    }

    // Normalize every contour to CCW first. The stroke rectangles in
    // `push_stroke` get a direction-dependent winding (a rightward segment is CW,
    // a leftward one CCW); under `FillRule::NonZero` two opposite-wound rectangles
    // overlapping at a trace BEND cancel to winding 0 and leave a triangular notch
    // ("mouse bites"). Forcing all contours CCW makes overlaps accumulate winding
    // (>=1) so the whole covered area fills. (All contours are additive here —
    // the vendored gerber-viewer emits no clear-polarity — so there are no
    // intended winding-holes to preserve; drills are subtracted separately.)
    let subj: Vec<Vec<[f64; 2]>> = contours.iter().map(|c| to_ccw(c.clone())).collect();

    // Union all subject contours: resolves the self-touching pour and overlaps
    // into a set of clean shapes (each shape = outer contour + inner holes).
    let union = FloatOverlay::with_subj(&subj).overlay(OverlayRule::Subject, FillRule::NonZero);

    let shapes = if holes.is_empty() {
        union
    } else {
        let drills: Vec<Vec<[f64; 2]>> = holes
            .iter()
            .filter(|h| h.d > 0.0)
            .map(|h| circle(h.x, h.y, h.d / 2.0, CIRCLE_SEGS))
            .collect();
        if drills.is_empty() {
            union
        } else {
            FloatOverlay::with_subj_and_clip(&union, &drills)
                .overlay(OverlayRule::Difference, FillRule::NonZero)
        }
    };

    shapes_to_polys(shapes)
}

/// Convert i_overlay output shapes into our [`Poly`] DTO.
///
/// i_overlay shapes: `Vec<Shape>`, `Shape = Vec<Contour>`, `Contour = Vec<[f64;2]>`.
/// The first contour of each shape is its outer ring; the rest are holes.
pub(crate) fn shapes_to_polys(shapes: Vec<Vec<Vec<[f64; 2]>>>) -> Vec<Poly> {
    shapes
        .into_iter()
        .filter_map(|shape| {
            let mut rings = shape.into_iter();
            let outer = rings.next()?;
            if outer.len() < 3 {
                return None;
            }
            Some(Poly {
                outer: to_f32(outer),
                holes: rings.filter(|r| r.len() >= 3).map(to_f32).collect(),
            })
        })
        .collect()
}

fn to_f32(ring: Vec<[f64; 2]>) -> Vec<[f32; 2]> {
    ring.into_iter()
        .map(|[x, y]| [x as f32, y as f32])
        .collect()
}

/// Shoelace signed area; positive = counter-clockwise.
fn signed_area(ring: &[[f64; 2]]) -> f64 {
    let n = ring.len();
    let mut s = 0.0;
    for i in 0..n {
        let a = ring[i];
        let b = ring[(i + 1) % n];
        s += a[0] * b[1] - b[0] * a[1];
    }
    s / 2.0
}

/// Reverse a ring if it's clockwise, so it ends up counter-clockwise.
fn to_ccw(mut ring: Vec<[f64; 2]>) -> Vec<[f64; 2]> {
    if signed_area(&ring) < 0.0 {
        ring.reverse();
    }
    ring
}

/// Emit the solid contour(s) for ONE primitive (Add-only) into `out`.
fn contours_for(prim: &GerberPrimitive, out: &mut Vec<Vec<[f64; 2]>>) {
    match prim {
        GerberPrimitive::Circle(c) => {
            out.push(circle(
                c.center.x,
                c.center.y,
                c.diameter / 2.0,
                CIRCLE_SEGS,
            ));
        }
        GerberPrimitive::Rectangle(r) => {
            let (x, y, w, h) = (r.origin.x, r.origin.y, r.width, r.height);
            out.push(vec![[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
        }
        GerberPrimitive::Polygon(poly) => {
            out.push(
                poly.geometry
                    .relative_vertices
                    .iter()
                    .map(|v| [poly.center.x + v.x, poly.center.y + v.y])
                    .collect(),
            );
        }
        GerberPrimitive::Line(l) => {
            push_stroke(out, l.start.x, l.start.y, l.end.x, l.end.y, l.width / 2.0);
        }
        GerberPrimitive::Arc(a) => {
            let half = a.width / 2.0;
            let mut prev: Option<(f64, f64)> = None;
            for i in 0..=ARC_STEPS {
                let t = i as f64 / ARC_STEPS as f64;
                let ang = a.start_angle + a.sweep_angle * t;
                let pt = (
                    a.center.x + a.radius * ang.cos(),
                    a.center.y + a.radius * ang.sin(),
                );
                if let Some((px, py)) = prev {
                    push_stroke(out, px, py, pt.0, pt.1, half);
                } else {
                    out.push(circle(pt.0, pt.1, half, CIRCLE_SEGS));
                }
                out.push(circle(pt.0, pt.1, half, CIRCLE_SEGS));
                prev = Some(pt);
            }
        }
    }
}

/// Convert every primitive to one or more solid contours, treating all as Add
/// (v1: clear-polarity is not produced by the vendored gerber-viewer anyway —
/// see the note in [`crate::svg`]).
///
/// Line primitives are first coalesced into polylines by [`crate::strokes`] so
/// that each run emits one rect per segment plus one circle per vertex (round
/// joins + end caps) rather than two full circles per segment endpoint.
fn contours_of(prims: &[GerberPrimitive]) -> Vec<Vec<[f64; 2]>> {
    use crate::strokes::{coalesce_strokes, Run};
    let mut contours: Vec<Vec<[f64; 2]>> = Vec::new();
    for run in coalesce_strokes(prims) {
        match run {
            Run::Polyline { width, pts, .. } => {
                push_polyline_stroke(&mut contours, &pts, width / 2.0);
            }
            Run::Flash(prim) => contours_for(prim, &mut contours),
        }
    }
    contours
}

/// Stroke a polyline (>=2 points) of half-width `half` into solid contours:
/// one offset rectangle per segment + one full circle at EACH vertex (round
/// join at interior vertices, round cap at the two ends). Replaces the old
/// per-segment "rect + 2 circles", which duplicated a full circle at every
/// shared joint and bloated the union input.
fn push_polyline_stroke(out: &mut Vec<Vec<[f64; 2]>>, pts: &[[f64; 2]], half: f64) {
    for w in pts.windows(2) {
        let (ax, ay, bx, by) = (w[0][0], w[0][1], w[1][0], w[1][1]);
        let (dx, dy) = (bx - ax, by - ay);
        let len = (dx * dx + dy * dy).sqrt();
        if len >= 1e-9 {
            let (nx, ny) = (-dy / len * half, dx / len * half);
            out.push(vec![
                [ax + nx, ay + ny],
                [bx + nx, by + ny],
                [bx - nx, by - ny],
                [ax - nx, ay - ny],
            ]);
        }
    }
    for p in pts {
        out.push(circle(p[0], p[1], half, CIRCLE_SEGS));
    }
}

/// A stroked segment (offset rect by `half` on each side) plus round caps at
/// both endpoints, so a stroked line/trace becomes solid contours.
fn push_stroke(out: &mut Vec<Vec<[f64; 2]>>, ax: f64, ay: f64, bx: f64, by: f64, half: f64) {
    let (dx, dy) = (bx - ax, by - ay);
    let len = (dx * dx + dy * dy).sqrt();
    if len >= 1e-9 {
        let (nx, ny) = (-dy / len * half, dx / len * half);
        out.push(vec![
            [ax + nx, ay + ny],
            [bx + nx, by + ny],
            [bx - nx, by - ny],
            [ax - nx, ay - ny],
        ]);
    }
    out.push(circle(ax, ay, half, CIRCLE_SEGS));
    out.push(circle(bx, by, half, CIRCLE_SEGS));
}

/// A `segs`-gon approximating a circle, CCW.
pub(crate) fn circle(cx: f64, cy: f64, r: f64, segs: usize) -> Vec<[f64; 2]> {
    (0..segs)
        .map(|i| {
            let a = (i as f64) / (segs as f64) * std::f64::consts::TAU;
            [cx + r * a.cos(), cy + r * a.sin()]
        })
        .collect()
}

/// Total filled area of a polygon set (Σ|outer| − Σ|holes|), mm².
pub fn polys_area(polys: &[Poly]) -> f64 {
    polys
        .iter()
        .map(|p| {
            ring_area_f32(&p.outer).abs()
                - p.holes.iter().map(|h| ring_area_f32(h).abs()).sum::<f64>()
        })
        .sum()
}

fn ring_area_f32(ring: &[[f32; 2]]) -> f64 {
    let n = ring.len();
    if n < 3 {
        return 0.0;
    }
    let mut s = 0.0;
    for i in 0..n {
        let a = ring[i];
        let b = ring[(i + 1) % n];
        s += a[0] as f64 * b[1] as f64 - b[0] as f64 * a[1] as f64;
    }
    s / 2.0
}

/// Closest point on segment `ab` to `p`, plus the distance.
#[inline]
pub(crate) fn point_seg_closest(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> ([f64; 2], f64) {
    let (abx, aby) = (b[0] - a[0], b[1] - a[1]);
    let len2 = abx * abx + aby * aby;
    let t = if len2 <= 0.0 {
        0.0
    } else {
        (((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2).clamp(0.0, 1.0)
    };
    let q = [a[0] + t * abx, a[1] + t * aby];
    (q, ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2)).sqrt())
}

/// Ray-cast point-in-ring test (ring in f32, point in f64 mm).
#[inline]
pub(crate) fn point_in_ring(p: [f64; 2], ring: &[[f32; 2]]) -> bool {
    let n = ring.len();
    if n < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = (ring[i][0] as f64, ring[i][1] as f64);
        let (xj, yj) = (ring[j][0] as f64, ring[j][1] as f64);
        if (yi > p[1]) != (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// The polygon whose outer ring contains `p` and whose holes don't (i.e. p is
/// in solid copper). Used to associate a drill with its pad.
pub(crate) fn poly_containing(polys: &[Poly], p: [f64; 2]) -> Option<&Poly> {
    polys.iter().find(|poly| {
        point_in_ring(p, &poly.outer) && !poly.holes.iter().any(|h| point_in_ring(p, h))
    })
}

/// Closest point on a ring's boundary to `p`, plus the distance.
pub(crate) fn point_ring_closest(p: [f64; 2], ring: &[[f32; 2]]) -> ([f64; 2], f64) {
    let n = ring.len();
    if n < 2 {
        return (p, f64::INFINITY);
    }
    let mut best = (p, f64::INFINITY);
    for i in 0..n {
        let a = ring[i];
        let b = ring[(i + 1) % n];
        let (q, d) = point_seg_closest(p, [a[0] as f64, a[1] as f64], [b[0] as f64, b[1] as f64]);
        if d < best.1 {
            best = (q, d);
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let doc = gerber_viewer::gerber_parser::parse(reader).unwrap();
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
        let doc = gerber_viewer::gerber_parser::parse(reader).unwrap();
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

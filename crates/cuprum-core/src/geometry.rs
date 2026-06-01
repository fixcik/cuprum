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

use anyhow::{anyhow, Result};
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
    let reader = std::io::BufReader::new(std::io::Cursor::new(bytes));
    let doc = gerber_viewer::gerber_parser::parse(reader)
        .map_err(|(_doc, e)| anyhow!("parse error: {e:?}"))?;
    let layer = GerberLayer::new(doc.into_commands());
    let contours = contours_of(layer.primitives());
    Ok(fill_polygons(&contours, holes))
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
    let reader = std::io::BufReader::new(std::io::Cursor::new(bytes));
    let doc = gerber_viewer::gerber_parser::parse(reader)
        .map_err(|(_doc, e)| anyhow!("parse error: {e:?}"))?;
    let layer = GerberLayer::new(doc.into_commands());
    let mut contours: Vec<Vec<[f64; 2]>> = Vec::new();
    for prim in layer.primitives() {
        if matches!(prim, GerberPrimitive::Line(_) | GerberPrimitive::Arc(_)) {
            continue;
        }
        contours_for(prim, &mut contours);
    }
    Ok(fill_polygons(&contours, holes))
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

    let reader = std::io::BufReader::new(std::io::Cursor::new(mask_bytes));
    let doc = gerber_viewer::gerber_parser::parse(reader)
        .map_err(|(_doc, e)| anyhow!("parse error: {e:?}"))?;
    let layer = GerberLayer::new(doc.into_commands());
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
fn contours_of(prims: &[GerberPrimitive]) -> Vec<Vec<[f64; 2]>> {
    let mut contours: Vec<Vec<[f64; 2]>> = Vec::new();
    for prim in prims {
        contours_for(prim, &mut contours);
    }
    contours
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

// ---- DFM measurement geometry (areas, distances, containment) ----
//
// These power the geometric feasibility checks (min clearance, copper width,
// annular ring, mask dam, copper coverage). They MEASURE — no thresholds — so
// the result is profile-independent and cacheable; the frontend judges it.

/// Grid resolution for the nearest-edge sweep: cell ≈ board_diag / this.
const DIST_CELLS: f64 = 220.0;
/// Safety cap on segment-pair comparisons (real boards stay well under it).
const DIST_BUDGET: u64 = 120_000_000;

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

fn orient(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> f64 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

/// Do segments `ab` and `cd` properly cross? (Distance 0 when they do.)
fn segs_cross(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> bool {
    let (d1, d2, d3, d4) = (
        orient(c, d, a),
        orient(c, d, b),
        orient(a, b, c),
        orient(a, b, d),
    );
    ((d1 > 0.0) != (d2 > 0.0)) && ((d3 > 0.0) != (d4 > 0.0))
}

/// Closest point on segment `ab` to `p`, plus the distance.
fn point_seg_closest(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> ([f64; 2], f64) {
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

/// Proper intersection point of segments `ab` and `cd`, if they cross.
fn segs_intersection(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> Option<[f64; 2]> {
    if !segs_cross(a, b, c, d) {
        return None;
    }
    let r = [b[0] - a[0], b[1] - a[1]];
    let s = [d[0] - c[0], d[1] - c[1]];
    let rxs = r[0] * s[1] - r[1] * s[0];
    if rxs.abs() < 1e-12 {
        return None;
    }
    let t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / rxs;
    Some([a[0] + t * r[0], a[1] + t * r[1]])
}

/// The two closest points (one on each segment) and their distance.
fn seg_seg_closest(
    a: [f64; 2],
    b: [f64; 2],
    c: [f64; 2],
    d: [f64; 2],
) -> ([f64; 2], [f64; 2], f64) {
    if let Some(x) = segs_intersection(a, b, c, d) {
        return (x, x, 0.0);
    }
    // Parallel + overlapping projection: the closest pair is a whole interval,
    // and the naive 4-endpoint scan below picks a CORNER of it. Return the MIDDLE
    // of the overlap instead — geometrically the representative point of a neck or
    // gap (so its midpoint lands in copper / in the void, which the neck/bay
    // filter relies on), and where a marker should sit.
    let r = [b[0] - a[0], b[1] - a[1]];
    let s = [d[0] - c[0], d[1] - c[1]];
    let len2 = r[0] * r[0] + r[1] * r[1];
    let cross = r[0] * s[1] - r[1] * s[0];
    let slen = (s[0] * s[0] + s[1] * s[1]).sqrt();
    if len2 > 1e-18 && cross.abs() <= 1e-7 * len2.sqrt() * slen {
        let tc = ((c[0] - a[0]) * r[0] + (c[1] - a[1]) * r[1]) / len2;
        let td = ((d[0] - a[0]) * r[0] + (d[1] - a[1]) * r[1]) / len2;
        let lo = tc.min(td).max(0.0);
        let hi = tc.max(td).min(1.0);
        if lo <= hi {
            let tm = (lo + hi) / 2.0;
            let pab = [a[0] + tm * r[0], a[1] + tm * r[1]];
            let (pcd, dist) = point_seg_closest(pab, c, d);
            return (pab, pcd, dist);
        }
    }
    let (q1, d1) = point_seg_closest(c, a, b);
    let (q2, d2) = point_seg_closest(d, a, b);
    let (q3, d3) = point_seg_closest(a, c, d);
    let (q4, d4) = point_seg_closest(b, c, d);
    let mut best = (q1, c, d1);
    if d2 < best.2 {
        best = (q2, d, d2);
    }
    if d3 < best.2 {
        best = (a, q3, d3);
    }
    if d4 < best.2 {
        best = (b, q4, d4);
    }
    best
}

/// Ray-cast point-in-ring test (ring in f32, point in f64 mm).
fn point_in_ring(p: [f64; 2], ring: &[[f32; 2]]) -> bool {
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

/// One boundary edge, tagged for cross-polygon vs same-ring-adjacency tests.
struct GEdge {
    a: [f64; 2],
    b: [f64; 2],
    poly: u32,
    ring: u32,
    idx: u32,
    n: u32,
}

/// Max deviation (mm) at which a vertex is treated as polygon noise and dropped
/// before the clearance/width sweep. Well under the artefact floor (50 µm), so
/// only sub-resolution tessellation/boolean-op noise is removed — never a real
/// feature.
const SIMPLIFY_TOL_MM: f64 = 0.01;

/// Minimum length (mm) of BOTH edges bounding a clearance/width hotspot. A real
/// thin gap or copper neck runs at least this far; a point-notch from aperture-
/// macro / tessellation seams is bounded by a tiny chord (~the arc segment),
/// which falls below this and is rejected. (Persistence / minimum-extent filter.)
const MIN_FEATURE_EDGE: f64 = 0.12;

/// Max cosine between the two bounding edges' DIRECTIONS for a copper-width
/// hotspot to count as a real neck. A genuine neck/trace is bounded by two faces
/// running OPPOSITE ways (cos ≈ −1). A wedge at a trace bend/junction or a
/// rounded-pad arc has faces meeting at an acute angle (cos ≳ −0.5) — the small
/// cross-distance there is geometry, not a thin trace. Require cos ≤ this.
const NECK_ANTIPARALLEL_COS_MAX: f64 = -0.5;

/// Persistence filter for copper-width necks. A real thin neck / sliver is a
/// CORRIDOR: the narrow width ≈`d` extends along the channel for a length
/// comparable to `d`. A trace BEND (two segments + round caps unioned) reads as
/// a thin cross-distance at the concave seam, but that narrowness is point-like —
/// step along the channel axis and the copper widens or ends at once.
///
/// `NECK_WIDTH_GROW`: how much the local width may grow and still count as the
/// same channel. `MIN_NECK_LEN = max(d·FACTOR, FLOOR)`: required channel extent
/// (summed over both directions from the span midpoint) to flag as a neck.
const NECK_WIDTH_GROW: f64 = 1.75;
const MIN_NECK_LEN_FACTOR: f64 = 2.0;
const MIN_NECK_LEN_FLOOR: f64 = 0.15;

/// Drop polygon noise from a ring before the nearest-edge sweep: near-duplicate
/// and near-collinear vertices. Such a vertex never represents a real DFM
/// feature (a thin neck is two SEPARATE edges close together, not one vertex
/// sitting on its neighbours' line), but it spawns phantom hotspots — e.g.
/// tessellation noise along a curved board edge turns non-adjacent micro-edges
/// into a false "thin copper" reading. Removing it shortens index distances so
/// genuinely-adjacent boundary stops being measured against itself.
fn simplify_ring(ring: &[[f32; 2]]) -> Vec<[f32; 2]> {
    let tol = SIMPLIFY_TOL_MM;
    let f = |p: [f32; 2]| [p[0] as f64, p[1] as f64];
    // 1) Collapse consecutive near-duplicate points.
    let mut pts: Vec<[f32; 2]> = Vec::with_capacity(ring.len());
    for &p in ring {
        if let Some(&last) = pts.last() {
            let (a, b) = (f(last), f(p));
            if (a[0] - b[0]).hypot(a[1] - b[1]) < tol {
                continue;
            }
        }
        pts.push(p);
    }
    // Drop a trailing point coincident with the first (rings may or may not repeat it).
    while pts.len() > 1 {
        let (a, b) = (f(pts[0]), f(*pts.last().unwrap()));
        if (a[0] - b[0]).hypot(a[1] - b[1]) < tol {
            pts.pop();
        } else {
            break;
        }
    }
    // 2) Iteratively drop near-collinear vertices (perp distance to the segment
    //    between kept neighbours < tol). Skip the vertex after a removal so two
    //    adjacent vertices aren't dropped in the same pass (bounds drift).
    loop {
        let m = pts.len();
        if m <= 3 {
            break;
        }
        let mut keep = vec![true; m];
        let mut removed = 0usize;
        let mut i = 0;
        while i < m {
            let prev = (i + m - 1) % m;
            let next = (i + 1) % m;
            if keep[prev] && keep[next] {
                let (_, d) = point_seg_closest(f(pts[i]), f(pts[prev]), f(pts[next]));
                if d < tol {
                    keep[i] = false;
                    removed += 1;
                    i += 2;
                    continue;
                }
            }
            i += 1;
        }
        if removed == 0 {
            break;
        }
        pts = (0..m).filter(|&i| keep[i]).map(|i| pts[i]).collect();
    }
    pts
}

fn collect_edges(polys: &[Poly]) -> Vec<GEdge> {
    let mut edges = Vec::new();
    for (pi, p) in polys.iter().enumerate() {
        // Simplify each ring first (kills phantom hotspots from tessellation /
        // boolean-op vertex noise; see `simplify_ring`).
        let outer = simplify_ring(&p.outer);
        let holes: Vec<Vec<[f32; 2]>> = p.holes.iter().map(|h| simplify_ring(h)).collect();
        let rings: Vec<&Vec<[f32; 2]>> = std::iter::once(&outer).chain(holes.iter()).collect();
        for (ri, ring) in rings.iter().enumerate() {
            let n = ring.len();
            if n < 2 {
                continue;
            }
            for i in 0..n {
                let a = ring[i];
                let b = ring[(i + 1) % n];
                edges.push(GEdge {
                    a: [a[0] as f64, a[1] as f64],
                    b: [b[0] as f64, b[1] as f64],
                    poly: pi as u32,
                    ring: ri as u32,
                    idx: i as u32,
                    n: n as u32,
                });
            }
        }
    }
    edges
}

/// Two edges of the same ring that share a vertex (consecutive, cyclic).
fn adjacent(x: &GEdge, y: &GEdge) -> bool {
    if x.poly != y.poly || x.ring != y.ring {
        return false;
    }
    let d = x.idx.abs_diff(y.idx);
    d <= 1 || d == x.n - 1
}

/// A geometric DFM hotspot: the two closest mm points and the measured distance
/// between them (the value to annotate, e.g. the gap or copper width).
pub type Hot = ([f64; 2], [f64; 2], f64);

/// Max hotspots reported per metric (worst-first); excess is dropped.
const HOT_N: usize = 40;
/// Merge hotspots whose midpoints fall in the same ~1 mm cell (so a long thin
/// gap doesn't become dozens of near-identical entries).
const HOT_DEDUP_MM: f64 = 1.0;
/// Safety cap on collected candidates before dedup.
const HOT_COLLECT_CAP: usize = 200_000;

/// Spatially dedupe (keep the worst per ~1 mm cell), sort worst-first, cap to N.
fn dedup_top(hots: Vec<Hot>) -> Vec<Hot> {
    let mut best: std::collections::HashMap<(i64, i64), Hot> = std::collections::HashMap::new();
    for h in hots {
        let mx = ((h.0[0] + h.1[0]) / 2.0 / HOT_DEDUP_MM).round() as i64;
        let my = ((h.0[1] + h.1[1]) / 2.0 / HOT_DEDUP_MM).round() as i64;
        best.entry((mx, my))
            .and_modify(|b| {
                if h.2 < b.2 {
                    *b = h;
                }
            })
            .or_insert(h);
    }
    let mut v: Vec<Hot> = best.into_values().collect();
    v.sort_by(|a, b| a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal));
    v.truncate(HOT_N);
    v
}

/// Nearest-edge sweep over a uniform grid, returning the worst hotspots for
/// (clearance between DISTINCT polygons, copper width = distance between
/// non-adjacent edges of the SAME polygon). Each hotspot carries the two closest
/// mm points + the distance. Only DRC-relevant gaps (≲ 2 cells ≈ diag/110) are
/// collected; the frontend filters by the profile threshold. One pass feeds both.
#[tracing::instrument(skip_all, fields(polys = polys.len()))]
pub fn clearance_width_hotspots(polys: &[Poly]) -> (Vec<Hot>, Vec<Hot>) {
    let edges = collect_edges(polys);
    if edges.len() < 2 {
        return (Vec::new(), Vec::new());
    }
    let (mut minx, mut miny, mut maxx, mut maxy) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for e in &edges {
        for p in [e.a, e.b] {
            minx = minx.min(p[0]);
            miny = miny.min(p[1]);
            maxx = maxx.max(p[0]);
            maxy = maxy.max(p[1]);
        }
    }
    let diag = (maxx - minx).hypot(maxy - miny).max(1e-6);
    let cell = (diag / DIST_CELLS).clamp(0.2, 10.0);
    let key =
        |x: f64, y: f64| -> (i64, i64) { (((x - minx) / cell) as i64, ((y - miny) / cell) as i64) };

    let mut grid: std::collections::HashMap<(i64, i64), Vec<usize>> =
        std::collections::HashMap::new();
    {
        let _gb = tracing::info_span!("grid_build", edges = edges.len()).entered();
        for (ei, e) in edges.iter().enumerate() {
            let (cx0, cy0) = key(e.a[0].min(e.b[0]), e.a[1].min(e.b[1]));
            let (cx1, cy1) = key(e.a[0].max(e.b[0]), e.a[1].max(e.b[1]));
            for gx in cx0..=cx1 {
                for gy in cy0..=cy1 {
                    grid.entry((gx, gy)).or_default().push(ei);
                }
            }
        }
    }

    let max_gap = cell * 2.0; // matches the ±2-cell neighbour search radius
    let (mut clear, mut width): (Vec<Hot>, Vec<Hot>) = (Vec::new(), Vec::new());
    let mut budget = DIST_BUDGET;
    let sweep_span = tracing::info_span!(
        "sweep",
        edges = edges.len(),
        seg_pairs = tracing::field::Empty
    );
    let mut seg_pairs: u64 = 0;
    let _sw = sweep_span.clone().entered();
    'sweep: for (ei, e) in edges.iter().enumerate() {
        let (cx0, cy0) = key(e.a[0].min(e.b[0]), e.a[1].min(e.b[1]));
        let (cx1, cy1) = key(e.a[0].max(e.b[0]), e.a[1].max(e.b[1]));
        // ±2 cells: two edges within `cell` of each other can land 2 grid indices
        // apart once float rounding nudges a coordinate past a cell boundary.
        let mut seen = std::collections::HashSet::new();
        for gx in cx0 - 2..=cx1 + 2 {
            for gy in cy0 - 2..=cy1 + 2 {
                let Some(bucket) = grid.get(&(gx, gy)) else {
                    continue;
                };
                for &ej in bucket {
                    if ej <= ei || !seen.insert(ej) {
                        continue;
                    }
                    let f = &edges[ej];
                    let cross = e.poly != f.poly;
                    let same_nonadj = e.poly == f.poly && !adjacent(e, f);
                    if !cross && !same_nonadj {
                        continue;
                    }
                    if budget == 0 {
                        break 'sweep;
                    }
                    budget -= 1;
                    seg_pairs += 1;
                    let (pa, pb, d) = seg_seg_closest(e.a, e.b, f.a, f.b);
                    if d > max_gap {
                        continue;
                    }
                    // Require persistence: a real thin gap/neck is bounded by two
                    // edges that both run at least `MIN_FEATURE_EDGE`. A point-notch
                    // from tessellation/aperture-macro seams has a tiny chord as one
                    // of its edges — drop it (the shorter edge ≈ the chord length).
                    let el = (e.a[0] - e.b[0]).hypot(e.a[1] - e.b[1]);
                    let fl = (f.a[0] - f.b[0]).hypot(f.a[1] - f.b[1]);
                    if el.min(fl) < MIN_FEATURE_EDGE {
                        continue;
                    }
                    if cross {
                        if clear.len() < HOT_COLLECT_CAP {
                            clear.push((pa, pb, d));
                        }
                    } else {
                        // Copper width (same-polygon neck). Two false-positive
                        // classes dominate trace bends, so reject them here:
                        // (1) BAY — the span runs through a VOID between two
                        //     outward-facing faces of the piece (zigzag turns,
                        //     trace↔own-pad gap, concave bend). Its midpoint is
                        //     OUTSIDE the copper, so an interiorness test drops it.
                        // (2) WEDGE/ARC — at an acute junction or a rounded pad,
                        //     the two faces meet at an acute angle; the tiny
                        //     cross-distance is geometry, not a thin trace. A real
                        //     neck has anti-parallel faces (cos ≈ −1).
                        // Cheap anti-parallel test FIRST (a few flops); it rejects
                        // most wedges/pad-arcs, so the O(ring) interiorness ray-cast
                        // below runs far less often. Order doesn't change the result.
                        let de = [e.b[0] - e.a[0], e.b[1] - e.a[1]];
                        let df = [f.b[0] - f.a[0], f.b[1] - f.a[1]];
                        let (le2, lf2) = (de[0].hypot(de[1]), df[0].hypot(df[1]));
                        let cos = if le2 > 1e-9 && lf2 > 1e-9 {
                            (de[0] * df[0] + de[1] * df[1]) / (le2 * lf2)
                        } else {
                            0.0
                        };
                        if cos > NECK_ANTIPARALLEL_COS_MAX {
                            continue;
                        }
                        let mid = [(pa[0] + pb[0]) / 2.0, (pa[1] + pb[1]) / 2.0];
                        let poly = &polys[e.poly as usize];
                        let inside = point_in_ring(mid, &poly.outer)
                            && !poly.holes.iter().any(|h| point_in_ring(mid, h));
                        if !inside {
                            continue;
                        }
                        if width.len() < HOT_COLLECT_CAP {
                            width.push((pa, pb, d));
                        }
                    }
                }
            }
        }
    }
    drop(_sw);
    sweep_span.record("seg_pairs", seg_pairs);
    // Persistence filter (drops trace-bend / pad-seam false necks) is O(edges)
    // per candidate, so run it ONLY on the final reported set — never in the hot
    // sweep above (a dense pour yields tens of thousands of candidates). Each
    // surviving hotspot's island is found by midpoint containment.
    let width = {
        let _wf = tracing::info_span!("width_filter").entered();
        dedup_top(width)
            .into_iter()
            .filter(|&(pa, pb, d)| {
                let mid = [(pa[0] + pb[0]) / 2.0, (pa[1] + pb[1]) / 2.0];
                poly_containing(polys, mid).is_none_or(|poly| neck_persists(poly, pa, pb, d))
            })
            .collect()
    };
    (dedup_top(clear), width)
}

/// Nearest distance from `origin` along unit `dir` to any boundary edge of
/// `poly` (outer ring + holes). `INFINITY` if the ray hits nothing. Used to
/// measure the local copper width across a candidate neck.
fn ray_boundary_dist(poly: &Poly, origin: [f64; 2], dir: [f64; 2]) -> f64 {
    let cross = |v: [f64; 2], w: [f64; 2]| v[0] * w[1] - v[1] * w[0];
    let mut best = f64::INFINITY;
    let rings = std::iter::once(&poly.outer).chain(poly.holes.iter());
    for ring in rings {
        let n = ring.len();
        if n < 2 {
            continue;
        }
        for i in 0..n {
            let a = [ring[i][0] as f64, ring[i][1] as f64];
            let b = [ring[(i + 1) % n][0] as f64, ring[(i + 1) % n][1] as f64];
            let e = [b[0] - a[0], b[1] - a[1]];
            let denom = cross(dir, e);
            if denom.abs() < 1e-12 {
                continue; // ray parallel to edge
            }
            let ao = [a[0] - origin[0], a[1] - origin[1]];
            let t = cross(ao, e) / denom; // distance along the (unit) ray
            let u = cross(ao, dir) / denom; // position along the edge
            if t > 1e-9 && (0.0..=1.0).contains(&u) && t < best {
                best = t;
            }
        }
    }
    best
}

/// True if a candidate copper-width neck is a real CORRIDOR rather than a
/// point-like bend seam. Walks the channel axis (perpendicular to the span)
/// from the span midpoint in both directions; the neck persists if the copper
/// stays narrow (≤ `d·NECK_WIDTH_GROW`) and inside over a combined length of at
/// least `MIN_NECK_LEN`. See the `NECK_WIDTH_GROW` / `MIN_NECK_LEN_*` constants.
fn neck_persists(poly: &Poly, pa: [f64; 2], pb: [f64; 2], d: f64) -> bool {
    if d <= 1e-9 {
        return true;
    }
    let n = [(pb[0] - pa[0]) / d, (pb[1] - pa[1]) / d]; // across the channel
    let axis = [-n[1], n[0]]; // along the channel
    let m = [(pa[0] + pb[0]) / 2.0, (pa[1] + pb[1]) / 2.0];
    let inside = |p: [f64; 2]| {
        point_in_ring(p, &poly.outer) && !poly.holes.iter().any(|h| point_in_ring(p, h))
    };
    let step = (d * 0.5).clamp(0.02, 0.1);
    let target = (d * MIN_NECK_LEN_FACTOR).max(MIN_NECK_LEN_FLOOR);
    let width_cap = d * NECK_WIDTH_GROW;
    let max_probe = target + step;
    let mut extent = 0.0;
    for dir in [1.0_f64, -1.0] {
        let mut k = 1;
        loop {
            let off = dir * (k as f64) * step;
            if off.abs() > max_probe {
                break;
            }
            let s = [m[0] + off * axis[0], m[1] + off * axis[1]];
            if !inside(s) {
                break;
            }
            let w = ray_boundary_dist(poly, s, n) + ray_boundary_dist(poly, s, [-n[0], -n[1]]);
            if w > width_cap {
                break;
            }
            extent += step;
            if extent >= target {
                return true;
            }
            k += 1;
        }
    }
    extent >= target
}

/// (min clearance, min copper width) — the worst values, for the metrics tab.
pub fn min_clearance_and_width(polys: &[Poly]) -> (Option<f64>, Option<f64>) {
    let (c, w) = clearance_width_hotspots(polys);
    (c.first().map(|h| h.2), w.first().map(|h| h.2))
}

/// Clearance hotspots between distinct polygons only (e.g. mask openings).
pub fn clearance_hotspots(polys: &[Poly]) -> Vec<Hot> {
    clearance_width_hotspots(polys).0
}

/// Min clearance between distinct polygons only (e.g. for mask openings).
pub fn min_island_clearance(polys: &[Poly]) -> Option<f64> {
    clearance_hotspots(polys).first().map(|h| h.2)
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// Collinear subdivisions and a duplicate vertex are polygon noise — the sweep
    /// pre-simplifies them away so a smooth/tessellated edge stops spawning phantom
    /// "thin copper" hotspots between its own micro-edges.
    #[test]
    fn simplify_drops_collinear_and_duplicate_noise() {
        let mut ring = vec![[0.0f32, 0.0]];
        for k in 1..20 {
            ring.push([k as f32 * 0.5, 0.0]); // 19 collinear points along the bottom edge
        }
        ring.push([10.0, 0.0]);
        ring.push([10.0, 0.0]); // exact duplicate
        ring.push([10.0, 10.0]);
        ring.push([0.0, 10.0]);
        let s = simplify_ring(&ring);
        assert!(
            s.len() <= 6,
            "collinear/duplicate noise collapsed to ~4 corners, got {}: {s:?}",
            s.len()
        );
    }

    /// Simplification must NOT erase a genuine thin feature: a 0.1 mm-wide copper
    /// rectangle still reports a copper-width hotspot ≈ 0.1 mm.
    #[test]
    fn simplify_keeps_a_real_thin_neck() {
        let rect = vec![[0.0, 0.0], [5.0, 0.0], [5.0, 0.1], [0.0, 0.1]];
        let polys = fill_polygons(&[rect], &[]);
        let (_c, w) = clearance_width_hotspots(&polys);
        let mw = w.iter().map(|h| h.2).fold(f64::INFINITY, f64::min);
        assert!((mw - 0.1).abs() < 0.03, "thin copper width preserved: {mw}");
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

    // ---- DFM measurement geometry (G1) ----

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

    #[test]
    fn min_clearance_between_two_islands() {
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
        const PAD_AND_TRACE: &[u8] = b"%FSLAX46Y46*%\n%MOMM*%\n\
            %ADD10C,1.0*%\n%ADD11C,0.1*%\n\
            D10*\nX0Y0D03*\n\
            D11*\nX0Y0D02*\nX5000000Y0D01*\nM02*\n";
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

    #[test]
    fn clearance_hotspot_lands_in_the_gap() {
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

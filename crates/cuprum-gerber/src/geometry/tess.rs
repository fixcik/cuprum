//! Primitive tessellation and ring winding helpers.
//!
//! Walks the `gerber_viewer::GerberPrimitive` stream and emits solid contours
//! (Add-only): flashes become discs/rects/polygons, routed Line/Arc become
//! stroked rectangles plus round caps/joins. Plus the shoelace/CCW helpers the
//! boolean stage relies on. See [`super`] for the layer conventions.

use gerber_viewer::GerberPrimitive;

/// Arc tessellation steps — matches the visual fidelity of [`crate::svg`].
const ARC_STEPS: usize = 64;
/// Sides for a circle / round line-cap approximation.
pub(crate) const CIRCLE_SEGS: usize = 32;

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
pub(crate) fn to_ccw(mut ring: Vec<[f64; 2]>) -> Vec<[f64; 2]> {
    if signed_area(&ring) < 0.0 {
        ring.reverse();
    }
    ring
}

/// Emit the solid contour(s) for ONE primitive (Add-only) into `out`.
pub(crate) fn contours_for(prim: &GerberPrimitive, out: &mut Vec<Vec<[f64; 2]>>) {
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
pub(crate) fn contours_of(prims: &[GerberPrimitive]) -> Vec<Vec<[f64; 2]>> {
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
pub fn circle(cx: f64, cy: f64, r: f64, segs: usize) -> Vec<[f64; 2]> {
    (0..segs)
        .map(|i| {
            let a = (i as f64) / (segs as f64) * std::f64::consts::TAU;
            [cx + r * a.cos(), cy + r * a.sin()]
        })
        .collect()
}

//! Segment-to-segment distance geometry: orientation test, crossing, and the
//! two-closest-points query used by the edge sweep.

use crate::geometry::point_seg_closest;

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

/// Proper intersection point of segments `ab` and `cd`, if they cross.
#[inline]
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
#[inline]
pub(super) fn seg_seg_closest(
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

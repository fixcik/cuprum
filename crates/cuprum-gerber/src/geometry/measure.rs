//! Point/segment/ring measurement primitives over [`Poly`] sets: area,
//! point-in-ring, nearest-point and containment. Used by the DFM sweep/metrics
//! and mesh code in `cuprum-core`.

use super::Poly;

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
pub fn point_seg_closest(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> ([f64; 2], f64) {
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
pub fn point_in_ring(p: [f64; 2], ring: &[[f32; 2]]) -> bool {
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
pub fn poly_containing(polys: &[Poly], p: [f64; 2]) -> Option<&Poly> {
    polys.iter().find(|poly| {
        point_in_ring(p, &poly.outer) && !poly.holes.iter().any(|h| point_in_ring(p, h))
    })
}

/// Closest point on a ring's boundary to `p`, plus the distance.
pub fn point_ring_closest(p: [f64; 2], ring: &[[f32; 2]]) -> ([f64; 2], f64) {
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

//! Persistence filter for copper-width necks: distinguishes real corridors
//! (thin traces / slivers) from point-like seams at trace bends and pad junctions.

use cuprum_gerber::geometry::{point_in_ring, Poly};

/// Persistence filter for copper-width necks. A real thin neck / sliver is a
/// CORRIDOR: the narrow width ≈`d` extends along the channel for a length
/// comparable to `d`. A trace BEND (two segments + round caps unioned) reads as
/// a thin cross-distance at the concave seam, but that narrowness is point-like —
/// step along the channel axis and the copper widens or ends at once.
///
/// `NECK_WIDTH_GROW`: how much the local width may grow and still count as the
/// same channel. `MIN_NECK_LEN = max(d·FACTOR, FLOOR)`: required channel extent
/// (summed over both directions from the span midpoint) to flag as a neck.
pub(super) const NECK_WIDTH_GROW: f64 = 1.75;
pub(super) const MIN_NECK_LEN_FACTOR: f64 = 2.0;
pub(super) const MIN_NECK_LEN_FLOOR: f64 = 0.15;

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
pub(super) fn neck_persists(poly: &Poly, pa: [f64; 2], pb: [f64; 2], d: f64) -> bool {
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

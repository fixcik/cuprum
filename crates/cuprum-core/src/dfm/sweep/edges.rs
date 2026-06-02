//! Boundary-edge collection and adjacency helpers for the nearest-edge sweep.

use crate::geometry::{point_seg_closest, Poly};

/// Max deviation (mm) at which a vertex is treated as polygon noise and dropped
/// before the clearance/width sweep. Well under the artefact floor (50 µm), so
/// only sub-resolution tessellation/boolean-op noise is removed — never a real
/// feature.
pub(super) const SIMPLIFY_TOL_MM: f64 = 0.01;

/// One boundary edge, tagged for cross-polygon vs same-ring-adjacency tests.
pub(super) struct GEdge {
    pub(super) a: [f64; 2],
    pub(super) b: [f64; 2],
    pub(super) poly: u32,
    pub(super) ring: u32,
    pub(super) idx: u32,
    pub(super) n: u32,
}

/// Drop polygon noise from a ring before the nearest-edge sweep: near-duplicate
/// and near-collinear vertices. Such a vertex never represents a real DFM
/// feature (a thin neck is two SEPARATE edges close together, not one vertex
/// sitting on its neighbours' line), but it spawns phantom hotspots — e.g.
/// tessellation noise along a curved board edge turns non-adjacent micro-edges
/// into a false "thin copper" reading. Removing it shortens index distances so
/// genuinely-adjacent boundary stops being measured against itself.
pub(super) fn simplify_ring(ring: &[[f32; 2]]) -> Vec<[f32; 2]> {
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

pub(super) fn collect_edges(polys: &[Poly]) -> Vec<GEdge> {
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
#[inline]
pub(super) fn adjacent(x: &GEdge, y: &GEdge) -> bool {
    if x.poly != y.poly || x.ring != y.ring {
        return false;
    }
    let d = x.idx.abs_diff(y.idx);
    d <= 1 || d == x.n - 1
}

#[cfg(test)]
mod tests {
    use super::*;

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
}

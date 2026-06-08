// Geometry primitives — port of keepoutGeometry.ts.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Pt {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// New rect expanded on all four sides by `m`.
pub fn expand(r: Rect, m: f64) -> Rect {
    Rect {
        x: r.x - m,
        y: r.y - m,
        w: r.w + 2.0 * m,
        h: r.h + 2.0 * m,
    }
}

/// Closed-rect point test: inside or on the boundary.
pub fn point_in_rect(p: Pt, r: &Rect) -> bool {
    p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
}

/// True when segment a→b crosses the INTERIOR of r. Boundary-only contact → false.
/// Liang-Barsky parametric clip + strict-interior midpoint test (port of TS).
pub fn seg_intersects_rect(a: Pt, b: Pt, r: &Rect) -> bool {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let p = [-dx, dx, -dy, dy];
    let q = [a.x - r.x, r.x + r.w - a.x, a.y - r.y, r.y + r.h - a.y];
    let mut t0 = 0.0_f64;
    let mut t1 = 1.0_f64;
    for i in 0..4 {
        if p[i] == 0.0 {
            if q[i] < 0.0 {
                return false;
            }
        } else {
            let t = q[i] / p[i];
            if p[i] < 0.0 {
                if t > t0 {
                    t0 = t;
                }
            } else if t < t1 {
                t1 = t;
            }
        }
        if t0 > t1 {
            return false;
        }
    }
    let tm = (t0 + t1) / 2.0;
    let mx = a.x + tm * dx;
    let my = a.y + tm * dy;
    mx > r.x && mx < r.x + r.w && my > r.y && my < r.y + r.h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_grows_all_sides() {
        let r = expand(
            Rect {
                x: 10.0,
                y: 10.0,
                w: 5.0,
                h: 5.0,
            },
            1.0,
        );
        assert_eq!((r.x, r.y, r.w, r.h), (9.0, 9.0, 7.0, 7.0));
    }

    #[test]
    fn seg_interior_crossing_true() {
        let r = Rect {
            x: 0.0,
            y: 0.0,
            w: 10.0,
            h: 10.0,
        };
        assert!(seg_intersects_rect(
            Pt { x: -1.0, y: 5.0 },
            Pt { x: 11.0, y: 5.0 },
            &r
        ));
    }

    #[test]
    fn seg_edge_graze_false() {
        // Grazing along the top edge (y == r.y) is boundary-only → false.
        let r = Rect {
            x: 0.0,
            y: 0.0,
            w: 10.0,
            h: 10.0,
        };
        assert!(!seg_intersects_rect(
            Pt { x: -1.0, y: 0.0 },
            Pt { x: 11.0, y: 0.0 },
            &r
        ));
    }

    #[test]
    fn seg_outside_false() {
        let r = Rect {
            x: 0.0,
            y: 0.0,
            w: 10.0,
            h: 10.0,
        };
        assert!(!seg_intersects_rect(
            Pt { x: -5.0, y: -5.0 },
            Pt { x: -1.0, y: -1.0 },
            &r
        ));
    }

    #[test]
    fn point_in_rect_inclusive() {
        let r = Rect {
            x: 0.0,
            y: 0.0,
            w: 10.0,
            h: 10.0,
        };
        assert!(point_in_rect(Pt { x: 0.0, y: 0.0 }, &r)); // boundary inclusive
        assert!(!point_in_rect(Pt { x: 10.001, y: 5.0 }, &r));
    }
}

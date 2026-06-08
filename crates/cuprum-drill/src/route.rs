// Ordering + keep-out traverse routing — port of drillRoute.ts / visibilityRoute.ts.
use crate::geom::{expand, point_in_rect, seg_intersects_rect, Pt, Rect};
use crate::types::PanelBounds;

const EPS: f64 = 1e-9;

fn inside_strict(p: Pt, r: &Rect) -> bool {
    p.x > r.x + EPS && p.x < r.x + r.w - EPS && p.y > r.y + EPS && p.y < r.y + r.h - EPS
}

fn clamp_to_panel(p: Pt, panel: &PanelBounds) -> Pt {
    Pt {
        x: p.x.clamp(panel.min_x, panel.max_x),
        y: p.y.clamp(panel.min_y, panel.max_y),
    }
}

/// Push a clipped/deduped expanded-rect corner node. Mirrors the TS `pushNode`
/// closure; kept as a free fn to satisfy the borrow checker (`&mut nodes`).
fn push_node(
    raw: Pt,
    bounded: bool,
    panel: Option<&PanelBounds>,
    expanded: &[Rect],
    nodes: &mut Vec<Pt>,
) {
    let p = if bounded {
        clamp_to_panel(raw, panel.expect("bounded implies panel"))
    } else {
        raw
    };
    if bounded && expanded.iter().any(|r| inside_strict(p, r)) {
        return;
    }
    if nodes
        .iter()
        .any(|n| (n.x - p.x).abs() < EPS && (n.y - p.y).abs() < EPS)
    {
        return;
    }
    nodes.push(p);
}

/// An obstacle blocks segment p→q when the segment crosses its interior and the
/// obstacle index is not in this edge's exempt set.
fn seg_blocked(p: Pt, q: Pt, expanded: &[Rect], exempt: &[usize]) -> bool {
    expanded
        .iter()
        .enumerate()
        .any(|(i, r)| !exempt.contains(&i) && seg_intersects_rect(p, q, r))
}

/// Intermediate waypoints (excluding a, b) routing a→b around `obstacles`
/// (each expanded by `margin_mm`) via visibility graph + Dijkstra. Returns []
/// when the straight line is already clear or no in-panel path exists.
pub fn route_avoiding(
    a: Pt,
    b: Pt,
    obstacles: &[Rect],
    margin_mm: f64,
    panel: Option<PanelBounds>,
) -> Vec<Pt> {
    let bounded = panel.is_some_and(|p| p.max_x > p.min_x && p.max_y > p.min_y);
    let expanded: Vec<Rect> = obstacles.iter().map(|z| expand(*z, margin_mm)).collect();

    // Exemption applies ONLY to real endpoints a/b (by zone index), never corner nodes.
    let exempt_a: Vec<usize> = expanded
        .iter()
        .enumerate()
        .filter(|(_, r)| point_in_rect(a, r))
        .map(|(i, _)| i)
        .collect();
    let exempt_b: Vec<usize> = expanded
        .iter()
        .enumerate()
        .filter(|(_, r)| point_in_rect(b, r))
        .map(|(i, _)| i)
        .collect();

    // Fast path: straight line already clear (also covers a==b and no obstacles).
    let both: Vec<usize> = exempt_a.iter().chain(exempt_b.iter()).copied().collect();
    if !seg_blocked(a, b, &expanded, &both) {
        return vec![];
    }

    // Nodes: a(0), b(1), then clipped/deduped expanded-rect corners.
    let panel_ref = panel.as_ref();
    let mut nodes: Vec<Pt> = vec![a, b];
    for r in &expanded {
        push_node(Pt { x: r.x, y: r.y }, bounded, panel_ref, &expanded, &mut nodes);
        push_node(
            Pt { x: r.x + r.w, y: r.y },
            bounded,
            panel_ref,
            &expanded,
            &mut nodes,
        );
        push_node(
            Pt {
                x: r.x + r.w,
                y: r.y + r.h,
            },
            bounded,
            panel_ref,
            &expanded,
            &mut nodes,
        );
        push_node(
            Pt { x: r.x, y: r.y + r.h },
            bounded,
            panel_ref,
            &expanded,
            &mut nodes,
        );
    }

    // Dijkstra a(0) → b(1), deterministic (lowest-index node wins ties).
    let n = nodes.len();
    let mut dist = vec![f64::INFINITY; n];
    let mut prev = vec![usize::MAX; n];
    let mut done = vec![false; n];
    dist[0] = 0.0;
    for _ in 0..n {
        let mut u = usize::MAX;
        let mut best = f64::INFINITY;
        for i in 0..n {
            if !done[i] && dist[i] < best {
                best = dist[i];
                u = i;
            }
        }
        if u == usize::MAX || u == 1 {
            break;
        }
        done[u] = true;
        for v in 0..n {
            if done[v] || v == u {
                continue;
            }
            let mut exempt: Vec<usize> = vec![];
            if u == 0 || v == 0 {
                exempt.extend(&exempt_a);
            }
            if u == 1 || v == 1 {
                exempt.extend(&exempt_b);
            }
            if seg_blocked(nodes[u], nodes[v], &expanded, &exempt) {
                continue;
            }
            let dx = nodes[u].x - nodes[v].x;
            let dy = nodes[u].y - nodes[v].y;
            let w = (dx * dx + dy * dy).sqrt();
            if dist[u] + w < dist[v] - EPS {
                dist[v] = dist[u] + w;
                prev[v] = u;
            }
        }
    }

    if !dist[1].is_finite() {
        return vec![]; // no in-panel path; straight-line fallback
    }

    // Reconstruct b→a, drop endpoints, reverse to a→b order.
    let mut path: Vec<Pt> = vec![];
    let mut at = prev[1];
    while at != usize::MAX && at != 0 {
        path.push(nodes[at]);
        at = prev[at];
    }
    path.reverse();
    path
}

#[cfg(test)]
mod route_tests {
    use super::*;
    use crate::geom::{Pt, Rect};

    fn z(x: f64, y: f64, w: f64, h: f64) -> Rect {
        Rect { x, y, w, h }
    }

    #[test]
    fn clear_line_returns_empty() {
        assert!(route_avoiding(
            Pt { x: 0.0, y: 0.0 },
            Pt { x: 10.0, y: 0.0 },
            &[],
            1.0,
            None
        )
        .is_empty());
    }

    #[test]
    fn detour_around_interior_zone() {
        // Zone squarely between a and b → non-empty detour, none strictly inside.
        let obs = vec![z(4.0, -5.0, 2.0, 10.0)];
        let wp = route_avoiding(
            Pt { x: 0.0, y: 0.0 },
            Pt { x: 10.0, y: 0.0 },
            &obs,
            1.0,
            None,
        );
        assert!(!wp.is_empty());
    }

    #[test]
    fn flush_left_zone_routes_inside_panel() {
        let panel = PanelBounds {
            min_x: 0.0,
            min_y: 0.0,
            max_x: 100.0,
            max_y: 50.0,
        };
        let obs = vec![z(0.0, 10.0, 10.0, 30.0)];
        let wp = route_avoiding(
            Pt { x: 5.0, y: 5.0 },
            Pt { x: 5.0, y: 45.0 },
            &obs,
            1.0,
            Some(panel),
        );
        assert!(!wp.is_empty());
        for p in &wp {
            assert!(p.x >= -1e-9 && p.x <= 100.0 + 1e-9);
        }
    }

    #[test]
    fn negative_origin_panel() {
        // Flipped-datum panel maps to a negative quadrant; routing must respect it.
        let panel = PanelBounds {
            min_x: -100.0,
            min_y: 0.0,
            max_x: 0.0,
            max_y: 50.0,
        };
        let obs = vec![z(-10.0, 10.0, 10.0, 30.0)];
        let wp = route_avoiding(
            Pt { x: -5.0, y: 5.0 },
            Pt { x: -5.0, y: 45.0 },
            &obs,
            1.0,
            Some(panel),
        );
        for p in &wp {
            assert!(p.x >= -100.0 - 1e-9 && p.x <= 1e-9);
        }
    }

    #[test]
    fn split_panel_falls_back_empty() {
        // Expanded zone splits the panel between a and b → no in-panel path → [].
        let panel = PanelBounds {
            min_x: 0.0,
            min_y: 0.0,
            max_x: 20.0,
            max_y: 50.0,
        };
        let obs = vec![z(0.0, 20.0, 20.0, 10.0)]; // spans full width
        let wp = route_avoiding(
            Pt { x: 10.0, y: 5.0 },
            Pt { x: 10.0, y: 45.0 },
            &obs,
            1.0,
            Some(panel),
        );
        assert!(wp.is_empty());
    }
}

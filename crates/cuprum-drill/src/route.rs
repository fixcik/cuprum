// Ordering + keep-out traverse routing — port of drillRoute.ts / visibilityRoute.ts.
use crate::geom::{expand, point_in_rect, seg_intersects_rect, Pt, Rect};
use crate::types::{
    DatumCorner, DrillClass, DrillGroup, DrillRoute, PanelBounds, PanelDrillPlan, PlanHole,
    RouteGroup, KEEPOUT_TRAVERSE_MARGIN_MM,
};

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
        push_node(
            Pt { x: r.x, y: r.y },
            bounded,
            panel_ref,
            &expanded,
            &mut nodes,
        );
        push_node(
            Pt {
                x: r.x + r.w,
                y: r.y,
            },
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
            Pt {
                x: r.x,
                y: r.y + r.h,
            },
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

/// Greedy nearest-neighbour ordering from a start point. Stable: ties resolve to
/// the earlier index → deterministic. Matches the TS `orderNearest`.
pub fn order_nearest(points: &[[f64; 2]], start_x: f64, start_y: f64) -> Vec<usize> {
    let mut remaining: Vec<usize> = (0..points.len()).collect();
    let mut order = Vec::with_capacity(points.len());
    let (mut cx, mut cy) = (start_x, start_y);
    while !remaining.is_empty() {
        let mut bi = 0;
        let mut bd = f64::INFINITY;
        for (k, &idx) in remaining.iter().enumerate() {
            let dx = points[idx][0] - cx;
            let dy = points[idx][1] - cy;
            let d = dx * dx + dy * dy;
            if d < bd {
                bd = d;
                bi = k;
            } // strict < → lowest index on ties
        }
        let idx = remaining.remove(bi);
        order.push(idx);
        cx = points[idx][0];
        cy = points[idx][1];
    }
    order
}

/// Drill registration holes first (datum), then ascending diameter — must match
/// the emitter's CLASS_ORDER.
fn class_order(c: DrillClass) -> u8 {
    match c {
        DrillClass::Registration => 0,
        DrillClass::Pth => 1,
        DrillClass::Npth => 2,
        DrillClass::Mechanical => 3,
    }
}

/// Panel (x, y) [editor space: Y-down, origin top-left] → machine (X right+, Y up+),
/// origin translated to the chosen datum corner. Translation only — no mirroring.
pub fn machine_point(x: f64, y: f64, datum: DatumCorner, w_mm: f64, h_mm: f64) -> (f64, f64) {
    let right = matches!(datum, DatumCorner::BottomRight | DatumCorner::TopRight);
    let bottom = matches!(datum, DatumCorner::BottomLeft | DatumCorner::BottomRight);
    (
        x - if right { w_mm } else { 0.0 },
        (if bottom { h_mm } else { 0.0 }) - y,
    )
}

/// Order the plan for drilling/preview and insert keep-out detour waypoints.
/// `start` mirrors the emitter's ordering cursor origin; `zones` are keep-out
/// zones in the same coordinate space as the holes.
pub fn plan_drill_route(
    plan: &PanelDrillPlan,
    start: (f64, f64),
    zones: &[Rect],
    panel: Option<PanelBounds>,
) -> DrillRoute {
    let mut groups: Vec<&DrillGroup> = plan.groups.iter().collect();
    groups.sort_by(|a, b| {
        class_order(a.class).cmp(&class_order(b.class)).then(
            a.diameter_mm
                .partial_cmp(&b.diameter_mm)
                .unwrap_or(std::cmp::Ordering::Equal),
        )
    });

    let mut out: Vec<RouteGroup> = vec![];
    let mut ordered_holes_list: Vec<PlanHole> = vec![];
    let (mut cx, mut cy) = start;
    let mut tool_ids: std::collections::BTreeSet<String> = Default::default();

    for g in &groups {
        let pts: Vec<[f64; 2]> = g.holes.iter().map(|h| [h.x_mm, h.y_mm]).collect();
        let order = order_nearest(&pts, cx, cy);
        let ordered: Vec<PlanHole> = order.iter().map(|&i| g.holes[i].clone()).collect();
        if let Some(last) = ordered.last() {
            cx = last.x_mm;
            cy = last.y_mm;
        }
        if let Some(tid) = &g.tool_id {
            tool_ids.insert(tid.clone());
        }
        for h in &ordered {
            ordered_holes_list.push(h.clone());
        }
        out.push(RouteGroup {
            diameter_mm: g.diameter_mm,
            class: g.class,
            tool_id: g.tool_id.clone(),
            ordered_holes: ordered,
        });
    }

    // Build path with detour waypoints before each hole.
    let mut path: Vec<PlanHole> = vec![];
    let (mut prev_x, mut prev_y) = start;
    for h in &ordered_holes_list {
        if !zones.is_empty() {
            let wps = route_avoiding(
                Pt {
                    x: prev_x,
                    y: prev_y,
                },
                Pt {
                    x: h.x_mm,
                    y: h.y_mm,
                },
                zones,
                KEEPOUT_TRAVERSE_MARGIN_MM,
                panel,
            );
            for wp in wps {
                path.push(PlanHole {
                    x_mm: wp.x,
                    y_mm: wp.y,
                    id: None,
                });
            }
        }
        path.push(h.clone());
        prev_x = h.x_mm;
        prev_y = h.y_mm;
    }

    // Final leg: return to the work zero (the datum corner = the ordering start)
    // so the canvas draws the homing move like any other traverse and the estimate
    // counts it. Routes around keep-out zones exactly like the inter-hole moves,
    // matching the emitter's postamble return. Skipped when no holes ran.
    if !ordered_holes_list.is_empty() {
        let (sx, sy) = start;
        if !zones.is_empty() {
            let wps = route_avoiding(
                Pt {
                    x: prev_x,
                    y: prev_y,
                },
                Pt { x: sx, y: sy },
                zones,
                KEEPOUT_TRAVERSE_MARGIN_MM,
                panel,
            );
            for wp in wps {
                path.push(PlanHole {
                    x_mm: wp.x,
                    y_mm: wp.y,
                    id: None,
                });
            }
        }
        path.push(PlanHole {
            x_mm: sx,
            y_mm: sy,
            id: None,
        });
    }

    let total = ordered_holes_list.len();
    DrillRoute {
        groups: out,
        path_points: path,
        total_holes: total,
        tool_count: tool_ids.len(),
    }
}

#[cfg(test)]
mod route_tests {
    use super::*;
    use crate::geom::{Pt, Rect};
    use crate::types::{DrillClass, DrillGroup, PanelDrillPlan, PlanHole};

    fn z(x: f64, y: f64, w: f64, h: f64) -> Rect {
        Rect { x, y, w, h }
    }

    #[test]
    fn order_nearest_greedy_from_start() {
        let pts = [[0.0, 0.0], [10.0, 0.0], [1.0, 0.0]];
        // From (0,0): nearest is idx0 (0,0)=d0, then idx2 (1,0), then idx1 (10,0).
        assert_eq!(order_nearest(&pts, 0.0, 0.0), vec![0, 2, 1]);
    }

    #[test]
    fn order_nearest_ties_lowest_index() {
        let pts = [[1.0, 0.0], [-1.0, 0.0]]; // both dist 1 from origin → idx0 first
        assert_eq!(order_nearest(&pts, 0.0, 0.0), vec![0, 1]);
    }

    #[test]
    fn plan_orders_registration_first_then_diameter() {
        // groups out of order → registration class first, then ascending diameter.
        let plan = PanelDrillPlan {
            groups: vec![
                DrillGroup {
                    diameter_mm: 0.8,
                    class: DrillClass::Pth,
                    tool_id: Some("t1".into()),
                    holes: vec![PlanHole {
                        x_mm: 5.0,
                        y_mm: 5.0,
                        id: None,
                    }],
                },
                DrillGroup {
                    diameter_mm: 3.0,
                    class: DrillClass::Registration,
                    tool_id: Some("t2".into()),
                    holes: vec![PlanHole {
                        x_mm: 0.0,
                        y_mm: 0.0,
                        id: None,
                    }],
                },
            ],
        };
        let r = plan_drill_route(&plan, (0.0, 0.0), &[], None);
        assert_eq!(r.groups[0].class, DrillClass::Registration);
        assert_eq!(r.total_holes, 2);
        assert_eq!(r.tool_count, 2);
    }

    #[test]
    fn route_returns_to_datum_corner_after_last_hole() {
        // The homing leg back to work zero (the ordering start) is part of the
        // drawn path so the canvas shows it and the estimate counts it.
        let plan = PanelDrillPlan {
            groups: vec![DrillGroup {
                diameter_mm: 1.0,
                class: DrillClass::Registration,
                tool_id: Some("t1".into()),
                holes: vec![
                    PlanHole {
                        x_mm: 10.0,
                        y_mm: 10.0,
                        id: None,
                    },
                    PlanHole {
                        x_mm: 30.0,
                        y_mm: 10.0,
                        id: None,
                    },
                ],
            }],
        };
        let start = (0.0, 0.0);
        let r = plan_drill_route(&plan, start, &[], None);
        let last = r.path_points.last().unwrap();
        assert_eq!((last.x_mm, last.y_mm), start);
        assert!(last.id.is_none()); // homing waypoint, not a hole
                                    // 2 holes + 1 homing point, no zones → no detour waypoints.
        assert_eq!(r.path_points.len(), 3);
    }

    #[test]
    fn route_no_homing_leg_when_no_holes() {
        let plan = PanelDrillPlan { groups: vec![] };
        let r = plan_drill_route(&plan, (0.0, 0.0), &[], None);
        assert!(r.path_points.is_empty());
    }

    #[test]
    fn plan_inserts_detour_waypoints_inside_panel() {
        let panel = PanelBounds {
            min_x: 0.0,
            min_y: 0.0,
            max_x: 100.0,
            max_y: 60.0,
        };
        let zones = [Rect {
            x: 40.0,
            y: 0.0,
            w: 10.0,
            h: 30.0,
        }];
        let plan = PanelDrillPlan {
            groups: vec![DrillGroup {
                diameter_mm: 0.8,
                class: DrillClass::Pth,
                tool_id: Some("t1".into()),
                holes: vec![
                    PlanHole {
                        x_mm: 10.0,
                        y_mm: 10.0,
                        id: None,
                    },
                    PlanHole {
                        x_mm: 90.0,
                        y_mm: 10.0,
                        id: None,
                    },
                ],
            }],
        };
        let r = plan_drill_route(&plan, (10.0, 10.0), &zones, Some(panel));
        // path has at least the 2 holes; if a detour was inserted, waypoints stay in-panel.
        for p in &r.path_points {
            assert!(
                p.x_mm >= -1e-9
                    && p.x_mm <= 100.0 + 1e-9
                    && p.y_mm >= -1e-9
                    && p.y_mm <= 60.0 + 1e-9
            );
        }
    }

    #[test]
    fn machine_point_flips_y_per_datum() {
        assert_eq!(
            machine_point(3.0, 4.0, DatumCorner::BottomLeft, 100.0, 60.0),
            (3.0, 56.0)
        );
        assert_eq!(
            machine_point(3.0, 4.0, DatumCorner::TopLeft, 100.0, 60.0),
            (3.0, -4.0)
        );
        assert_eq!(
            machine_point(3.0, 4.0, DatumCorner::BottomRight, 100.0, 60.0),
            (-97.0, 56.0)
        );
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

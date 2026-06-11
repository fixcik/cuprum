// Trapezoidal drill-time estimate from GRBL kinematics.
use crate::types::{DrillEstimate, DrillRoute, Kinematics, PlanHole, Tool};
use std::collections::HashMap;

/// Same XY point (within tolerance) — used to recognise which path waypoints are the
/// actual ordered holes (vs keep-out detour waypoints) when attributing traverse time
/// to groups. Hole coordinates come straight from the route, so an exact-ish match.
fn same_xy(a: &PlanHole, b: &PlanHole) -> bool {
    (a.x_mm - b.x_mm).abs() < 1e-6 && (a.y_mm - b.y_mm).abs() < 1e-6
}

/// Time (s) for a single start-to-stop move of `dist` mm, given max feed
/// `max_rate_mm_min` and acceleration `accel_mm_s2`. Trapezoidal profile,
/// triangular when the move is too short to reach cruise speed.
pub fn move_time(dist: f64, max_rate_mm_min: f64, accel_mm_s2: f64) -> f64 {
    if dist <= 0.0 || max_rate_mm_min <= 0.0 || accel_mm_s2 <= 0.0 {
        return 0.0;
    }
    let v = max_rate_mm_min / 60.0; // cruise speed, mm/s
    let a = accel_mm_s2;
    let d_acc = v * v / (2.0 * a); // distance to ramp 0→v
    if dist >= 2.0 * d_acc {
        2.0 * (v / a) + (dist - 2.0 * d_acc) / v // trapezoid
    } else {
        2.0 * (dist / a).sqrt() // triangle (peak < v)
    }
}

/// Estimate drilling motion time. Excludes tool-change & Z-probe time (reported as
/// `tool_changes` count). `depth_mm` = substrate + breakthrough; `safe_z_mm` is the
/// per-hole retract height; `peck_mm` > 0 enables peck cycles.
pub fn estimate_drill(
    route: &DrillRoute,
    tools: &[Tool],
    k: &Kinematics,
    safe_z_mm: f64,
    depth_mm: f64,
    peck_mm: f64,
) -> DrillEstimate {
    // Per-ordered-hole group index: groups are laid out back-to-back, so the i-th
    // ordered hole belongs to the group whose cumulative hole count first exceeds i.
    let mut group_of_hole: Vec<usize> = Vec::with_capacity(route.total_holes);
    for (gi, g) in route.groups.iter().enumerate() {
        for _ in &g.ordered_holes {
            group_of_hole.push(gi);
        }
    }
    let ordered: Vec<&PlanHole> = route
        .groups
        .iter()
        .flat_map(|g| g.ordered_holes.iter())
        .collect();
    let mut group_secs = vec![0.0f64; route.groups.len()];

    // Traverse: sum trapezoidal time over consecutive path points (panel-space
    // distances == machine-space; machine_point is an isometry). Each leg is charged
    // to the group of the hole it travels TOWARD (the group we're entering); the final
    // return-to-zero leg (past the last hole) lands on the last group. Detour waypoints
    // don't match an ordered hole, so `hole_idx` only advances on real holes.
    let mut travel_mm = 0.0;
    let mut motion_sec = 0.0;
    let pts = &route.path_points;
    let mut hole_idx = 0usize;
    for i in 1..pts.len() {
        let dx = pts[i].x_mm - pts[i - 1].x_mm;
        let dy = pts[i].y_mm - pts[i - 1].y_mm;
        let d = (dx * dx + dy * dy).sqrt();
        travel_mm += d;
        let t = move_time(d, k.max_rate_xy_mm_min, k.accel_xy_mm_s2);
        motion_sec += t;
        if !group_of_hole.is_empty() {
            let gi = group_of_hole[hole_idx.min(group_of_hole.len() - 1)];
            group_secs[gi] += t;
        }
        if hole_idx < ordered.len() && same_xy(&pts[i], ordered[hole_idx]) {
            hole_idx += 1;
        }
    }

    let plunge_by_tool: HashMap<&str, f64> = tools
        .iter()
        .map(|t| (t.id.as_str(), t.recommended_plunge_mm_min))
        .collect();

    // Per-hole plunge (feed-limited) + retract (rapid Z). Travel per Z move = safe_z + depth.
    let z_span = safe_z_mm + depth_mm;
    let mut tool_changes = 0u32;
    for (gi, g) in route.groups.iter().enumerate() {
        if g.tool_id.is_some() {
            tool_changes += 1;
        }
        let plunge_feed = g
            .tool_id
            .as_deref()
            .and_then(|id| plunge_by_tool.get(id).copied())
            .unwrap_or(60.0);
        let per_hole = if peck_mm > 0.0 && peck_mm < depth_mm {
            // Peck: repeated G1 down to z then G0 retract to safe_z. Sum exact segments.
            let mut s = 0.0;
            let mut z = 0.0;
            while z < depth_mm - 1e-9 {
                let next = (z + peck_mm).min(depth_mm);
                // plunge from safe_z down to -next = safe_z + next; retract back = safe_z + next.
                s += move_time(safe_z_mm + next, plunge_feed, k.accel_z_mm_s2);
                s += move_time(safe_z_mm + next, k.max_rate_z_mm_min, k.accel_z_mm_s2);
                z = next;
            }
            s
        } else {
            move_time(z_span, plunge_feed, k.accel_z_mm_s2)
                + move_time(z_span, k.max_rate_z_mm_min, k.accel_z_mm_s2)
        };
        let group_hole_secs = per_hole * g.ordered_holes.len() as f64;
        motion_sec += group_hole_secs;
        group_secs[gi] += group_hole_secs;
    }

    DrillEstimate {
        travel_mm,
        motion_sec,
        tool_changes,
        group_motion_secs: group_secs,
    }
}

#[cfg(test)]
mod est_tests {
    use super::*;

    #[test]
    fn move_time_triangular_short_move() {
        // Too short to reach cruise: t = 2*sqrt(dist/a). dist=1mm, a=30 → 2*sqrt(1/30)≈0.365s
        let t = move_time(1.0, 100_000.0, 30.0); // huge max rate → always triangular
        assert!((t - 2.0 * (1.0_f64 / 30.0).sqrt()).abs() < 1e-9);
    }

    #[test]
    fn move_time_trapezoidal_long_move() {
        // v = 600/60 = 10 mm/s, a = 30. d_acc = v^2/(2a)=100/60≈1.667. 2*d_acc≈3.333.
        // dist=10 > 3.333 → trapezoid: t = 2*(v/a) + (dist-2*d_acc)/v
        let v = 10.0;
        let a = 30.0;
        let dist = 10.0;
        let d_acc = v * v / (2.0 * a);
        let expect = 2.0 * (v / a) + (dist - 2.0 * d_acc) / v;
        assert!((move_time(dist, 600.0, a) - expect).abs() < 1e-9);
    }

    #[test]
    fn move_time_zero_dist_zero() {
        assert_eq!(move_time(0.0, 600.0, 30.0), 0.0);
    }

    #[test]
    fn estimate_counts_tool_changes_and_positive_time() {
        // Build a tiny route via plan_drill_route, then estimate.
        let plan = crate::types::PanelDrillPlan {
            groups: vec![crate::types::DrillGroup {
                diameter_mm: 1.0,
                class: crate::types::DrillClass::Registration,
                tool_id: Some("t1".into()),
                holes: vec![
                    crate::types::PlanHole {
                        x_mm: 0.0,
                        y_mm: 0.0,
                        id: None,
                    },
                    crate::types::PlanHole {
                        x_mm: 50.0,
                        y_mm: 0.0,
                        id: None,
                    },
                ],
            }],
        };
        let route = crate::route::plan_drill_route(&plan, (0.0, 0.0), &[], None);
        let tools = vec![crate::types::Tool {
            id: "t1".into(),
            diameter_mm: 1.0,
            name: "d".into(),
            recommended_rpm: 9000.0,
            recommended_plunge_mm_min: 60.0,
        }];
        let k = crate::types::Kinematics::default();
        let est = estimate_drill(&route, &tools, &k, 5.0, 1.9, 0.0);
        assert_eq!(est.tool_changes, 1);
        assert!(est.motion_sec > 0.0);
        assert!(est.travel_mm >= 50.0);
        // One group → all motion lands in its single bucket.
        assert_eq!(est.group_motion_secs.len(), 1);
        assert!((est.group_motion_secs[0] - est.motion_sec).abs() < 1e-9);
    }

    #[test]
    fn group_motion_secs_split_and_sum_to_total() {
        // Two diameter groups → two tool changes. Each group's bucket is positive and
        // the buckets sum to the total motion time (traverse charged to the group it
        // enters + per-hole time).
        let plan = crate::types::PanelDrillPlan {
            groups: vec![
                crate::types::DrillGroup {
                    diameter_mm: 0.8,
                    class: crate::types::DrillClass::Pth,
                    tool_id: Some("small".into()),
                    holes: vec![
                        crate::types::PlanHole { x_mm: 0.0, y_mm: 0.0, id: None },
                        crate::types::PlanHole { x_mm: 10.0, y_mm: 0.0, id: None },
                    ],
                },
                crate::types::DrillGroup {
                    diameter_mm: 3.0,
                    class: crate::types::DrillClass::Pth,
                    tool_id: Some("big".into()),
                    holes: vec![
                        crate::types::PlanHole { x_mm: 40.0, y_mm: 20.0, id: None },
                        crate::types::PlanHole { x_mm: 60.0, y_mm: 30.0, id: None },
                    ],
                },
            ],
        };
        let route = crate::route::plan_drill_route(&plan, (0.0, 0.0), &[], None);
        let tools = vec![
            crate::types::Tool {
                id: "small".into(),
                diameter_mm: 0.8,
                name: "s".into(),
                recommended_rpm: 9000.0,
                recommended_plunge_mm_min: 60.0,
            },
            crate::types::Tool {
                id: "big".into(),
                diameter_mm: 3.0,
                name: "b".into(),
                recommended_rpm: 9000.0,
                recommended_plunge_mm_min: 60.0,
            },
        ];
        let k = crate::types::Kinematics::default();
        let est = estimate_drill(&route, &tools, &k, 5.0, 1.9, 0.0);
        assert_eq!(est.tool_changes, 2);
        assert_eq!(est.group_motion_secs.len(), route.groups.len());
        for s in &est.group_motion_secs {
            assert!(*s > 0.0, "every group should carry some motion time");
        }
        let sum: f64 = est.group_motion_secs.iter().sum();
        assert!((sum - est.motion_sec).abs() < 1e-9, "buckets must sum to total");
    }
}

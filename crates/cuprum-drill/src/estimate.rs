// Trapezoidal drill-time estimate from GRBL kinematics.
use crate::types::{DrillEstimate, DrillRoute, Kinematics, Tool};
use std::collections::HashMap;

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
    // Traverse: sum trapezoidal time over consecutive path points (panel-space
    // distances == machine-space; machine_point is an isometry).
    let mut travel_mm = 0.0;
    let mut motion_sec = 0.0;
    let pts = &route.path_points;
    for i in 1..pts.len() {
        let dx = pts[i].x_mm - pts[i - 1].x_mm;
        let dy = pts[i].y_mm - pts[i - 1].y_mm;
        let d = (dx * dx + dy * dy).sqrt();
        travel_mm += d;
        motion_sec += move_time(d, k.max_rate_xy_mm_min, k.accel_xy_mm_s2);
    }

    let plunge_by_tool: HashMap<&str, f64> = tools
        .iter()
        .map(|t| (t.id.as_str(), t.recommended_plunge_mm_min))
        .collect();

    // Per-hole plunge (feed-limited) + retract (rapid Z). Travel per Z move = safe_z + depth.
    let z_span = safe_z_mm + depth_mm;
    let mut tool_changes = 0u32;
    for g in &route.groups {
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
        motion_sec += per_hole * g.ordered_holes.len() as f64;
    }

    DrillEstimate {
        travel_mm,
        motion_sec,
        tool_changes,
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
    }
}

// Trapezoidal milling-time estimate from GRBL kinematics. Reuses move_time from
// cuprum-drill.
use crate::types::{MillEstimate, MillParams, MillPath};
use cuprum_drill::{move_time, order_nearest, Kinematics};

/// Perimeter length of a closed contour (last vertex → first to seal).
fn contour_len(points: &[[f64; 2]]) -> f64 {
    if points.len() < 2 {
        return 0.0;
    }
    let mut len = 0.0;
    for i in 1..points.len() {
        let dx = points[i][0] - points[i - 1][0];
        let dy = points[i][1] - points[i - 1][1];
        len += (dx * dx + dy * dy).sqrt();
    }
    // Close the loop.
    let dx = points[0][0] - points[points.len() - 1][0];
    let dy = points[0][1] - points[points.len() - 1][1];
    len + (dx * dx + dy * dy).sqrt()
}

/// Number of depth passes for the given params (>= 1).
fn pass_count(params: &MillParams) -> usize {
    match params.depth_per_pass_mm {
        Some(d) if d > 0.0 && d < params.cut_depth_mm => (params.cut_depth_mm / d).ceil() as usize,
        _ => 1,
    }
}

/// Estimate milling motion time. `cut_len_mm` sums contour perimeters × passes;
/// `travel_len_mm` sums inter-path XY hops (nearest-start order) plus per-path
/// plunge/retract Z travel. `motion_sec` trapezoids each segment by kinematics.
pub fn estimate_mill(
    paths: &[MillPath],
    params: &MillParams,
    k: &Kinematics,
    safe_z: f64,
) -> MillEstimate {
    let passes = pass_count(params);

    // Non-empty contours and their perimeters / start points (panel space ==
    // machine space metrically; machine_point is an isometry).
    let mut perims: Vec<f64> = vec![];
    let mut starts: Vec<[f64; 2]> = vec![];
    for p in paths {
        if p.points.is_empty() {
            continue;
        }
        perims.push(contour_len(&p.points));
        starts.push(p.points[0]);
    }
    let path_count = perims.len();

    // Cut: feed-limited walk of each perimeter, once per pass.
    let mut cut_len_mm = 0.0;
    let mut motion_sec = 0.0;
    for &per in &perims {
        cut_len_mm += per * passes as f64;
        motion_sec += move_time(per, params.feed_xy_mm_min, k.accel_xy_mm_s2) * passes as f64;
    }

    // Travel: nearest-start ordering from 0,0, summing XY hops between contour
    // start vertices (rough — uses straight-line, ignores keep-out detours).
    let mut travel_len_mm = 0.0;
    if !starts.is_empty() {
        // Nearest-start ordering from the datum (machine 0,0), matching the
        // emitter's travel order.
        let order = order_nearest(&starts, 0.0, 0.0);
        let (mut cx, mut cy) = (0.0_f64, 0.0_f64);
        for &i in &order {
            let dx = starts[i][0] - cx;
            let dy = starts[i][1] - cy;
            let d = (dx * dx + dy * dy).sqrt();
            travel_len_mm += d;
            motion_sec += move_time(d, k.max_rate_xy_mm_min, k.accel_xy_mm_s2);
            cx = starts[i][0];
            cy = starts[i][1];
        }
        // Homing leg back to 0,0.
        let d = (cx * cx + cy * cy).sqrt();
        travel_len_mm += d;
        motion_sec += move_time(d, k.max_rate_xy_mm_min, k.accel_xy_mm_s2);
    }

    // Z moves: per contour, one plunge (feed = plunge rate) from safe_z to
    // -cut_depth, then one rapid retract back to safe_z. (Multi-depth keeps the
    // bit down between passes, so still one plunge + one retract per contour.)
    let z_span = safe_z + params.cut_depth_mm;
    for _ in 0..path_count {
        travel_len_mm += z_span * 2.0;
        motion_sec += move_time(z_span, params.plunge_mm_min, k.accel_z_mm_s2);
        motion_sec += move_time(z_span, k.max_rate_z_mm_min, k.accel_z_mm_s2);
    }

    MillEstimate {
        motion_sec,
        cut_len_mm,
        travel_len_mm,
        path_count,
    }
}

#[cfg(test)]
mod est_tests {
    use super::*;

    fn square() -> MillPath {
        MillPath {
            points: vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]],
        }
    }

    fn params() -> MillParams {
        MillParams {
            cut_depth_mm: 0.2,
            depth_per_pass_mm: None,
            feed_xy_mm_min: 200.0,
            plunge_mm_min: 60.0,
            climb: true,
        }
    }

    #[test]
    fn contour_len_closes_loop() {
        // 10x10 square perimeter = 40.
        assert!((contour_len(&square().points) - 40.0).abs() < 1e-9);
    }

    #[test]
    fn estimate_positive_and_counts_paths() {
        let k = Kinematics::default();
        let est = estimate_mill(&[square()], &params(), &k, 5.0);
        assert_eq!(est.path_count, 1);
        assert!(est.motion_sec > 0.0);
        assert!((est.cut_len_mm - 40.0).abs() < 1e-9);
        assert!(est.travel_len_mm > 0.0);
    }

    #[test]
    fn cut_len_grows_with_passes() {
        let k = Kinematics::default();
        let single = estimate_mill(&[square()], &params(), &k, 5.0);
        let mut multi = params();
        multi.cut_depth_mm = 0.6;
        multi.depth_per_pass_mm = Some(0.2); // 3 passes
        let est = estimate_mill(&[square()], &multi, &k, 5.0);
        assert_eq!(pass_count(&multi), 3);
        assert!((est.cut_len_mm - single.cut_len_mm * 3.0).abs() < 1e-9);
        assert!(est.motion_sec > single.motion_sec);
    }

    #[test]
    fn empty_paths_zero_paths() {
        let k = Kinematics::default();
        let est = estimate_mill(&[], &params(), &k, 5.0);
        assert_eq!(est.path_count, 0);
        assert_eq!(est.cut_len_mm, 0.0);
    }
}

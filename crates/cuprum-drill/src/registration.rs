// 2D rigid-body (+ optional uniform scale) transform fitting for fiducial
// registration: corrects board-placement error within the work frame (G54).
//
// `fit_transform` learns a similarity from (ideal, measured) point pairs;
// `apply` then maps any coordinate through it. The registration workflow feeds
// it machine-frame captures: the ideal point is the datum-relative work
// coordinate a fiducial should get once the zero is set (via `machine_point`),
// the measured point is the MPos captured with the spindle centred over it —
// no pre-set work zero is required. `solve_machine_frame` splits the fitted
// transform into the G54 origin (machine coords) plus a residual work-frame
// `Registration` with zero translation, which `apply` then uses to nudge
// datum-transformed hole coordinates during G-code emission.
//
// Usage pattern:
//   1. For each fiducial, compute its ideal datum-relative point
//      (`machine_point`) and capture the MPos with the spindle centred over it.
//   2. Call `solve_machine_frame` to get the G54 origin to program into the
//      controller plus the residual `Registration` (or an error on degenerate
//      input).
//   3. Call `reg.apply(wx, wy)` on an already-datum-transformed (work-frame)
//      hole coordinate to get the corrected work-frame coordinate.
//   4. Inspect `reg.rms_residual_mm` for fit quality.
//
// Coordinate convention: f64 mm throughout. No unit conversion is done here;
// callers are responsible.

use crate::types::MachineXY;

/// A 2D similarity transform: optional uniform scale, rotation, translation.
///
/// Both input and output are work-frame (G54) points (mm). It corrects a small
/// board-placement error, mapping an ideal work point `p` to the corrected
/// work point as:
///   `scale * R(angle) * p + translation`
///
/// where `R(angle)` is the 2×2 rotation matrix.
///
/// For a rigid-only fit `scale == 1.0`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    /// Uniform scale factor (1.0 for rigid-only, varies for similarity fit).
    pub scale: f64,
    /// Rotation angle in radians (counter-clockwise).
    pub angle_rad: f64,
    /// Translation vector in work space (G54) mm (board-placement offset component).
    /// Named object (not a tuple) so it serializes as `{ x, y }` for the frontend,
    /// matching the `MachineXY` convention.
    pub translation: MachineXY,
    /// RMS residual (mm) between transformed ideal points and measured points.
    /// Zero for exact fits (2-point rigid).
    pub rms_residual_mm: f64,
}

/// A single correspondence: ideal machine point and measured machine point (both in mm).
pub type PointPair = ((f64, f64), (f64, f64));

/// Errors returned by `fit_transform`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FitError {
    /// Fewer than 2 point pairs supplied — underdetermined.
    TooFewPoints,
    /// Two (or more) ideal points coincide — rotation is undefined.
    CoincidentIdealPoints,
    /// Two (or more) measured points coincide while their ideal counterparts
    /// differ — the measurement is inconsistent (scale would be zero).
    CoincidentMeasuredPoints,
}

impl std::fmt::Display for FitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FitError::TooFewPoints => write!(f, "at least 2 point pairs are required"),
            FitError::CoincidentIdealPoints => {
                write!(
                    f,
                    "two or more ideal points coincide; rotation is undefined"
                )
            }
            FitError::CoincidentMeasuredPoints => write!(
                f,
                "two or more measured points coincide while ideal points differ"
            ),
        }
    }
}

impl std::error::Error for FitError {}

impl Registration {
    /// Apply this correction to a work-frame (G54) point (already datum-transformed),
    /// returning the corrected work-frame point.
    #[inline]
    pub fn apply(&self, x: f64, y: f64) -> (f64, f64) {
        let cos_a = self.angle_rad.cos();
        let sin_a = self.angle_rad.sin();
        let rx = self.scale * (cos_a * x - sin_a * y);
        let ry = self.scale * (sin_a * x + cos_a * y);
        (rx + self.translation.x, ry + self.translation.y)
    }
}

/// Fit a `Registration` from a list of `(ideal_machine, measured_machine)` pairs.
///
/// # Algorithm
/// - **2 pairs**: Exact rigid + uniform-scale similarity from the two-vector
///   correspondence. Scale is derived from `|measured| / |ideal|` (ratio of
///   segment lengths). The returned `rms_residual_mm` is 0.0.
/// - **3+ pairs**: Umeyama / closed-form least-squares similarity (rotation +
///   translation, with uniform scale). The algorithm is the standard 2D
///   Procrustes: demean both point sets, compute the cross-covariance, derive
///   the optimal rotation from `atan2` of its SVD-equivalent for 2D, then back-
///   solve translation and scale. Returns `rms_residual_mm > 0` for noisy data.
///
/// # Scale behaviour
/// The fit always solves for an optimal uniform scale (similarity, not rigid).
/// In practice, if the measured points were acquired with a well-calibrated
/// machine, the scale will be very close to 1.0. Callers that want strictly
/// rigid (scale=1) can clamp `result.scale = 1.0` and recompute residual, but
/// for registration purposes the similarity fit gives a better-conditioned
/// solution and the fitted scale encodes any board-shrinkage / machine
/// calibration error.
///
/// # Errors
/// Returns `Err(FitError)` for degenerate inputs (see [`FitError`]).
pub fn fit_transform(pairs: &[PointPair]) -> Result<Registration, FitError> {
    let n = pairs.len();
    if n < 2 {
        return Err(FitError::TooFewPoints);
    }

    // Check for coincident ideal points: any two ideal points must differ.
    for i in 0..n {
        for j in (i + 1)..n {
            let (pi, _) = pairs[i];
            let (pj, _) = pairs[j];
            if dist2(pi, pj) < f64::EPSILON * f64::EPSILON {
                return Err(FitError::CoincidentIdealPoints);
            }
        }
    }

    if n == 2 {
        return fit_exact_2pt(pairs[0], pairs[1]);
    }

    // Check for coincident measured points: if every measured point lands on
    // the same spot while ideal points differ, scale degenerates to ~0. Mirror
    // the ideal-point check above. (For n == 2 this is handled inside
    // fit_exact_2pt; here it guards the 3+ path.)
    if pairs
        .iter()
        .all(|&(_, m)| dist2(m, pairs[0].1) < f64::EPSILON * f64::EPSILON)
    {
        return Err(FitError::CoincidentMeasuredPoints);
    }

    // 3+ points: closed-form Umeyama (2D).
    fit_umeyama(pairs)
}

/// Result of `solve_machine_frame`: a machine-frame fit split into a work
/// origin (to be programmed as the G54 offset) plus a residual work-frame
/// `Registration` whose translation is zero by construction.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineFrameSolve {
    /// Machine coordinates of the new G54 origin (= `T(0,0)`).
    pub work_origin: MachineXY,
    /// Residual work-frame registration (translation is zero by construction;
    /// `rms_residual_mm` is inherited from the underlying fit).
    pub registration: Registration,
}

/// Fit a panel→machine similarity from `(ideal_panel, measured_machine)` pairs
/// and split it into a work-coordinate origin plus a residual work-frame
/// `Registration`.
///
/// `T(p) = s·R(θ)·p + t` maps ideal panel/work coordinates to machine
/// coordinates. Setting the G54 origin at `T(0,0) = t` (a pure translation)
/// leaves the residual work-frame mapping `m_work = s·R(θ)·p`, i.e. a
/// `Registration` with zero translation. This lets the caller program the work
/// zero from the solve instead of requiring a pre-set G54 origin.
///
/// # Errors
/// Same degenerate-input errors as [`fit_transform`].
pub fn solve_machine_frame(pairs: &[PointPair]) -> Result<MachineFrameSolve, FitError> {
    let full = fit_transform(pairs)?;
    let work_origin = full.translation;
    let registration = Registration {
        translation: MachineXY { x: 0.0, y: 0.0 },
        ..full
    };
    Ok(MachineFrameSolve {
        work_origin,
        registration,
    })
}

// --- Internal helpers -------------------------------------------------------

#[inline]
fn dist2(a: (f64, f64), b: (f64, f64)) -> f64 {
    let dx = a.0 - b.0;
    let dy = a.1 - b.1;
    dx * dx + dy * dy
}

/// Exact 2-point similarity fit.
fn fit_exact_2pt(p0: PointPair, p1: PointPair) -> Result<Registration, FitError> {
    let (a0, b0) = p0;
    let (a1, b1) = p1;

    // Vectors in each space.
    let da = (a1.0 - a0.0, a1.1 - a0.1); // ideal
    let db = (b1.0 - b0.0, b1.1 - b0.1); // measured

    let len_a2 = da.0 * da.0 + da.1 * da.1;
    let len_b2 = db.0 * db.0 + db.1 * db.1;

    // len_a can't be zero: already checked coincident ideal points above.
    let len_a = len_a2.sqrt();

    // If measured points coincide while ideal differ → degenerate scale.
    if len_b2 < f64::EPSILON * f64::EPSILON {
        return Err(FitError::CoincidentMeasuredPoints);
    }
    let len_b = len_b2.sqrt();

    let scale = len_b / len_a;

    // Rotation: angle of db minus angle of da.
    let angle_a = da.1.atan2(da.0);
    let angle_b = db.1.atan2(db.0);
    let angle_rad = angle_b - angle_a;

    // Translation: t = b0 - scale * R * a0.
    let cos_a = angle_rad.cos();
    let sin_a = angle_rad.sin();
    let rx = scale * (cos_a * a0.0 - sin_a * a0.1);
    let ry = scale * (sin_a * a0.0 + cos_a * a0.1);
    let translation = MachineXY {
        x: b0.0 - rx,
        y: b0.1 - ry,
    };

    Ok(Registration {
        scale,
        angle_rad,
        translation,
        rms_residual_mm: 0.0,
    })
}

/// Closed-form Umeyama similarity for n >= 3 pairs.
///
/// Reference: Umeyama, "Least-squares estimation of transformation parameters
/// between two point patterns", IEEE PAMI 1991, adapted for 2D.
fn fit_umeyama(pairs: &[PointPair]) -> Result<Registration, FitError> {
    let n = pairs.len() as f64;

    // Centroid of ideal (source) and measured (target).
    let mut mu_s = (0.0_f64, 0.0_f64);
    let mut mu_t = (0.0_f64, 0.0_f64);
    for &(s, t) in pairs {
        mu_s.0 += s.0;
        mu_s.1 += s.1;
        mu_t.0 += t.0;
        mu_t.1 += t.1;
    }
    mu_s.0 /= n;
    mu_s.1 /= n;
    mu_t.0 /= n;
    mu_t.1 /= n;

    // Variance of source, cross-covariance.
    // sigma_s^2 = (1/n) * sum ||s_i - mu_s||^2
    // H = (1/n) * sum (t_i - mu_t)(s_i - mu_s)^T   [2×2 outer product, row-major]
    let mut sigma_s2 = 0.0_f64;
    // H = [[h00, h01], [h10, h11]]
    let mut h00 = 0.0_f64;
    let mut h01 = 0.0_f64;
    let mut h10 = 0.0_f64;
    let mut h11 = 0.0_f64;

    for &(s, t) in pairs {
        let ds = (s.0 - mu_s.0, s.1 - mu_s.1);
        let dt = (t.0 - mu_t.0, t.1 - mu_t.1);
        sigma_s2 += ds.0 * ds.0 + ds.1 * ds.1;
        // H += dt^T * ds  (outer product, target row × source col)
        h00 += dt.0 * ds.0;
        h01 += dt.0 * ds.1;
        h10 += dt.1 * ds.0;
        h11 += dt.1 * ds.1;
    }
    sigma_s2 /= n;
    h00 /= n;
    h01 /= n;
    h10 /= n;
    h11 /= n;

    // 2D SVD-less rotation: for a 2×2 cross-covariance H the optimal rotation
    // can be extracted analytically. The SVD of H = U S V^T in 2D gives
    // R = U * diag(1, det(U)*det(V)) * V^T, but we can compute the atan2 of
    // the dominant term directly from H:
    //   For 2D: angle = atan2( H[1,0] - H[0,1], H[0,0] + H[1,1] )
    // This is equivalent to finding the angle that maximises trace(R^T H).
    let angle_rad = (h10 - h01).atan2(h00 + h11);

    let cos_a = angle_rad.cos();
    let sin_a = angle_rad.sin();

    // Optimal scale: sigma_s^2 must be nonzero (already guarded by coincident check).
    // s* = trace(S) / sigma_s^2  where trace(S) = sqrt(det(H)^0.5 * 2) ... actually:
    // For 2D: s* = (h00*cos_a + h10*sin_a + h01*(-sin_a) + h11*cos_a) / sigma_s^2
    //            = trace(R^T * H) / sigma_s^2
    let trace_rh = cos_a * h00 + sin_a * h10 + (-sin_a) * h01 + cos_a * h11;
    let scale = if sigma_s2 > f64::EPSILON {
        trace_rh / sigma_s2
    } else {
        1.0
    };

    // Translation: mu_t - scale * R * mu_s.
    let rx = scale * (cos_a * mu_s.0 - sin_a * mu_s.1);
    let ry = scale * (sin_a * mu_s.0 + cos_a * mu_s.1);
    let translation = MachineXY {
        x: mu_t.0 - rx,
        y: mu_t.1 - ry,
    };

    let reg = Registration {
        scale,
        angle_rad,
        translation,
        rms_residual_mm: 0.0,
    };

    // Compute RMS residual.
    let mut sq_sum = 0.0_f64;
    for &(s, t) in pairs {
        let pred = reg.apply(s.0, s.1);
        let dx = pred.0 - t.0;
        let dy = pred.1 - t.1;
        sq_sum += dx * dx + dy * dy;
    }
    let rms = (sq_sum / n).sqrt();

    Ok(Registration {
        rms_residual_mm: rms,
        ..reg
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const EPS: f64 = 1e-9;

    fn assert_approx(a: f64, b: f64, tol: f64, label: &str) {
        assert!(
            (a - b).abs() < tol,
            "{label}: expected {b:.6}, got {a:.6} (diff {:.2e})",
            (a - b).abs()
        );
    }

    /// Compare two angles modulo 2π, i.e. check that cos/sin values match.
    fn assert_angle_approx(a: f64, b: f64, tol: f64, label: &str) {
        let diff = ((a - b + std::f64::consts::PI).rem_euclid(std::f64::consts::TAU)
            - std::f64::consts::PI)
            .abs();
        assert!(
            diff < tol,
            "{label}: expected angle {b:.6} rad, got {a:.6} rad (angular diff {diff:.2e})"
        );
    }

    fn make_pairs(transform: &Registration, pts: &[(f64, f64)]) -> Vec<PointPair> {
        pts.iter()
            .map(|&(x, y)| ((x, y), transform.apply(x, y)))
            .collect()
    }

    // Helper: make a Registration for test setup (we ignore rms there).
    fn reg(scale: f64, angle_rad: f64, tx: f64, ty: f64) -> Registration {
        Registration {
            scale,
            angle_rad,
            translation: MachineXY { x: tx, y: ty },
            rms_residual_mm: 0.0,
        }
    }

    // -----------------------------------------------------------------------
    // Degenerate / error cases
    // -----------------------------------------------------------------------

    #[test]
    fn error_too_few_points_zero() {
        assert_eq!(fit_transform(&[]), Err(FitError::TooFewPoints));
    }

    #[test]
    fn error_too_few_points_one() {
        assert_eq!(
            fit_transform(&[((0.0, 0.0), (1.0, 2.0))]),
            Err(FitError::TooFewPoints)
        );
    }

    #[test]
    fn error_coincident_ideal_two_pts() {
        // Both ideal points are the same.
        let pairs = [((1.0, 1.0), (2.0, 3.0)), ((1.0, 1.0), (5.0, 6.0))];
        assert_eq!(fit_transform(&pairs), Err(FitError::CoincidentIdealPoints));
    }

    #[test]
    fn error_coincident_ideal_three_pts() {
        let pairs = [
            ((1.0, 0.0), (2.0, 0.0)),
            ((2.0, 0.0), (3.0, 0.0)),
            ((1.0, 0.0), (4.0, 0.0)), // duplicate of first ideal
        ];
        assert_eq!(fit_transform(&pairs), Err(FitError::CoincidentIdealPoints));
    }

    #[test]
    fn error_coincident_measured_two_pts() {
        // Ideal points differ, but measured land on same spot.
        let pairs = [((0.0, 0.0), (5.0, 5.0)), ((10.0, 0.0), (5.0, 5.0))];
        assert_eq!(
            fit_transform(&pairs),
            Err(FitError::CoincidentMeasuredPoints)
        );
    }

    #[test]
    fn error_coincident_measured_three_pts() {
        // n >= 3 path: distinct ideal points, all measured collapse to one spot.
        let pairs = [
            ((0.0, 0.0), (5.0, 5.0)),
            ((10.0, 0.0), (5.0, 5.0)),
            ((5.0, 8.0), (5.0, 5.0)),
        ];
        assert_eq!(
            fit_transform(&pairs),
            Err(FitError::CoincidentMeasuredPoints)
        );
    }

    // -----------------------------------------------------------------------
    // 2-point exact fit — apply roundtrip
    // -----------------------------------------------------------------------

    #[test]
    fn two_pt_pure_translation() {
        let t = reg(1.0, 0.0, 15.0, -7.0);
        let pts = [(0.0, 0.0), (10.0, 5.0)];
        let pairs = make_pairs(&t, &pts);
        let fit = fit_transform(&pairs).unwrap();
        assert_approx(fit.scale, 1.0, EPS, "scale");
        assert_approx(fit.angle_rad, 0.0, EPS, "angle");
        assert_approx(fit.translation.x, 15.0, EPS, "tx");
        assert_approx(fit.translation.y, -7.0, EPS, "ty");
        assert_approx(fit.rms_residual_mm, 0.0, EPS, "rms");
        // Roundtrip on a third point not in the fit.
        let pred = fit.apply(20.0, 3.0);
        let expected = t.apply(20.0, 3.0);
        assert_approx(pred.0, expected.0, EPS, "x");
        assert_approx(pred.1, expected.1, EPS, "y");
    }

    #[test]
    fn two_pt_pure_rotation_90_deg() {
        let angle = std::f64::consts::FRAC_PI_2; // 90°
        let t = reg(1.0, angle, 0.0, 0.0);
        let pts = [(1.0, 0.0), (0.0, 1.0)];
        let pairs = make_pairs(&t, &pts);
        let fit = fit_transform(&pairs).unwrap();
        assert_approx(fit.scale, 1.0, 1e-12, "scale");
        // Angle is unique modulo 2π; verify by geometric equivalence.
        assert_angle_approx(fit.angle_rad, angle, 1e-12, "angle");
        assert_approx(fit.rms_residual_mm, 0.0, EPS, "rms");
        // (1,0) rotated 90° → (0,1)
        let pred = fit.apply(1.0, 0.0);
        assert_approx(pred.0, 0.0, 1e-12, "x");
        assert_approx(pred.1, 1.0, 1e-12, "y");
    }

    #[test]
    fn two_pt_rotation_and_translation() {
        let angle = std::f64::consts::PI / 6.0; // 30°
        let t = reg(1.0, angle, 5.0, -3.0);
        let pts = [(10.0, 0.0), (0.0, 10.0)];
        let pairs = make_pairs(&t, &pts);
        let fit = fit_transform(&pairs).unwrap();
        assert_approx(fit.scale, 1.0, 1e-10, "scale");
        assert_approx(fit.angle_rad, angle, 1e-10, "angle");
        assert_approx(fit.translation.x, 5.0, 1e-10, "tx");
        assert_approx(fit.translation.y, -3.0, 1e-10, "ty");
        // Verify roundtrip for a fresh point.
        let pt = (15.0, 8.0);
        let pred = fit.apply(pt.0, pt.1);
        let expected = t.apply(pt.0, pt.1);
        assert_approx(pred.0, expected.0, 1e-10, "x");
        assert_approx(pred.1, expected.1, 1e-10, "y");
    }

    #[test]
    fn two_pt_with_scale() {
        // Scale 1.5, 45° rotation, translation (2, 3).
        let t = reg(1.5, std::f64::consts::FRAC_PI_4, 2.0, 3.0);
        let pts = [(4.0, 0.0), (0.0, 4.0)];
        let pairs = make_pairs(&t, &pts);
        let fit = fit_transform(&pairs).unwrap();
        assert_approx(fit.scale, 1.5, 1e-10, "scale");
        assert_approx(fit.angle_rad, std::f64::consts::FRAC_PI_4, 1e-10, "angle");
        assert_approx(fit.rms_residual_mm, 0.0, EPS, "rms");
    }

    // -----------------------------------------------------------------------
    // 3+ point Umeyama fit
    // -----------------------------------------------------------------------

    #[test]
    fn three_pt_pure_translation_exact() {
        let t = reg(1.0, 0.0, -4.0, 11.0);
        let pts = [(0.0, 0.0), (10.0, 0.0), (5.0, 8.0)];
        let pairs = make_pairs(&t, &pts);
        let fit = fit_transform(&pairs).unwrap();
        assert_approx(fit.scale, 1.0, 1e-10, "scale");
        assert_approx(fit.angle_rad, 0.0, 1e-10, "angle");
        assert_approx(fit.translation.x, -4.0, 1e-10, "tx");
        assert_approx(fit.translation.y, 11.0, 1e-10, "ty");
        assert_approx(fit.rms_residual_mm, 0.0, 1e-9, "rms");
    }

    #[test]
    fn three_pt_rotation_45_deg_exact() {
        let angle = std::f64::consts::FRAC_PI_4;
        let t = reg(1.0, angle, 0.0, 0.0);
        let pts = [(10.0, 0.0), (0.0, 10.0), (-10.0, 0.0)];
        let pairs = make_pairs(&t, &pts);
        let fit = fit_transform(&pairs).unwrap();
        assert_approx(fit.scale, 1.0, 1e-10, "scale");
        assert_approx(fit.angle_rad, angle, 1e-10, "angle");
        assert_approx(fit.rms_residual_mm, 0.0, 1e-9, "rms");
    }

    #[test]
    fn three_pt_rotation_and_translation_exact() {
        let angle = std::f64::consts::PI / 3.0; // 60°
        let t = reg(1.0, angle, 8.0, -5.0);
        let pts = [(0.0, 0.0), (20.0, 0.0), (10.0, 15.0)];
        let pairs = make_pairs(&t, &pts);
        let fit = fit_transform(&pairs).unwrap();
        assert_approx(fit.scale, 1.0, 1e-9, "scale");
        assert_approx(fit.angle_rad, angle, 1e-9, "angle");
        assert_approx(fit.translation.x, 8.0, 1e-9, "tx");
        assert_approx(fit.translation.y, -5.0, 1e-9, "ty");
        assert_approx(fit.rms_residual_mm, 0.0, 1e-7, "rms");
        // Roundtrip on new point.
        let pred = fit.apply(5.0, 5.0);
        let expected = t.apply(5.0, 5.0);
        assert_approx(pred.0, expected.0, 1e-9, "x");
        assert_approx(pred.1, expected.1, 1e-9, "y");
    }

    #[test]
    fn four_pt_with_noise_residual_positive() {
        // Generate 4 points from a known transform, then add small noise.
        let t = reg(1.0, 0.1, 3.0, -2.0);
        let pts = [(0.0, 0.0), (50.0, 0.0), (50.0, 30.0), (0.0, 30.0)];
        let noise = [(0.05, -0.03), (-0.04, 0.02), (0.03, 0.06), (-0.05, -0.04)];
        let pairs: Vec<_> = pts
            .iter()
            .zip(noise.iter())
            .map(|(&(x, y), &(nx, ny))| {
                let (tx, ty) = t.apply(x, y);
                ((x, y), (tx + nx, ty + ny))
            })
            .collect();
        let fit = fit_transform(&pairs).unwrap();
        // RMS should be in noise range (not zero, not huge).
        assert!(
            fit.rms_residual_mm > 1e-4,
            "expected rms > 1e-4 with noise, got {}",
            fit.rms_residual_mm
        );
        assert!(
            fit.rms_residual_mm < 0.2,
            "expected rms < 0.2 with small noise, got {}",
            fit.rms_residual_mm
        );
        // Fitted transform should still be close to the truth.
        assert_approx(fit.scale, 1.0, 0.01, "scale");
        assert_approx(fit.angle_rad, 0.1, 0.01, "angle");
        assert_approx(fit.translation.x, 3.0, 0.15, "tx");
        assert_approx(fit.translation.y, -2.0, 0.15, "ty");
    }

    #[test]
    fn five_pt_similarity_with_scale_exact() {
        // Similarity (scale != 1) recovered exactly when no noise.
        let t = reg(0.98, std::f64::consts::PI / 8.0, 1.0, 2.0);
        let pts = [
            (0.0, 0.0),
            (40.0, 0.0),
            (40.0, 25.0),
            (0.0, 25.0),
            (20.0, 12.5),
        ];
        let pairs = make_pairs(&t, &pts);
        let fit = fit_transform(&pairs).unwrap();
        assert_approx(fit.scale, 0.98, 1e-8, "scale");
        assert_approx(fit.angle_rad, std::f64::consts::PI / 8.0, 1e-8, "angle");
        assert_approx(fit.rms_residual_mm, 0.0, 1e-8, "rms");
    }

    // -----------------------------------------------------------------------
    // apply() correctness
    // -----------------------------------------------------------------------

    #[test]
    fn apply_identity_is_noop() {
        let r = reg(1.0, 0.0, 0.0, 0.0);
        let (x, y) = r.apply(7.5, -3.2);
        assert_approx(x, 7.5, EPS, "x");
        assert_approx(y, -3.2, EPS, "y");
    }

    // -----------------------------------------------------------------------
    // solve_machine_frame — origin split
    // -----------------------------------------------------------------------

    #[test]
    fn machine_frame_two_pt_origin_and_residual() {
        // Panel rotated 5° and its datum sitting at machine (120, 80).
        let angle = 5.0_f64.to_radians();
        let t = reg(1.0, angle, 120.0, 80.0);
        let pts = [(10.0, 5.0), (90.0, 5.0)];
        let pairs = make_pairs(&t, &pts);
        let solve = solve_machine_frame(&pairs).unwrap();
        // T(0,0) must land on the machine position of the panel datum.
        assert_approx(solve.work_origin.x, 120.0, EPS, "origin x");
        assert_approx(solve.work_origin.y, 80.0, EPS, "origin y");
        // Residual translation is zero by construction.
        assert_approx(solve.registration.translation.x, 0.0, EPS, "res tx");
        assert_approx(solve.registration.translation.y, 0.0, EPS, "res ty");
        // residual.apply(ideal) == measured − work_origin for every pair.
        for &((ix, iy), (mx, my)) in &pairs {
            let (rx, ry) = solve.registration.apply(ix, iy);
            assert_approx(rx, mx - solve.work_origin.x, EPS, "res x");
            assert_approx(ry, my - solve.work_origin.y, EPS, "res y");
        }
    }

    #[test]
    fn machine_frame_three_pt_origin_and_residual() {
        let angle = -2.0_f64.to_radians();
        let t = reg(1.0, angle, 55.5, 210.25);
        let pts = [(10.0, 5.0), (90.0, 5.0), (50.0, 60.0)];
        let pairs = make_pairs(&t, &pts);
        let solve = solve_machine_frame(&pairs).unwrap();
        assert_approx(solve.work_origin.x, 55.5, EPS, "origin x");
        assert_approx(solve.work_origin.y, 210.25, EPS, "origin y");
        assert_approx(solve.registration.translation.x, 0.0, EPS, "res tx");
        assert_approx(solve.registration.translation.y, 0.0, EPS, "res ty");
        assert_angle_approx(solve.registration.angle_rad, angle, EPS, "res angle");
        // rms is preserved from the underlying fit (exact input → 0).
        assert_approx(solve.registration.rms_residual_mm, 0.0, 1e-9, "rms");
        for &((ix, iy), (mx, my)) in &pairs {
            let (rx, ry) = solve.registration.apply(ix, iy);
            assert_approx(rx, mx - solve.work_origin.x, EPS, "res x");
            assert_approx(ry, my - solve.work_origin.y, EPS, "res y");
        }
    }

    #[test]
    fn machine_frame_degenerate_propagates_error() {
        assert_eq!(solve_machine_frame(&[]), Err(FitError::TooFewPoints));
        let pairs = [((1.0, 1.0), (2.0, 3.0)), ((1.0, 1.0), (5.0, 6.0))];
        assert_eq!(
            solve_machine_frame(&pairs),
            Err(FitError::CoincidentIdealPoints)
        );
    }

    #[test]
    fn machine_frame_noise_preserves_rms() {
        let t = reg(1.0, 0.05, 200.0, 150.0);
        let pts = [(0.0, 0.0), (50.0, 0.0), (50.0, 30.0), (0.0, 30.0)];
        let noise = [(0.05, -0.03), (-0.04, 0.02), (0.03, 0.06), (-0.05, -0.04)];
        let pairs: Vec<_> = pts
            .iter()
            .zip(noise.iter())
            .map(|(&(x, y), &(nx, ny))| {
                let (tx, ty) = t.apply(x, y);
                ((x, y), (tx + nx, ty + ny))
            })
            .collect();
        let full = fit_transform(&pairs).unwrap();
        let solve = solve_machine_frame(&pairs).unwrap();
        assert_approx(
            solve.registration.rms_residual_mm,
            full.rms_residual_mm,
            EPS,
            "rms preserved",
        );
        assert_approx(solve.work_origin.x, full.translation.x, EPS, "origin x");
        assert_approx(solve.work_origin.y, full.translation.y, EPS, "origin y");
    }

    #[test]
    fn apply_180_deg_rotation() {
        let r = reg(1.0, std::f64::consts::PI, 0.0, 0.0);
        let (x, y) = r.apply(3.0, 4.0);
        assert_approx(x, -3.0, 1e-12, "x");
        assert_approx(y, -4.0, 1e-12, "y");
    }
}

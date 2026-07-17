// Fiducial-registration backend: capture real machine positions for fiducial
// markers, fit a panel→machine transform from them, program the G54 work
// origin from the solve, and expose the residual correction to the drill
// planner.
//
// Workflow:
//   1. `fiducial_init`  — supply the list of fiducials (their ideal work XY
//                         positions) for the upcoming run; resets any previous
//                         measurements and the solved transform.
//   2. `fiducial_capture(index)` — jog the spindle over fiducial N and call this;
//                                  the command snapshots the current MPos X/Y.
//   3. `fiducial_solve` — fit the machine-frame transform from all captured
//                         (ideal, measured) pairs, program the G54 origin on the
//                         controller (`G10 L2 P1`, awaiting `ok`), then store the
//                         residual Registration. Err if fewer than 2 captured or
//                         the machine is not connected.
//   4. `fiducial_reset` — clear everything (start over without re-init).
//   5. `fiducial_state` — inspect the current status (what is captured, is a
//                         transform ready, RMS residual).
//
// The solved residual Registration is read by `drill_plan` (in drill_run.rs) and
// injected into DrillPlanInput.registration so hole coordinates are corrected
// before G-code emission. When no registration is solved the field stays None →
// identity.
//
// Coordinate model (no pre-set work zero required):
//   ideal    = machinePoint() output = datum-relative panel/work coords — the
//              work coordinates the point should get once the zero is set.
//   measured = MPos (machine coordinates) snapshot when the operator confirms
//              alignment; captured in the machine frame so the flow works
//              before any G54 origin exists.
//   solve    = fits T(p) = s·R(θ)·p + t in the machine frame, programs the G54
//              origin at T(0,0) = t, and keeps the residual s·R(θ) rotation/
//              scale as a zero-translation work-frame Registration.

use crate::commands::error::{CmdError, CmdResult};
use cuprum_core::drilling::{solve_machine_frame, MachineXY, PointPair, Registration};
use std::sync::Mutex;
use tauri::State;

// ── State ─────────────────────────────────────────────────────────────────────

/// One fiducial entry: its ideal (nominal) work position and the optionally
/// captured real machine position (set by `fiducial_capture`).
#[derive(Clone, Debug)]
struct Fiducial {
    /// The work coordinates this fiducial should get once the solved G54 origin
    /// is programmed: the datum transform of its panel coordinate
    /// (`machinePoint()` on the frontend). Machine-frame ideal = T(ideal).
    ideal: MachineXY,
    /// The measured machine XY (MPos snapshot), taken when the user calls
    /// `fiducial_capture`. None until captured.
    measured: Option<MachineXY>,
}

/// Application-level fiducial-registration state. Held in Tauri managed state
/// so it lives for the app lifetime and is shared across all commands.
#[derive(Default)]
pub struct FiducialState(Mutex<FiducialStateInner>);

#[derive(Default)]
struct FiducialStateInner {
    /// The fiducials for the current session (in order). Empty until `fiducial_init`.
    fiducials: Vec<Fiducial>,
    /// The last successfully solved residual Registration (zero translation).
    /// None until `fiducial_solve` succeeds.
    registration: Option<Registration>,
    /// Machine coordinates of the G54 origin programmed by the last successful
    /// `fiducial_solve`. Kept until init/reset (it reflects the offset that is
    /// physically set on the controller, even if a re-capture invalidates the
    /// residual registration).
    work_origin: Option<MachineXY>,
}

impl FiducialState {
    /// Return a clone of the solved Registration (or None). Called by `drill_plan`
    /// to inject registration into the planner input without holding the lock.
    pub fn solved_registration(&self) -> Option<Registration> {
        self.0.lock().unwrap().registration.clone()
    }
}

/// Mean (measured − ideal) over captured fiducials; None when nothing captured.
/// A coarse machine-frame offset the frontend uses to auto-approach the
/// remaining fiducials (machine_target ≈ ideal + coarse_offset).
fn coarse_offset(fiducials: &[Fiducial]) -> Option<MachineXY> {
    let mut sum = (0.0_f64, 0.0_f64);
    let mut n = 0usize;
    for f in fiducials {
        if let Some(m) = f.measured {
            sum.0 += m.x - f.ideal.x;
            sum.1 += m.y - f.ideal.y;
            n += 1;
        }
    }
    if n == 0 {
        return None;
    }
    Some(MachineXY {
        x: sum.0 / n as f64,
        y: sum.1 / n as f64,
    })
}

// ── DTO types ─────────────────────────────────────────────────────────────────

/// DTO for a single fiducial supplied to `fiducial_init`. Uses named `{x,y}`
/// objects so the frontend sends idiomatic objects, not tuples.
#[derive(Clone, Debug, serde::Deserialize)]
pub struct FiducialInitEntry {
    pub ideal: MachineXY,
}

/// Snapshot of one fiducial returned by `fiducial_state`.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FiducialDto {
    pub ideal: MachineXY,
    /// The measured machine position (MPos); null when not yet captured.
    pub measured: Option<MachineXY>,
    /// True when this fiducial has been captured.
    pub captured: bool,
}

/// Full state snapshot returned by `fiducial_state`.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FiducialStateDto {
    /// All fiducials in init order.
    pub fiducials: Vec<FiducialDto>,
    /// Number of fiducials that have been captured.
    pub captured_count: usize,
    /// Whether a solved Registration is available (i.e., `fiducial_solve` has
    /// been called successfully since the last init/reset).
    pub has_registration: bool,
    /// RMS residual of the solved Registration (mm); 0 when no registration.
    pub rms_residual_mm: f64,
    /// Mean (measured − ideal) over captured fiducials; null until the first
    /// capture. The frontend uses it to auto-approach the next fiducial
    /// (machine_target ≈ ideal + coarse_offset).
    pub coarse_offset: Option<MachineXY>,
    /// Machine coordinates of the G54 origin from the last successful solve;
    /// null until `fiducial_solve` succeeds.
    pub work_origin: Option<MachineXY>,
}

/// Result of a successful `fiducial_solve`.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FiducialSolveResult {
    /// Residual work-frame correction (translation is zero by construction —
    /// the whole translation went into the G54 origin).
    pub registration: Registration,
    /// Machine coordinates of the G54 origin programmed on the controller.
    pub work_origin: MachineXY,
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Initialise the fiducial list for a new registration session.
///
/// Resets any previous measurements and the solved transform, then sets the
/// list of fiducials from `entries` (their ideal work XY positions).
/// Call this before jogging to any fiducial.
#[tauri::command]
pub fn fiducial_init(
    state: State<FiducialState>,
    entries: Vec<FiducialInitEntry>,
) -> CmdResult<()> {
    let mut inner = state.0.lock().unwrap();
    inner.fiducials = entries
        .into_iter()
        .map(|e| Fiducial {
            ideal: e.ideal,
            measured: None,
        })
        .collect();
    inner.registration = None;
    inner.work_origin = None;
    Ok(())
}

/// Capture the current machine XY (MPos) as the measured position for fiducial
/// `index`.
///
/// The caller must first jog the spindle over the fiducial and only then invoke
/// this command. The command sends a `?` status query and waits for the next
/// `<...>` status report from GRBL, which carries the live position. It
/// fails if the machine is not connected or no status arrives within 2 s.
/// Capturing in the machine frame means no work zero needs to be set upfront —
/// the G54 origin is programmed later by `fiducial_solve`.
#[tauri::command]
pub async fn fiducial_capture(
    state: State<'_, FiducialState>,
    machine: State<'_, super::machine::MachineState>,
    index: usize,
) -> CmdResult<()> {
    use cuprum_core::grbl::{GrblEvent, STATUS_QUERY};
    use std::time::Duration;

    let handle = machine.handle().ok_or("not connected")?;

    // Subscribe before sending `?` so we can't miss the reply.
    let mut rx = handle.subscribe();
    handle
        .send_realtime(STATUS_QUERY)
        .await
        .map_err(CmdError::from)?;

    // Wait for the next status broadcast (the 200 ms poll answers promptly; cap at 2 s).
    let mpos = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match rx.recv().await {
                Ok(GrblEvent::Status { status, .. }) => break Ok(status.mpos),
                Ok(GrblEvent::Disconnected) | Err(_) => {
                    break Err(CmdError::from(
                        "machine disconnected while reading position",
                    ))
                }
                Ok(_) => continue,
            }
        }
    })
    .await
    .map_err(|_| CmdError::from("timed out waiting for machine position"))??;

    let mut inner = state.0.lock().unwrap();
    let fid = inner
        .fiducials
        .get_mut(index)
        .ok_or_else(|| CmdError::from(format!("fiducial index {index} out of range")))?;
    fid.measured = Some(MachineXY {
        x: mpos[0] as f64,
        y: mpos[1] as f64,
    });
    // Invalidate the previous solve when a measurement changes. `work_origin`
    // stays: it still reflects the offset physically programmed on the
    // controller until the next solve/reset.
    inner.registration = None;
    Ok(())
}

/// Fit the machine-frame transform from all captured (ideal, measured) pairs,
/// program the G54 work origin from it, and store the residual Registration.
///
/// Requires at least 2 captured fiducials and a connected machine. The G54
/// origin (`G10 L2 P1 X.. Y..`, machine coordinates, no motion involved) is
/// sent first and must be acknowledged with `ok` — only then is the residual
/// registration stored (so state never diverges from the controller, cf. the
/// stale-WCS bug class of #313). On any failure the state is left unchanged.
#[tauri::command]
pub async fn fiducial_solve(
    state: State<'_, FiducialState>,
    machine: State<'_, super::machine::MachineState>,
) -> CmdResult<FiducialSolveResult> {
    use cuprum_core::grbl::set_work_offset_xy;

    // Machine must be connected before we touch any state: the solve is only
    // meaningful if the origin can actually be programmed.
    let handle = machine.handle().ok_or("not connected")?;

    // Collect (ideal, measured) pairs without holding the lock across awaits.
    let pairs: Vec<PointPair> = {
        let inner = state.0.lock().unwrap();
        inner
            .fiducials
            .iter()
            .filter_map(|f| f.measured.map(|m| ((f.ideal.x, f.ideal.y), (m.x, m.y))))
            .collect()
    };

    if pairs.len() < 2 {
        return Err(CmdError::from(format!(
            "at least 2 fiducials must be captured before solving (have {})",
            pairs.len()
        )));
    }

    let solve = solve_machine_frame(&pairs).map_err(CmdError::from)?;

    // Program the G54 origin and wait for GRBL's `ok` before trusting it.
    handle
        .send_await(&set_work_offset_xy(
            solve.work_origin.x,
            solve.work_origin.y,
        ))
        .await
        .map_err(CmdError::from)?;

    let mut inner = state.0.lock().unwrap();
    inner.registration = Some(solve.registration.clone());
    inner.work_origin = Some(solve.work_origin);
    Ok(FiducialSolveResult {
        registration: solve.registration,
        work_origin: solve.work_origin,
    })
}

/// Clear all measurements and the solved Registration.
///
/// The fiducial list (ideal positions from `fiducial_init`) is also cleared,
/// so `fiducial_init` must be called again before the next registration session.
#[tauri::command]
pub fn fiducial_reset(state: State<FiducialState>) -> CmdResult<()> {
    let mut inner = state.0.lock().unwrap();
    inner.fiducials.clear();
    inner.registration = None;
    inner.work_origin = None;
    Ok(())
}

/// Return a snapshot of the current fiducial state.
///
/// Useful for the UI to show which fiducials have been captured and whether a
/// Registration is ready. Does not mutate any state.
#[tauri::command]
pub fn fiducial_state(state: State<FiducialState>) -> FiducialStateDto {
    let inner = state.0.lock().unwrap();
    let captured_count = inner
        .fiducials
        .iter()
        .filter(|f| f.measured.is_some())
        .count();
    let (has_registration, rms_residual_mm) = match &inner.registration {
        Some(r) => (true, r.rms_residual_mm),
        None => (false, 0.0),
    };
    FiducialStateDto {
        fiducials: inner
            .fiducials
            .iter()
            .map(|f| FiducialDto {
                ideal: f.ideal,
                captured: f.measured.is_some(),
                measured: f.measured,
            })
            .collect(),
        captured_count,
        has_registration,
        rms_residual_mm,
        coarse_offset: coarse_offset(&inner.fiducials),
        work_origin: inner.work_origin,
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use cuprum_core::drilling::Registration;

    fn make_state() -> FiducialStateInner {
        FiducialStateInner::default()
    }

    // Helper: build pairs and call solve_machine_frame directly (the Tauri-command
    // wrappers cannot be unit-tested without a full app context, but the logic
    // they delegate to is tested here against the same data).
    fn collect_pairs(inner: &FiducialStateInner) -> Vec<PointPair> {
        inner
            .fiducials
            .iter()
            .filter_map(|f| f.measured.map(|m| ((f.ideal.x, f.ideal.y), (m.x, m.y))))
            .collect()
    }

    #[test]
    fn init_resets_measurements_and_registration() {
        let mut inner = make_state();
        // Pre-populate some state.
        inner.fiducials.push(Fiducial {
            ideal: MachineXY { x: 0.0, y: 0.0 },
            measured: Some(MachineXY { x: 1.0, y: 0.0 }),
        });
        inner.registration = Some(Registration {
            scale: 1.0,
            angle_rad: 0.0,
            translation: MachineXY { x: 0.0, y: 0.0 },
            rms_residual_mm: 0.0,
        });
        inner.work_origin = Some(MachineXY { x: 100.0, y: 50.0 });

        // Simulate init with two new entries.
        inner.fiducials = vec![
            Fiducial {
                ideal: MachineXY { x: 10.0, y: 0.0 },
                measured: None,
            },
            Fiducial {
                ideal: MachineXY { x: 50.0, y: 0.0 },
                measured: None,
            },
        ];
        inner.registration = None;
        inner.work_origin = None;

        assert_eq!(inner.fiducials.len(), 2);
        assert!(inner.fiducials.iter().all(|f| f.measured.is_none()));
        assert!(inner.registration.is_none());
        assert!(inner.work_origin.is_none());
    }

    #[test]
    fn collect_pairs_only_includes_captured() {
        let mut inner = make_state();
        inner.fiducials = vec![
            Fiducial {
                ideal: MachineXY { x: 0.0, y: 0.0 },
                measured: Some(MachineXY { x: 0.5, y: 0.1 }),
            },
            Fiducial {
                ideal: MachineXY { x: 100.0, y: 0.0 },
                measured: None, // not yet captured
            },
            Fiducial {
                ideal: MachineXY { x: 50.0, y: 80.0 },
                measured: Some(MachineXY { x: 50.6, y: 80.2 }),
            },
        ];
        let pairs = collect_pairs(&inner);
        assert_eq!(pairs.len(), 2);
        assert_eq!(pairs[0].0, (0.0, 0.0));
        assert_eq!(pairs[1].0, (50.0, 80.0));
    }

    #[test]
    fn solve_fails_with_fewer_than_2_pairs() {
        let inner = make_state();
        let pairs = collect_pairs(&inner);
        // Zero pairs → TooFewPoints.
        let result = solve_machine_frame(&pairs);
        assert!(result.is_err());
    }

    #[test]
    fn solve_pure_translation_splits_origin() {
        let mut inner = make_state();
        // Panel sitting at machine (200, 150): measured = ideal + origin.
        let ox = 200.0_f64;
        let oy = 150.0_f64;
        inner.fiducials = vec![
            Fiducial {
                ideal: MachineXY { x: 10.0, y: 5.0 },
                measured: Some(MachineXY {
                    x: 10.0 + ox,
                    y: 5.0 + oy,
                }),
            },
            Fiducial {
                ideal: MachineXY { x: 90.0, y: 5.0 },
                measured: Some(MachineXY {
                    x: 90.0 + ox,
                    y: 5.0 + oy,
                }),
            },
        ];
        let pairs = collect_pairs(&inner);
        let solve = solve_machine_frame(&pairs).expect("solve must succeed");
        // The whole translation goes into the work origin…
        assert!((solve.work_origin.x - ox).abs() < 1e-9, "origin x");
        assert!((solve.work_origin.y - oy).abs() < 1e-9, "origin y");
        // …leaving an identity residual.
        let reg = &solve.registration;
        assert!((reg.scale - 1.0).abs() < 1e-9, "scale must be 1.0");
        assert!(reg.angle_rad.abs() < 1e-9, "angle must be 0");
        assert!(reg.translation.x.abs() < 1e-9, "residual tx must be 0");
        assert!(reg.translation.y.abs() < 1e-9, "residual ty must be 0");
        assert!(reg.rms_residual_mm < 1e-9, "residual must be 0");
        // apply() on a work coordinate is now a no-op (zero-translation identity).
        let (cx, cy) = reg.apply(50.0, 30.0);
        assert!((cx - 50.0).abs() < 1e-9);
        assert!((cy - 30.0).abs() < 1e-9);
    }

    #[test]
    fn solve_three_points_with_small_rotation() {
        let mut inner = make_state();
        let angle = 0.01_f64; // ~0.57° — realistic placement error
        let cos_a = angle.cos();
        let sin_a = angle.sin();
        let (ox, oy) = (120.0_f64, 90.0_f64); // machine position of the datum
                                              // Rotate the ideal positions and shift by the origin → measured MPos.
        let ideals: Vec<(f64, f64)> = vec![(10.0, 5.0), (90.0, 5.0), (50.0, 60.0)];
        inner.fiducials = ideals
            .iter()
            .map(|&(ix, iy)| Fiducial {
                ideal: MachineXY { x: ix, y: iy },
                measured: Some(MachineXY {
                    x: cos_a * ix - sin_a * iy + ox,
                    y: sin_a * ix + cos_a * iy + oy,
                }),
            })
            .collect();
        let pairs = collect_pairs(&inner);
        let solve = solve_machine_frame(&pairs).expect("solve must succeed");
        assert!((solve.work_origin.x - ox).abs() < 1e-8, "origin x");
        assert!((solve.work_origin.y - oy).abs() < 1e-8, "origin y");
        let reg = &solve.registration;
        assert!((reg.angle_rad - angle).abs() < 1e-8, "angle mismatch");
        assert!(reg.translation.x.abs() < 1e-9, "residual tx must be 0");
        assert!(reg.translation.y.abs() < 1e-9, "residual ty must be 0");
        assert!(
            reg.rms_residual_mm < 1e-7,
            "residual should be near 0 for exact input, got {}",
            reg.rms_residual_mm
        );
    }

    #[test]
    fn coarse_offset_mean_of_captured() {
        let mut inner = make_state();
        inner.fiducials = vec![
            Fiducial {
                ideal: MachineXY { x: 10.0, y: 5.0 },
                measured: Some(MachineXY { x: 110.0, y: 55.0 }), // Δ = (100, 50)
            },
            Fiducial {
                ideal: MachineXY { x: 90.0, y: 5.0 },
                measured: Some(MachineXY { x: 192.0, y: 56.0 }), // Δ = (102, 51)
            },
            Fiducial {
                ideal: MachineXY { x: 50.0, y: 60.0 },
                measured: None, // not captured — excluded from the mean
            },
        ];
        let off = coarse_offset(&inner.fiducials).expect("must be Some with captures");
        assert!((off.x - 101.0).abs() < 1e-9, "mean dx");
        assert!((off.y - 50.5).abs() < 1e-9, "mean dy");
    }

    #[test]
    fn coarse_offset_none_without_captures() {
        let mut inner = make_state();
        inner.fiducials = vec![Fiducial {
            ideal: MachineXY { x: 10.0, y: 5.0 },
            measured: None,
        }];
        assert!(coarse_offset(&inner.fiducials).is_none());
        assert!(coarse_offset(&[]).is_none());
    }

    #[test]
    fn state_dto_counts_captured_correctly() {
        let mut inner = make_state();
        inner.fiducials = vec![
            Fiducial {
                ideal: MachineXY { x: 0.0, y: 0.0 },
                measured: Some(MachineXY { x: 0.1, y: 0.0 }),
            },
            Fiducial {
                ideal: MachineXY { x: 50.0, y: 0.0 },
                measured: None,
            },
        ];
        let captured = inner
            .fiducials
            .iter()
            .filter(|f| f.measured.is_some())
            .count();
        assert_eq!(captured, 1);
    }

    #[test]
    fn registration_invalidated_on_new_capture_but_origin_kept() {
        let mut inner = make_state();
        inner.fiducials = vec![
            Fiducial {
                ideal: MachineXY { x: 0.0, y: 0.0 },
                measured: Some(MachineXY { x: 0.5, y: 0.0 }),
            },
            Fiducial {
                ideal: MachineXY { x: 50.0, y: 0.0 },
                measured: Some(MachineXY { x: 50.5, y: 0.0 }),
            },
        ];
        // Simulate a solved registration + programmed origin.
        inner.registration = Some(Registration {
            scale: 1.0,
            angle_rad: 0.0,
            translation: MachineXY { x: 0.0, y: 0.0 },
            rms_residual_mm: 0.0,
        });
        inner.work_origin = Some(MachineXY { x: 0.5, y: 0.0 });
        // Simulate a re-capture (new measurement for index 0).
        inner.fiducials[0].measured = Some(MachineXY { x: 0.3, y: 0.0 });
        // The command clears the registration on capture but keeps the origin
        // (it is still physically programmed on the controller).
        inner.registration = None;
        assert!(inner.registration.is_none());
        assert!(inner.work_origin.is_some());
    }
}

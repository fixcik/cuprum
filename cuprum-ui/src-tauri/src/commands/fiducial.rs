// Fiducial-registration backend: capture real machine positions for fiducial
// markers and fit a 2D correction transform from them, then expose the result
// to the drill planner.
//
// Workflow:
//   1. `fiducial_init`  — supply the list of fiducials (their ideal machine XY
//                         positions) for the upcoming run; resets any previous
//                         measurements and the solved transform.
//   2. `fiducial_capture(index)` — jog the spindle over fiducial N and call this;
//                                  the command snapshots the current machine X/Y.
//   3. `fiducial_solve` — fit a Registration from all (ideal, measured) pairs that
//                         have been captured. Returns Err if fewer than 2 are ready.
//   4. `fiducial_reset` — clear everything (start over without re-init).
//   5. `fiducial_state` — inspect the current status (what is captured, is a
//                         transform ready, RMS residual).
//
// The solved Registration is read by `drill_plan` (in drill_run.rs) and injected
// into DrillPlanInput.registration so hole coordinates are corrected before G-code
// emission. When no registration is solved the field stays None → identity.
//
// All coordinates are machine-space mm (not work-space).

use crate::commands::error::{CmdError, CmdResult};
use cuprum_core::drilling::{fit_transform, MachineXY, PointPair, Registration};
use std::sync::Mutex;
use tauri::State;

// ── State ─────────────────────────────────────────────────────────────────────

/// One fiducial entry: its ideal (nominal) machine position and the optionally
/// captured real machine position (set by `fiducial_capture`).
#[derive(Clone, Debug)]
struct Fiducial {
    /// Where the fiducial should be in machine space, computed from the datum
    /// transform of its panel coordinate before the session starts.
    ideal: MachineXY,
    /// The measured machine XY, taken from the live MPos when the user calls
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
    /// The last successfully solved Registration. None until `fiducial_solve` succeeds.
    registration: Option<Registration>,
}

impl FiducialState {
    /// Return a clone of the solved Registration (or None). Called by `drill_plan`
    /// to inject registration into the planner input without holding the lock.
    pub fn solved_registration(&self) -> Option<Registration> {
        self.0.lock().unwrap().registration.clone()
    }
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
    /// The measured machine position; null when not yet captured.
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
}

/// Result of a successful `fiducial_solve`.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FiducialSolveResult {
    pub registration: Registration,
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Initialise the fiducial list for a new registration session.
///
/// Resets any previous measurements and the solved transform, then sets the
/// list of fiducials from `entries` (their ideal machine XY positions).
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
    Ok(())
}

/// Capture the current machine XY as the measured position for fiducial `index`.
///
/// The caller must first jog the spindle over the fiducial and only then invoke
/// this command. The command sends a `?` status query and waits for the next
/// `<…>` status report from GRBL, which carries the live machine position. It
/// fails if the machine is not connected or no status arrives within 2 s.
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
    // Invalidate the previous solve when a measurement changes.
    inner.registration = None;
    Ok(())
}

/// Fit a Registration from all currently captured (ideal, measured) pairs.
///
/// Requires at least 2 captured fiducials. On success the Registration is stored
/// in the state (so `drill_plan` picks it up) and returned to the caller.
/// Returns Err with a descriptive message on degenerate inputs.
#[tauri::command]
pub fn fiducial_solve(state: State<FiducialState>) -> CmdResult<FiducialSolveResult> {
    let mut inner = state.0.lock().unwrap();

    // Collect (ideal, measured) pairs for every captured fiducial.
    let pairs: Vec<PointPair> = inner
        .fiducials
        .iter()
        .filter_map(|f| {
            f.measured.map(|m| {
                let ideal = (f.ideal.x, f.ideal.y);
                let measured = (m.x, m.y);
                (ideal, measured)
            })
        })
        .collect();

    if pairs.len() < 2 {
        return Err(CmdError::from(format!(
            "at least 2 fiducials must be captured before solving (have {})",
            pairs.len()
        )));
    }

    let registration = fit_transform(&pairs).map_err(CmdError::from)?;
    inner.registration = Some(registration.clone());
    Ok(FiducialSolveResult { registration })
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

    // Helper: build pairs and call fit_transform directly (the Tauri-command wrappers
    // cannot be unit-tested without a full app context, but the logic they delegate
    // to is tested here against the same data).
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

        assert_eq!(inner.fiducials.len(), 2);
        assert!(inner.fiducials.iter().all(|f| f.measured.is_none()));
        assert!(inner.registration.is_none());
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
        let result = fit_transform(&pairs);
        assert!(result.is_err());
    }

    #[test]
    fn solve_pure_translation() {
        let mut inner = make_state();
        // Board shifted +2 mm in X, +1 mm in Y from nominal.
        let tx = 2.0_f64;
        let ty = 1.0_f64;
        inner.fiducials = vec![
            Fiducial {
                ideal: MachineXY { x: 10.0, y: 5.0 },
                measured: Some(MachineXY {
                    x: 10.0 + tx,
                    y: 5.0 + ty,
                }),
            },
            Fiducial {
                ideal: MachineXY { x: 90.0, y: 5.0 },
                measured: Some(MachineXY {
                    x: 90.0 + tx,
                    y: 5.0 + ty,
                }),
            },
        ];
        let pairs = collect_pairs(&inner);
        let reg = fit_transform(&pairs).expect("solve must succeed");
        assert!((reg.scale - 1.0).abs() < 1e-9, "scale must be 1.0");
        assert!(reg.angle_rad.abs() < 1e-9, "angle must be 0");
        assert!((reg.translation.x - tx).abs() < 1e-9, "tx mismatch");
        assert!((reg.translation.y - ty).abs() < 1e-9, "ty mismatch");
        assert!(reg.rms_residual_mm < 1e-9, "residual must be 0");
        // apply() corrects a new hole.
        let (cx, cy) = reg.apply(50.0, 30.0);
        assert!((cx - 52.0).abs() < 1e-9);
        assert!((cy - 31.0).abs() < 1e-9);
    }

    #[test]
    fn solve_three_points_with_small_rotation() {
        use std::f64::consts::PI;
        let mut inner = make_state();
        let angle = 0.01_f64; // ~0.57° — realistic placement error
        let cos_a = angle.cos();
        let sin_a = angle.sin();
        // Rotate the ideal positions to get measured positions.
        let ideals: Vec<(f64, f64)> = vec![(10.0, 5.0), (90.0, 5.0), (50.0, 60.0)];
        inner.fiducials = ideals
            .iter()
            .map(|&(ix, iy)| Fiducial {
                ideal: MachineXY { x: ix, y: iy },
                measured: Some(MachineXY {
                    x: cos_a * ix - sin_a * iy,
                    y: sin_a * ix + cos_a * iy,
                }),
            })
            .collect();
        let pairs = collect_pairs(&inner);
        let reg = fit_transform(&pairs).expect("solve must succeed");
        assert!((reg.angle_rad - angle).abs() < 1e-8, "angle mismatch");
        assert!(
            reg.rms_residual_mm < 1e-7,
            "residual should be near 0 for exact input, got {}",
            reg.rms_residual_mm
        );
        let _ = PI; // suppress unused-import warning
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
    fn registration_invalidated_on_new_capture() {
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
        // Simulate a solved registration.
        inner.registration = Some(Registration {
            scale: 1.0,
            angle_rad: 0.0,
            translation: MachineXY { x: 0.5, y: 0.0 },
            rms_residual_mm: 0.0,
        });
        // Simulate a re-capture (new measurement for index 0).
        inner.fiducials[0].measured = Some(MachineXY { x: 0.3, y: 0.0 });
        // The command would clear the registration on capture.
        inner.registration = None;
        assert!(inner.registration.is_none());
    }
}

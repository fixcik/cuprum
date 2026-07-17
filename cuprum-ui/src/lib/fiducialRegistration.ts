/**
 * Pure logic for the manual points registration workflow (work-zero method 2)
 * in the drill operation.
 *
 * Responsibilities:
 *  - Build the datum-relative ideal positions for alignment points.
 *  - Derive the envelope jog clamp box around a capture target.
 *  - Classify the RMS residual into a severity level.
 *  - Validate the minimum number of captures required for solve.
 *  - Compute per-point residuals of a solved machine-frame registration.
 *
 * Coordinate convention
 * ---------------------
 * `ideal`    -- datum-relative XY (`machinePoint()` output): the WPos each point
 *              gets once the solved work zero is programmed. No pre-set zero is
 *              required -- the solve derives the G54 origin itself.
 * `measured` -- machine-frame MPos snapshot captured by `fiducial_capture`.
 * machineBounds / capture centre -- machine-frame (G53) coordinates used by
 *              the jog-clamp envelope (useJog bounds are always machine-frame).
 *
 * The backend fit (`solve_machine_frame`) maps ideal -> measured as
 * `measured ≈ workOrigin + s·R(θ)·ideal`: the translation becomes the G54
 * origin, scale + rotation stay as the residual `Registration`.
 */

import { machinePoint } from "@/lib/datum";
import type { DatumCorner } from "@/lib/datum";
import type { JogBounds } from "@/lib/jogBounds";

/** Radius (mm) of the capture zone around the ideal fiducial position.
 *  The jog envelope is clamped to a +/-R square while the operator navigates
 *  to a fiducial, preventing accidental large moves. */
export const FIDUCIAL_CAPTURE_RADIUS_MM = 3;

/** Allowed jog step sizes (mm) while in fiducial capture mode.
 *  The 10 mm step is intentionally absent -- only fine steps allowed. */
export const FIDUCIAL_CAPTURE_STEPS_MM: number[] = [0.05, 0.1, 0.5];

/** Feed rate (mm/min) for a manual Z descent step during fiducial capture.
 *  Intentionally slow so the operator can stop the cone/tool before contact. */
export const FIDUCIAL_Z_DESCENT_FEED_MM_MIN = 60;

/** Minimum number of captured fiducials required before solve is available. */
export const MIN_CAPTURES_FOR_SOLVE = 2;

/** RMS residual threshold: at or below this is "good" registration (mm). */
export const RMS_WARN_MM = 0.1;

/** RMS residual threshold: above this is "bad" registration (mm). */
export const RMS_ERROR_MM = 0.5;

/** One fiducial entry for api.fiducial.init. ideal is work-frame (G54) mm. */
export interface FiducialInitEntry {
  ideal: { x: number; y: number };
}

/** Severity of the RMS registration residual. */
export type RmsSeverity = "good" | "warn" | "bad";

/** Classify a residual (mm) into a severity level for UI colouring. */
export function classifyRms(rmsResidualMm: number): RmsSeverity {
  if (rmsResidualMm <= RMS_WARN_MM) return "good";
  if (rmsResidualMm <= RMS_ERROR_MM) return "warn";
  return "bad";
}

/**
 * Build fiducial init entries (ideal datum-relative XY) from panel alignment
 * points (or any panel-space `{x_mm, y_mm}` markers). Applies the datum-corner
 * transform (same as the drill route planner).
 *
 * Panel space: Y-down, origin top-left.
 * Datum space: Y-up, origin at the datum corner (= the future G54 work zero).
 * The output `ideal` values equal the WPos each point gets once the solved
 * work zero is programmed on the controller.
 */
export function buildFiducialEntries(
  points: ReadonlyArray<{ x_mm: number; y_mm: number }>,
  datum: DatumCorner,
  panelWidthMm: number,
  panelHeightMm: number,
): FiducialInitEntry[] {
  return points.map((p) => {
    const [wx, wy] = machinePoint(p.x_mm, p.y_mm, datum, panelWidthMm, panelHeightMm);
    return { ideal: { x: wx, y: wy } };
  });
}

/**
 * Derive the jog clamp bounds for capturing a point: a +/-r box centred on the
 * expected machine-frame position of the point (ideal + coarse offset),
 * intersected with the machine travel envelope. useJog bounds are always
 * machine-frame (G53).
 */
export function captureBoundsAroundMachine(
  centerMachineX: number,
  centerMachineY: number,
  machineBounds: JogBounds,
): JogBounds {
  const r = FIDUCIAL_CAPTURE_RADIUS_MM;
  return {
    x: [
      Math.max(machineBounds.x[0], centerMachineX - r),
      Math.min(machineBounds.x[1], centerMachineX + r),
    ],
    y: [
      Math.max(machineBounds.y[0], centerMachineY - r),
      Math.min(machineBounds.y[1], centerMachineY + r),
    ],
    // Z travel is not restricted during XY capture navigation.
    z: machineBounds.z,
  };
}

/** Whether enough fiducials have been captured to attempt a solve. */
export function canSolve(capturedCount: number): boolean {
  return capturedCount >= MIN_CAPTURES_FOR_SOLVE;
}

/**
 * Per-point residuals (mm) of a solved machine-frame registration.
 *
 * The backend fit models `measured ≈ workOrigin + s·R(θ)·ideal` (see
 * `solve_machine_frame`: the fit translation is programmed as the G54 origin,
 * scale + rotation stay in the residual `Registration` whose own translation is
 * zero). The residual of point i is the distance between its measured MPos and
 * that prediction. Uncaptured points yield `null`.
 *
 * The backend reports only the aggregate RMS, so the per-point breakdown for
 * the wizard result screen is recomputed here from the same pairs.
 */
export function pointResiduals(
  fiducials: ReadonlyArray<{
    ideal: { x: number; y: number };
    measured: { x: number; y: number } | null;
  }>,
  registration: { scale: number; angleRad: number },
  workOrigin: { x: number; y: number },
): Array<number | null> {
  const { scale, angleRad } = registration;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return fiducials.map((f) => {
    if (!f.measured) return null;
    const px = workOrigin.x + scale * (cos * f.ideal.x - sin * f.ideal.y);
    const py = workOrigin.y + scale * (sin * f.ideal.x + cos * f.ideal.y);
    return Math.hypot(f.measured.x - px, f.measured.y - py);
  });
}

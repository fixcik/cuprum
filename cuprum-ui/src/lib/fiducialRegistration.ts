/**
 * Pure logic for fiducial-registration workflow in the drill operation.
 *
 * Responsibilities:
 *  - Build the machine-space ideal positions for fiducials from panel tooling holes.
 *  - Derive the envelope jog clamp box around a specific fiducial (capture zone).
 *  - Classify the RMS residual into a severity level.
 *  - Validate the minimum number of captures required for solve.
 */

import type { ToolingHole } from "@/lib/api";
import { machinePoint } from "@/lib/datum";
import type { DatumCorner } from "@/lib/datum";
import type { JogBounds } from "@/lib/jogBounds";

/** Radius (mm) of the capture zone around the ideal fiducial position.
 *  The jog envelope is clamped to a ±R square while the operator navigates
 *  to a fiducial, preventing accidental large moves. */
export const FIDUCIAL_CAPTURE_RADIUS_MM = 3;

/** Allowed jog step sizes (mm) while in fiducial capture mode.
 *  The 10 mm step is intentionally absent — only fine steps allowed. */
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

/** One fiducial entry for api.fiducial.init. */
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

/** Extract the tooling holes with role "registration" from the panel. */
export function getRegistrationHoles(toolingHoles: ToolingHole[]): ToolingHole[] {
  return toolingHoles.filter((h) => h.role === "registration");
}

/**
 * Build fiducial init entries (ideal machine-space XY) from panel registration
 * holes. Applies the datum-corner transform (same as the drill route planner).
 *
 * Panel space: Y-down, origin top-left.
 * Machine space: Y-up, origin at the datum corner.
 */
export function buildFiducialEntries(
  registrationHoles: ToolingHole[],
  datum: DatumCorner,
  panelWidthMm: number,
  panelHeightMm: number,
): FiducialInitEntry[] {
  return registrationHoles.map((h) => {
    const [mx, my] = machinePoint(h.x_mm, h.y_mm, datum, panelWidthMm, panelHeightMm);
    return { ideal: { x: mx, y: my } };
  });
}

/**
 * Derive the jog clamp bounds for capturing a fiducial at a given ideal machine XY.
 * Returns a ±FIDUCIAL_CAPTURE_RADIUS_MM box centred on the ideal XY, intersected
 * with the overall machine envelope so it never exceeds real travel limits.
 */
export function fiducialCaptureBounds(
  idealX: number,
  idealY: number,
  machineBounds: JogBounds,
): JogBounds {
  const r = FIDUCIAL_CAPTURE_RADIUS_MM;
  return {
    x: [
      Math.max(machineBounds.x[0], idealX - r),
      Math.min(machineBounds.x[1], idealX + r),
    ],
    y: [
      Math.max(machineBounds.y[0], idealY - r),
      Math.min(machineBounds.y[1], idealY + r),
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
 * Convert a machine-frame XY target into the work frame that `jogTo` expects.
 *
 * Fiducial ideal positions live in machine coordinates (from `machinePoint`),
 * but `jogTo` clamps/sends work-frame targets (it adds the live WCO back).
 * The work offset is `wco = mpos − wpos` per axis, so `work = machine − wco`.
 * Without this, a non-zero work zero would send the spindle to the wrong spot.
 */
export function machineToWorkXY(
  ideal: { x: number; y: number },
  mpos: readonly number[],
  wpos: readonly number[],
): { x: number; y: number } {
  return {
    x: ideal.x - (mpos[0] - wpos[0]),
    y: ideal.y - (mpos[1] - wpos[1]),
  };
}

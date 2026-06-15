/**
 * Pure logic for fiducial-registration workflow in the drill operation.
 *
 * Responsibilities:
 *  - Build the work-frame (G54) ideal positions for fiducials from panel tooling holes.
 *  - Derive the envelope jog clamp box around a specific fiducial (capture zone).
 *  - Classify the RMS residual into a severity level.
 *  - Validate the minimum number of captures required for solve.
 *
 * Coordinate convention
 * ---------------------
 * `ideal`    -- work-frame (G54) XY; `machinePoint()` output = datum corner is the
 *              G54 origin, so the result is directly the WPos the spindle should read
 *              when centred over the fiducial.
 * `measured` -- WPos captured at the moment the operator confirms alignment.
 * machineBounds / captureMachineXY -- machine-frame (G53) coordinates used by
 *              the jog-clamp envelope (useJog bounds are always machine-frame).
 *
 * The fit (ideal->measured) is therefore work->work: a small correction for board
 * placement offset, rotation and scale, with no WCO contamination.
 */

import type { ToolingHole } from "@/lib/api";
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

/** Extract the tooling holes with role "registration" from the panel. */
export function getRegistrationHoles(toolingHoles: ToolingHole[]): ToolingHole[] {
  return toolingHoles.filter((h) => h.role === "registration");
}

/**
 * Build fiducial init entries (ideal work-frame G54 XY) from panel registration
 * holes. Applies the datum-corner transform (same as the drill route planner).
 *
 * Panel space: Y-down, origin top-left.
 * Work space (G54): Y-up, origin at the datum corner (= the G54 work zero).
 * The output `ideal` values equal the WPos the spindle should show when centred
 * over the fiducial, regardless of the machine WCO.
 */
export function buildFiducialEntries(
  registrationHoles: ToolingHole[],
  datum: DatumCorner,
  panelWidthMm: number,
  panelHeightMm: number,
): FiducialInitEntry[] {
  return registrationHoles.map((h) => {
    const [wx, wy] = machinePoint(h.x_mm, h.y_mm, datum, panelWidthMm, panelHeightMm);
    return { ideal: { x: wx, y: wy } };
  });
}

/**
 * Derive the jog clamp bounds for capturing a fiducial.
 *
 * useJog bounds are always machine-frame (G53), so the +/-r box must be centred on
 * the machine position of the fiducial:
 *   machineXY = ideal (work) + WCO,  where WCO = mpos - wpos.
 *
 * @param idealX  Work-frame X of the fiducial (from buildFiducialEntries).
 * @param idealY  Work-frame Y of the fiducial.
 * @param mpos    Live MPos (machine-frame, 3-element array).
 * @param wpos    Live WPos (work-frame, 3-element array).
 * @param machineBounds  Full machine travel envelope (machine-frame).
 */
export function fiducialCaptureBounds(
  idealX: number,
  idealY: number,
  mpos: readonly number[],
  wpos: readonly number[],
  machineBounds: JogBounds,
): JogBounds {
  const r = FIDUCIAL_CAPTURE_RADIUS_MM;
  // Convert work-frame ideal to machine-frame so the box aligns with machineBounds.
  const wcoX = mpos[0] - wpos[0];
  const wcoY = mpos[1] - wpos[1];
  const centerMachineX = idealX + wcoX;
  const centerMachineY = idealY + wcoY;
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

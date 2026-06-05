import type { DrillRunPhase } from "@/lib/drillRunState";
import type { DatumCorner } from "@/lib/datum";

/** Convert a machine WORK position into panel-space mm (origin = top-left, Y down
 *  — the frame holes and axes are drawn in). Exact inverse of `machinePoint` for
 *  the active datum: machineX = x − (right?W:0), machineY = (bottom?H:0) − y, so
 *  x = machineX + (right?W:0), y = (bottom?H:0) − machineY. Default datum
 *  (bottom-left) → (x, H − machineY). */
export function workPosToPanel(
  workXMm: number,
  workYMm: number,
  panelHeightMm: number,
  datum: DatumCorner = "bottom-left",
  panelWidthMm = 0,
): { xMm: number; yMm: number } {
  const right = datum === "bottom-right" || datum === "top-right";
  const bottom = datum === "bottom-left" || datum === "bottom-right";
  return {
    xMm: workXMm + (right ? panelWidthMm : 0),
    yMm: (bottom ? panelHeightMm : 0) - workYMm,
  };
}

/** Run phases during which the live marker is shown (machine may be Idle while
 *  paused / awaiting a tool change, so we gate on the run phase, not GRBL state). */
const ACTIVE_PHASES: ReadonlySet<DrillRunPhase> = new Set([
  "running",
  "paused",
  "awaitingToolChange",
]);

/** Marker is visible only during an active run AND while a fresh position is
 *  available (poller still reporting). `hasFreshPosition` is false when no
 *  `machine://status` has arrived recently (e.g. unplugged mid-run). */
export function shouldShowMarker(
  phase: DrillRunPhase,
  hasFreshPosition: boolean,
): boolean {
  return hasFreshPosition && ACTIVE_PHASES.has(phase);
}

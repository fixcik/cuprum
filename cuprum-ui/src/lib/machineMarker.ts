import type { DrillRunPhase } from "@/lib/drillRunState";

/** Convert a machine WORK position (origin = panel bottom-left, Y up — the CNC
 *  convention the drill G-code uses) into panel-space mm (origin = top-left, Y
 *  down — the frame holes and the #232 axes are drawn in). X passes through; Y is
 *  flipped about the panel height. */
export function workPosToPanel(
  workXMm: number,
  workYMm: number,
  panelHeightMm: number,
): { xMm: number; yMm: number } {
  return { xMm: workXMm, yMm: panelHeightMm - workYMm };
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

import { type DatumCorner, machinePoint } from "@/lib/datum";
import type { PanelDrillPlan } from "@/lib/panelDrill";

/** Axis-aligned bounding box of the run's holes in the WORK frame (relative to
 *  the datum corner = work zero), already mapped through `machinePoint`. */
export interface WorkExtent {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** A single envelope violation: an axis end where the hole bbox, placed at the
 *  bound work zero, would fall outside the machine travel.
 *  - side "min": below the 0 end of travel (negative overshoot).
 *  - side "max": beyond the max-travel end. */
export interface XYViolation {
  axis: "x" | "y";
  side: "min" | "max";
  /** How far past the limit, in mm (always positive). */
  overshootMm: number;
}

/** Result of the XY-gate check.
 *  - valid: every hole fits inside the machine envelope at the bound zero.
 *  - not-zeroed: work zero XY has not been captured yet.
 *  - out-of-bounds: at least one axis end overshoots the travel. */
export type XYGateResult =
  | { valid: true }
  | { valid: false; reason: "not-zeroed" }
  | { valid: false; reason: "out-of-bounds"; violations: XYViolation[] };

/** Machine-frame bounding box of every hole in the plan, mapped via `machinePoint`
 *  for the chosen datum corner. Returns null when the plan has no holes (nothing
 *  to gate). Coordinates are in the WORK frame (datum corner = origin). */
export function planWorkExtent(
  plan: PanelDrillPlan,
  datum: DatumCorner,
  panelWidthMm: number,
  panelHeightMm: number,
): WorkExtent | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const g of plan.groups) {
    for (const h of g.holes) {
      const [mx, my] = machinePoint(h.xMm, h.yMm, datum, panelWidthMm, panelHeightMm);
      if (mx < minX) minX = mx;
      if (mx > maxX) maxX = mx;
      if (my < minY) minY = my;
      if (my > maxY) maxY = my;
      any = true;
    }
  }
  return any ? { minX, maxX, minY, maxY } : null;
}

// Tolerance (mm) so a hole sitting exactly on a limit (or a sub-micron rounding
// artefact from the datum transform) doesn't read as a violation.
const EPS_MM = 1e-3;

/** Check whether the drill run stays inside the machine XY envelope at the bound
 *  work zero. GRBL machine X/Y travel runs 0..maxTravel (same model as the jog
 *  clamp). Each hole's machine position is `workZeroMachineXY + holeWorkCoord`,
 *  so the run is safe iff the hole bbox, translated by the bound zero, lands
 *  within [0, maxX] × [0, maxY].
 *
 * @param workZeroMachineXY  MPos X/Y captured at bind (= the work-coordinate
 *                           offset, since work XY is 0 at bind). null = not done.
 * @param extent             Hole bbox in the work frame (null = no holes → valid).
 * @param maxXMm             X travel (mm, positive).
 * @param maxYMm             Y travel (mm, positive).
 */
export function checkXYGate(
  workZeroMachineXY: { x: number; y: number } | null,
  extent: WorkExtent | null,
  maxXMm: number,
  maxYMm: number,
): XYGateResult {
  if (workZeroMachineXY === null) return { valid: false, reason: "not-zeroed" };
  if (!extent) return { valid: true };

  const violations: XYViolation[] = [];
  const checkAxis = (axis: "x" | "y", zero: number, lo: number, hi: number, travel: number) => {
    const loMachine = zero + lo;
    const hiMachine = zero + hi;
    if (loMachine < -EPS_MM) violations.push({ axis, side: "min", overshootMm: -loMachine });
    if (hiMachine > travel + EPS_MM)
      violations.push({ axis, side: "max", overshootMm: hiMachine - travel });
  };
  checkAxis("x", workZeroMachineXY.x, extent.minX, extent.maxX, maxXMm);
  checkAxis("y", workZeroMachineXY.y, extent.minY, extent.maxY, maxYMm);

  if (violations.length > 0) return { valid: false, reason: "out-of-bounds", violations };
  return { valid: true };
}

/** Compact human-readable summary of envelope violations, e.g. "X+20.0 mm, Y−5.0 mm".
 *  "+" = past the max-travel end, "−" = below the 0 end. `fmtLen` localises the
 *  magnitude (mm/mils) and appends the unit. */
export function formatXYViolations(
  violations: XYViolation[],
  fmtLen: (mm: number) => string,
): string {
  return violations
    .map((v) => `${v.axis.toUpperCase()}${v.side === "max" ? "+" : "−"}${fmtLen(v.overshootMm)}`)
    .join(", ");
}

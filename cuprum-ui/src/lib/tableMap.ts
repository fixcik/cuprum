import { type DatumCorner, machinePoint } from "@/lib/datum";
import type { DrillClass } from "@/lib/api";
import type { PanelDrillPlan } from "@/lib/panelDrill";

/** Axis-aligned rectangle in MACHINE coordinates (mm), GRBL frame: X/Y run 0..max. */
export interface TableRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A selected hole projected onto the table (machine coords) for the mini-map dots. */
export interface TableHolePoint {
  x: number;
  y: number;
  class: DrillClass;
}

/** Result of fitting the board rect into the machine travel.
 *  - ok: the whole board sits within [0,maxX] × [0,maxY].
 *  - ox/oy: worst overshoot (mm) on each axis past the nearer limit (0 ≤). */
export interface EnvelopeFit {
  ok: boolean;
  ox: number;
  oy: number;
}

// Tolerance (mm) so a board edge exactly on a limit (or a sub-micron rounding
// artefact from the datum transform) doesn't read as an overflow.
const EPS_MM = 1e-3;

/** Board rectangle in MACHINE coords given the datum corner sits at machine point
 *  `datumMachine` (the live spindle XY during touch-off). Each panel corner maps to
 *  a work-frame offset via `machinePoint` (same transform the run/gate use), then is
 *  translated by the datum machine position; the bbox of the four corners is the
 *  board rect. Consistent with the XY gate's `workZeroMachineXY + holeWorkCoord`. */
export function panelOnTable(
  datumMachine: { x: number; y: number },
  datum: DatumCorner,
  panelWidthMm: number,
  panelHeightMm: number,
): TableRect {
  const corners: [number, number][] = [
    [0, 0],
    [panelWidthMm, 0],
    [0, panelHeightMm],
    [panelWidthMm, panelHeightMm],
  ];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [px, py] of corners) {
    const [wx, wy] = machinePoint(px, py, datum, panelWidthMm, panelHeightMm);
    const mx = datumMachine.x + wx;
    const my = datumMachine.y + wy;
    x0 = Math.min(x0, mx);
    x1 = Math.max(x1, mx);
    y0 = Math.min(y0, my);
    y1 = Math.max(y1, my);
  }
  return { x0, y0, x1, y1 };
}

/** Does the board rect fit inside the machine travel [0,maxX] × [0,maxY]? Reports
 *  the worst overshoot per axis (past either the 0 end or the max end). */
export function envelopeFit(rect: TableRect, maxXMm: number, maxYMm: number): EnvelopeFit {
  const ox = Math.max(0, -rect.x0, rect.x1 - maxXMm);
  const oy = Math.max(0, -rect.y0, rect.y1 - maxYMm);
  return { ok: ox < EPS_MM && oy < EPS_MM, ox, oy };
}

/** Selected-plan holes projected to MACHINE coords for the mini-map dots. Uses the
 *  same `datumMachine + machinePoint` transform as `panelOnTable`, so dots land
 *  inside the board rect. */
export function holeTablePoints(
  plan: PanelDrillPlan,
  datumMachine: { x: number; y: number },
  datum: DatumCorner,
  panelWidthMm: number,
  panelHeightMm: number,
): TableHolePoint[] {
  const out: TableHolePoint[] = [];
  for (const g of plan.groups) {
    for (const h of g.holes) {
      const [wx, wy] = machinePoint(h.xMm, h.yMm, datum, panelWidthMm, panelHeightMm);
      out.push({ x: datumMachine.x + wx, y: datumMachine.y + wy, class: g.class });
    }
  }
  return out;
}

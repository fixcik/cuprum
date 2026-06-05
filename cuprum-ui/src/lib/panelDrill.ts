import type { BoardInstance, Hole, ToolingHole } from "@/lib/api";
import type { Tool } from "@/lib/toolLibrary";
import { rotatePointAroundCenter } from "@/lib/panelPlacement";
import { holeInZones, type Rect } from "@/lib/keepoutGeometry";

export { type Rect };

export const KEEPOUT_DRILL_CLEARANCE_MM = 0.2;

/** Drill class — heuristic in v1; manual override + persistence come later. */
export type DrillClass = "registration" | "pth" | "npth" | "mechanical";

/** A hole position in panel space (mm). */
export interface PlanHole {
  xMm: number;
  yMm: number;
}

/** Holes of one diameter+class, with the assigned drill tool (null if no match). */
export interface DrillGroup {
  diameterMm: number;
  class: DrillClass;
  toolId: string | null;
  holes: PlanHole[];
}

/** All panel holes, grouped, ready for the Phase-4 emitter / Phase-5 preview. */
export interface PanelDrillPlan {
  /** Sorted by diameter ascending. */
  groups: DrillGroup[];
  totalHoles: number;
  /** Diameters with no matching drill in the library (sorted asc) — for a warning. */
  unmatchedDiametersMm: number[];
  /** Board holes skipped because they fell inside a keep-out zone. */
  skippedInKeepout: number;
  /** Registration/tooling holes skipped because they fell inside a keep-out zone (setup error — warn loudly). */
  registrationInKeepout: number;
}

/** Board-local hole (Y-up, origin at the design's outline min corner). */
export interface LocalHole {
  xMm: number;
  yMm: number;
  dMm: number;
}

/** Translate absolute gerber drill coords to board-local by subtracting the
 *  design's outline origin (metrics.board.originXMm/originYMm). */
export function collectDesignHoles(holesAbs: Hole[], originXMm: number, originYMm: number): LocalHole[] {
  return holesAbs.map((h) => ({ xMm: h.x - originXMm, yMm: h.y - originYMm, dMm: h.d }));
}

/** Project a board-local hole (Y-up, origin at the board's min corner) onto the
 *  panel (Y-down). Flips Y into the footprint, then applies the same
 *  center-rotation as instanceBounds. Drilling is done from the top; per-side
 *  flip/mirror is a concern of the drill operation, not the placement. */
export function projectHoleToPanel(
  local: { xMm: number; yMm: number },
  inst: Pick<BoardInstance, "x_mm" | "y_mm" | "rotation_deg">,
  boardWmm: number,
  boardHmm: number,
): PlanHole {
  const ux = inst.x_mm + local.xMm;
  // Gerber Y-up → panel Y-down footprint: local y=0 (board bottom) maps to the
  // footprint's bottom edge (y_mm + boardH).
  const uy = inst.y_mm + (boardHmm - local.yMm);
  const cx = inst.x_mm + boardWmm / 2;
  const cy = inst.y_mm + boardHmm / 2;
  const [xMm, yMm] = rotatePointAroundCenter(ux, uy, cx, cy, inst.rotation_deg);
  return { xMm, yMm };
}

/** Bucket key: 1 µm diameter bucket + class (so one group = one diameter+class). */
const bucketKey = (diameterMm: number, cls: DrillClass) => `${Math.round(diameterMm * 1000)}|${cls}`;

/** Nearest drill tool whose diameter is within tolerance, or null. */
function matchTool(diameterMm: number, tools: Tool[], toleranceMm: number): Tool | null {
  let best: Tool | null = null;
  let bestErr = Infinity;
  for (const t of tools) {
    if (t.kind !== "drill") continue;
    const err = Math.abs(t.diameterMm - diameterMm);
    if (err <= toleranceMm && err < bestErr) {
      best = t;
      bestErr = err;
    }
  }
  return best;
}

/** Heuristic drill class for a design hole. */
function designHoleClass(diameterMm: number, viaMaxDiameterMm: number): DrillClass {
  return diameterMm <= viaMaxDiameterMm ? "pth" : "mechanical";
}

/** Build the panel drill plan: project every placed design's holes into panel
 *  space, fold in the panel's tooling holes, group by diameter+class, and assign
 *  a drill from the tool library. Pure. */
export function buildPanelDrillPlan(
  panel: { instances: BoardInstance[]; tooling_holes: ToolingHole[] },
  designHoles: Map<string, LocalHole[]>,
  sizes: Map<string, { w: number; h: number }>,
  tools: Tool[],
  opts: { viaMaxDiameterMm: number; drillBitToleranceMm: number },
  keepOutZones: Rect[] = [],
): PanelDrillPlan {
  const buckets = new Map<string, DrillGroup>();
  let skippedInKeepout = 0;
  let registrationInKeepout = 0;

  const add = (diameterMm: number, cls: DrillClass, hole: PlanHole) => {
    const key = bucketKey(diameterMm, cls);
    let g = buckets.get(key);
    if (!g) {
      g = { diameterMm, class: cls, toolId: null, holes: [] };
      buckets.set(key, g);
    }
    g.holes.push(hole);
  };

  for (const inst of panel.instances) {
    const holes = designHoles.get(inst.design_id);
    const sz = sizes.get(inst.design_id);
    if (!holes || !sz) continue;
    for (const h of holes) {
      const p = projectHoleToPanel(h, inst, sz.w, sz.h);
      if (holeInZones(p.xMm, p.yMm, h.dMm / 2, keepOutZones, KEEPOUT_DRILL_CLEARANCE_MM)) {
        skippedInKeepout++;
        continue;
      }
      add(h.dMm, designHoleClass(h.dMm, opts.viaMaxDiameterMm), p);
    }
  }

  for (const th of panel.tooling_holes) {
    if (th.role === "unused") continue;
    if (holeInZones(th.x_mm, th.y_mm, th.diameter_mm / 2, keepOutZones, KEEPOUT_DRILL_CLEARANCE_MM)) {
      registrationInKeepout++;
      continue;
    }
    add(th.diameter_mm, "registration", { xMm: th.x_mm, yMm: th.y_mm });
  }

  const unmatched = new Set<number>();
  const groups: DrillGroup[] = [];
  for (const g of buckets.values()) {
    const tool = matchTool(g.diameterMm, tools, opts.drillBitToleranceMm);
    g.toolId = tool?.id ?? null;
    if (!tool) unmatched.add(g.diameterMm);
    groups.push(g);
  }
  groups.sort((a, b) => a.diameterMm - b.diameterMm);
  const totalHoles = groups.reduce((n, g) => n + g.holes.length, 0);
  return {
    groups,
    totalHoles,
    unmatchedDiametersMm: [...unmatched].sort((a, b) => a - b),
    skippedInKeepout,
    registrationInKeepout,
  };
}

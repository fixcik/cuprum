import type { PanelDrillPlan, DrillGroup, PlanHole } from "@/lib/panelDrill";

/** Greedy nearest-neighbour ordering from a start point. Stable: ties resolve to
 *  the earlier index, so output is deterministic. Shared by the G-code emitter and
 *  the drill-preview route so the drawn path equals the actual drill order. */
export function orderNearest(points: [number, number][], startX: number, startY: number): number[] {
  const remaining = points.map((_, i) => i);
  const order: number[] = [];
  let cx = startX;
  let cy = startY;
  while (remaining.length) {
    let bi = 0;
    let bd = Infinity;
    for (let k = 0; k < remaining.length; k++) {
      const [px, py] = points[remaining[k]];
      const d = (px - cx) ** 2 + (py - cy) ** 2;
      if (d < bd) {
        bd = d;
        bi = k;
      }
    }
    const idx = remaining.splice(bi, 1)[0];
    order.push(idx);
    [cx, cy] = points[idx];
  }
  return order;
}

/** Drill registration holes first (datum), then ascending diameter — must match
 *  the emitter's CLASS_ORDER. */
const CLASS_ORDER: Record<DrillGroup["class"], number> = {
  registration: 0,
  pth: 1,
  npth: 2,
  mechanical: 3,
};

export interface RouteGroup {
  diameterMm: number;
  class: DrillGroup["class"];
  toolId: string | null;
  orderedHoles: PlanHole[];
}

export interface DrillRoute {
  groups: RouteGroup[];       // in drill order
  pathPoints: PlanHole[];     // flattened traverse order (group by group)
  totalHoles: number;
  toolCount: number;          // distinct non-null toolIds
}

/** Order the plan for drilling/preview: groups registration→ascending diameter,
 *  holes within a group by nearest-neighbour, carrying the cursor across groups.
 *  `start` mirrors the emitter's machine origin = panel bottom-left (0, panelHeight). */
export function planDrillRoute(plan: PanelDrillPlan, start: { xMm: number; yMm: number }): DrillRoute {
  const groups = [...plan.groups].sort(
    (a, b) => CLASS_ORDER[a.class] - CLASS_ORDER[b.class] || a.diameterMm - b.diameterMm,
  );
  const out: RouteGroup[] = [];
  const path: PlanHole[] = [];
  let cx = start.xMm;
  let cy = start.yMm;
  const toolIds = new Set<string>();
  for (const g of groups) {
    const pts: [number, number][] = g.holes.map((h) => [h.xMm, h.yMm]);
    const order = orderNearest(pts, cx, cy);
    const ordered = order.map((i) => g.holes[i]);
    out.push({ diameterMm: g.diameterMm, class: g.class, toolId: g.toolId, orderedHoles: ordered });
    for (const h of ordered) path.push(h);
    if (ordered.length) {
      cx = ordered[ordered.length - 1].xMm;
      cy = ordered[ordered.length - 1].yMm;
    }
    if (g.toolId) toolIds.add(g.toolId);
  }
  return { groups: out, pathPoints: path, totalHoles: path.length, toolCount: toolIds.size };
}

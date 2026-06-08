import type { PanelDrillPlan, DrillGroup, PlanHole } from "@/lib/panelDrill";
import type { Rect } from "@/lib/keepoutGeometry";
import { KEEPOUT_TRAVERSE_MARGIN_MM } from "@/lib/keepoutGeometry";
import { routeAvoiding, type PanelBounds } from "@/lib/visibilityRoute";

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
 *  `start` mirrors the emitter's machine origin = panel bottom-left (0, panelHeight).
 *  `zones` are keep-out zones in panel space; when provided, detour waypoints are
 *  inserted between consecutive path points to route around the zones. */
export function planDrillRoute(
  plan: PanelDrillPlan,
  start: { xMm: number; yMm: number },
  zones: Rect[] = [],
  panel?: PanelBounds,
): DrillRoute {
  const groups = [...plan.groups].sort(
    (a, b) => CLASS_ORDER[a.class] - CLASS_ORDER[b.class] || a.diameterMm - b.diameterMm,
  );
  const out: RouteGroup[] = [];
  // Collect the actual drill holes in travel order (without waypoints).
  const orderedHolesList: PlanHole[] = [];
  let cx = start.xMm;
  let cy = start.yMm;
  const toolIds = new Set<string>();
  for (const g of groups) {
    const pts: [number, number][] = g.holes.map((h) => [h.xMm, h.yMm]);
    const order = orderNearest(pts, cx, cy);
    const ordered = order.map((i) => g.holes[i]);
    out.push({ diameterMm: g.diameterMm, class: g.class, toolId: g.toolId, orderedHoles: ordered });
    for (const h of ordered) orderedHolesList.push(h);
    if (ordered.length) {
      cx = ordered[ordered.length - 1].xMm;
      cy = ordered[ordered.length - 1].yMm;
    }
    if (g.toolId) toolIds.add(g.toolId);
  }

  // Build pathPoints: for each consecutive pair (prev→cur), insert detour waypoints
  // before the actual hole so the traverse avoids keep-out zones.
  const path: PlanHole[] = [];
  let prevX = start.xMm;
  let prevY = start.yMm;
  for (const h of orderedHolesList) {
    if (zones.length > 0) {
      const waypoints = routeAvoiding(
        { x: prevX, y: prevY },
        { x: h.xMm, y: h.yMm },
        zones,
        KEEPOUT_TRAVERSE_MARGIN_MM,
        panel,
      );
      for (const wp of waypoints) {
        path.push({ xMm: wp.x, yMm: wp.y });
      }
    }
    path.push(h);
    prevX = h.xMm;
    prevY = h.yMm;
  }

  return {
    groups: out,
    pathPoints: path,
    totalHoles: orderedHolesList.length,
    toolCount: toolIds.size,
  };
}

/** Holes in travel order across all groups (no waypoints). */
export function orderedHoleList(route: DrillRoute): PlanHole[] {
  return route.groups.flatMap((g) => g.orderedHoles);
}

/** For each ordered hole, its index in route.pathPoints (matched by coords).
 *  pathPoints contains keep-out detour waypoints too, so this maps hole N → path index. */
export function buildHoleToPathIndex(route: DrillRoute): number[] {
  const holes = orderedHoleList(route);
  return holes.map((h) => route.pathPoints.findIndex((p) => p.xMm === h.xMm && p.yMm === h.yMm));
}

/** Map a flat hole index (sequential across all groups' orderedHoles) to its route group.
 *  Returns null when holeIndex is null, negative, or out of range. */
export function activeGroupForHole(
  route: DrillRoute,
  holeIndex: number | null,
): { gi: number; group: RouteGroup } | null {
  if (holeIndex == null || holeIndex < 0) return null;
  let acc = 0;
  for (let gi = 0; gi < route.groups.length; gi++) {
    const n = route.groups[gi].orderedHoles.length;
    if (holeIndex < acc + n) return { gi, group: route.groups[gi] };
    acc += n;
  }
  return null;
}

/** The drill class of the hole at a given run-order index (flattened group
 *  order). Returns null if the index is out of range. Used to colour the active
 *  hole's progress ring by its bit. */
export function classAtRunIndex(
  route: DrillRoute,
  index: number,
): RouteGroup["class"] | null {
  if (index < 0) return null;
  let acc = 0;
  for (const g of route.groups) {
    if (index < acc + g.orderedHoles.length) return g.class;
    acc += g.orderedHoles.length;
  }
  return null;
}

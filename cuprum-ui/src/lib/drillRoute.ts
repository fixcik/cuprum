import type { PlanHole } from "@/lib/panelDrill";
import type { DrillRoute, RouteGroup } from "@/lib/api";

// The route is now computed in the Rust core (`api.drill.plan`). The types live
// in api.ts (the typed Rust boundary); re-export them here so existing imports
// (`@/lib/drillRoute`) keep resolving without duplicating the definitions.
export type { DrillRoute, RouteGroup };

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

import type { DrillRoute } from "@/lib/drillRoute";
import type { Tool } from "@/lib/toolLibrary";
import type { CncProfile } from "@/lib/cncProfile";

export interface DrillEstimate {
  travelMm: number;
  timeSec: number;
  toolChanges: number;
}

/** Rough drill-time estimate from a planned route.
 *
 *  travelMm   — sum of Euclidean distances between consecutive pathPoints.
 *  toolChanges — number of groups that have a non-null toolId (each requires
 *                a physical bit swap before its first hole).
 *  timeSec    — rapids at jogFeedMmMin + per-hole plunge/retract + 30 s/swap. */
export function estimateDrill(
  route: DrillRoute,
  tools: Tool[],
  cncProfile: CncProfile,
  substrateThicknessMm: number,
): DrillEstimate {
  // Travel distance: sum Euclidean distances over consecutive pathPoints.
  let travelMm = 0;
  const pts = route.pathPoints;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].xMm - pts[i - 1].xMm;
    const dy = pts[i].yMm - pts[i - 1].yMm;
    travelMm += Math.sqrt(dx * dx + dy * dy);
  }

  // Tool changes: groups with an assigned tool.
  const toolChanges = route.groups.filter((g) => g.toolId != null).length;

  // Build a toolId→recommendedPlungeMmMin lookup for quick per-hole access.
  const plungeByToolId = new Map<string, number>();
  for (const tool of tools) {
    plungeByToolId.set(tool.id, tool.recommendedPlungeMmMin);
  }

  // Per-hole plunge+retract time.
  const depth = substrateThicknessMm + 0.3; // breakthrough margin
  let holeSec = 0;
  for (const g of route.groups) {
    const plungeMmMin = (g.toolId ? plungeByToolId.get(g.toolId) : undefined) ?? 60;
    // down + up, plunge in mm/min → sec per half = depth / plungeMmMin * 60
    const perHole = (2 * depth) / plungeMmMin * 60;
    holeSec += perHole * g.orderedHoles.length;
  }

  // Rapid travel time: travelMm at jogFeedMmMin.
  const rapidSec = travelMm / cncProfile.jogFeedMmMin * 60;

  // Operator tool-change overhead: 30 s each.
  const changeSec = toolChanges * 30;

  const timeSec = Math.round(rapidSec + holeSec + changeSec);

  return { travelMm, timeSec, toolChanges };
}

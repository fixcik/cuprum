import type { DrillRoute, RouteGroup } from "@/lib/drillRoute";
import type { PlanHole, PanelDrillPlan } from "@/lib/panelDrill";
import { enumerateHoles } from "@/lib/drillSelection";

export interface HoleHit {
  key: string;
  groupIdx: number;
  holeIdx: number;
  hole: PlanHole;
  group: RouteGroup;
}

/**
 * Nearest hole to a panel-space mm point, within (hole radius + screen margin).
 * marginPx converted to mm via pxPerMm. Returns null if none in range.
 * key = `${gi}-${hi}`.
 *
 * Threshold per hole = max(group.diameterMm / 2 + marginPx / pxPerMm, marginPx / pxPerMm).
 * This ensures even very small holes get at least marginPx worth of hit area.
 */
export function nearestHole(
  pointMm: { x: number; y: number },
  route: DrillRoute,
  pxPerMm: number,
  marginPx = 4,
): HoleHit | null {
  const marginMm = marginPx / pxPerMm;
  let bestDist = Infinity;
  let bestHit: HoleHit | null = null;

  for (let gi = 0; gi < route.groups.length; gi++) {
    const group = route.groups[gi];
    const radiusMm = group.diameterMm / 2;
    // Threshold: at least marginMm, expanded by the physical radius of the hole.
    const threshold = Math.max(radiusMm + marginMm, marginMm);

    for (let hi = 0; hi < group.orderedHoles.length; hi++) {
      const hole = group.orderedHoles[hi];
      const dx = hole.xMm - pointMm.x;
      const dy = hole.yMm - pointMm.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= threshold && dist < bestDist) {
        bestDist = dist;
        bestHit = { key: `${gi}-${hi}`, groupIdx: gi, holeIdx: hi, hole, group };
      }
    }
  }

  return bestHit;
}

export interface PlanHoleHit {
  id: string;
  hole: PlanHole;
}

/**
 * Nearest hole in the full plan (by stable id) to a panel-space mm point.
 * Mirrors nearestHole but iterates enumerateHoles(plan) and returns the stable id.
 * Use for click-toggle on the canvas where all holes are rendered regardless of selection.
 */
export function nearestPlanHole(
  pointMm: { x: number; y: number },
  plan: PanelDrillPlan,
  pxPerMm: number,
  marginPx = 4,
): PlanHoleHit | null {
  const marginMm = marginPx / pxPerMm;
  let bestDist = Infinity;
  let bestHit: PlanHoleHit | null = null;

  for (const eh of enumerateHoles(plan)) {
    const radiusMm = eh.diameterMm / 2;
    const threshold = Math.max(radiusMm + marginMm, marginMm);
    const dx = eh.hole.xMm - pointMm.x;
    const dy = eh.hole.yMm - pointMm.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= threshold && dist < bestDist) {
      bestDist = dist;
      bestHit = { id: eh.id, hole: eh.hole };
    }
  }

  return bestHit;
}

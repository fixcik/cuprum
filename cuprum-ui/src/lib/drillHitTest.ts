import type { DrillRoute, RouteGroup } from "@/lib/drillRoute";
import type { PlanHole } from "@/lib/panelDrill";

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

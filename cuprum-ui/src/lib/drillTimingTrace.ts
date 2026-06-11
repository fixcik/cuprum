import type { DrillRoute } from "@/lib/drillRoute";
import { activeGroupForHole } from "@/lib/drillRoute";

/** One finished hole's measured machine time, from the backend timing payload. */
export interface DrillTimingSample {
  /** Flat run-order hole index (matches `activeGroupForHole`). */
  holeIndex: number;
  /** Wall-clock ms the hole's machine work took (stream + settle, no operator-wait). */
  actualMs: number;
}

export interface DrillGroupTiming {
  /** Route group index. */
  gi: number;
  diameterMm: number;
  /** Holes actually measured in this group. */
  holes: number;
  actualSec: number;
  estimatedSec: number;
  /** actual / estimated; >1 means the run was slower than estimated. null if estimate 0. */
  ratio: number | null;
}

/** Actual-vs-estimated motion time of a drill run, for estimate calibration. */
export interface DrillTimingReport {
  /** Spindle feed override (%) in effect at run end — actual time scales with it, so a
   *  non-100% value means actual/estimate ratios aren't directly comparable. */
  feedOverridePct: number;
  holesMeasured: number;
  totalActualSec: number;
  totalEstimatedSec: number;
  totalRatio: number | null;
  perGroup: DrillGroupTiming[];
  /** Per-hole detail (run order) for fine analysis: actual vs the group's per-hole share. */
  perHole: Array<{
    holeIndex: number;
    gi: number;
    actualSec: number;
    estimatedSec: number;
  }>;
}

function ratio(actual: number, estimated: number): number | null {
  return estimated > 0 ? actual / estimated : null;
}

/** Build an actual-vs-estimated timing report from per-hole samples, the route, and the
 *  Rust per-group motion estimate. Pure — unit-tested.
 *
 *  Per-group: actual = sum of its measured holes; estimated = `groupMotionSecs[gi]`.
 *  Per-hole estimate = the group's bucket spread evenly over its holes (the estimate is
 *  per-group, linear within). Samples for holes outside the route are ignored. */
export function buildDrillTimingReport(
  samples: DrillTimingSample[],
  route: DrillRoute,
  groupMotionSecs: number[],
  feedOverridePct: number,
): DrillTimingReport {
  const groupActualMs = new Array<number>(route.groups.length).fill(0);
  const groupHoles = new Array<number>(route.groups.length).fill(0);
  const perHole: DrillTimingReport["perHole"] = [];

  for (const s of samples) {
    const grp = activeGroupForHole(route, s.holeIndex);
    if (!grp) continue; // sample outside the route — skip
    const { gi, group } = grp;
    groupActualMs[gi] += s.actualMs;
    groupHoles[gi] += 1;
    const holesInGroup = group.orderedHoles.length;
    const perHoleEst = holesInGroup > 0 ? (groupMotionSecs[gi] ?? 0) / holesInGroup : 0;
    perHole.push({
      holeIndex: s.holeIndex,
      gi,
      actualSec: s.actualMs / 1000,
      estimatedSec: perHoleEst,
    });
  }

  const perGroup: DrillGroupTiming[] = [];
  for (let gi = 0; gi < route.groups.length; gi++) {
    if (groupHoles[gi] === 0) continue; // group not (yet) drilled — omit
    const actualSec = groupActualMs[gi] / 1000;
    const estimatedSec = groupMotionSecs[gi] ?? 0;
    perGroup.push({
      gi,
      diameterMm: route.groups[gi].diameterMm,
      holes: groupHoles[gi],
      actualSec,
      estimatedSec,
      ratio: ratio(actualSec, estimatedSec),
    });
  }

  const totalActualSec = perGroup.reduce((a, g) => a + g.actualSec, 0);
  const totalEstimatedSec = perGroup.reduce((a, g) => a + g.estimatedSec, 0);

  return {
    feedOverridePct,
    holesMeasured: perHole.length,
    totalActualSec,
    totalEstimatedSec,
    totalRatio: ratio(totalActualSec, totalEstimatedSec),
    perGroup,
    perHole,
  };
}

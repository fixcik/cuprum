import type { DrillRoute } from "@/lib/drillRoute";
import { scaledMotionSec } from "@/lib/feedOverride";

/** Time + holes left until the NEXT tool-change pause. Pure — unit-tested. */
export interface ToolChangeEta {
  /** Motion seconds until the run finishes the current group (the next tool-change
   *  pause happens right after it), rescaled to the live feed override. */
  etaSec: number;
  /** Holes still to drill in the current group before that change. */
  holesRemaining: number;
}

/** Estimate time + holes left until the next tool change, or null when none lies ahead
 *  — the run is in (or past) the last group with holes, or `holesCompleted` is out of
 *  range. Uses the Rust per-group motion buckets (`groupMotionSecs`), scaled to the live
 *  feed override (only the feed-limited share `groupFeedSecs` scales), then by the
 *  fraction of the current group's holes still undrilled (linear within the group).
 *
 *  @param holesCompleted flat run-order index of the NEXT hole to drill (0-based);
 *    equals the count of holes already finished.
 *  @param feedOverridePct live spindle feed override (%); 100 = nominal. */
export function toolChangeEta(
  route: DrillRoute,
  groupMotionSecs: number[],
  groupFeedSecs: number[],
  holesCompleted: number,
  feedOverridePct: number,
): ToolChangeEta | null {
  const groups = route.groups;
  if (holesCompleted < 0) return null;

  let acc = 0;
  for (let gi = 0; gi < groups.length; gi++) {
    const n = groups[gi].orderedHoles.length;
    if (n > 0 && holesCompleted < acc + n) {
      // A tool change follows only if a later group still has holes to drill.
      const changeAhead = groups.slice(gi + 1).some((g) => g.orderedHoles.length > 0);
      if (!changeAhead) return null;

      const remainingInGroup = acc + n - holesCompleted;
      const groupSec = scaledMotionSec(
        groupMotionSecs[gi] ?? 0,
        groupFeedSecs[gi] ?? 0,
        feedOverridePct,
      );
      const etaSec = groupSec * (remainingInGroup / n);
      return { etaSec, holesRemaining: remainingInGroup };
    }
    acc += n;
  }
  return null;
}

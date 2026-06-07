import type { PanelDrillPlan, PlanHole } from "@/lib/panelDrill";
import type { DrillClass } from "@/lib/api";
import type { DrillRoute } from "@/lib/drillRoute";
import { orderedHoleList } from "@/lib/drillRoute";

/** A hole from the full plan with its stable id and group/hole indices. */
export interface EnumeratedHole {
  id: string;
  gi: number;
  hi: number;
  class: DrillClass;
  diameterMm: number;
  hole: PlanHole;
}

/** Stable hole id = "<groupIndexInFullPlan>:<holeIndexInGroup>". The full plan's
 *  group order and per-group hole order are fixed for a panel, so this id is stable
 *  regardless of which classes/holes are selected (route order is NOT stable). */
export const holeId = (gi: number, hi: number): string => `${gi}:${hi}`;

/** Enumerate every hole in the full plan in plan order, assigning stable ids. */
export function enumerateHoles(plan: PanelDrillPlan): EnumeratedHole[] {
  const out: EnumeratedHole[] = [];
  plan.groups.forEach((g, gi) =>
    g.holes.forEach((hole, hi) =>
      out.push({ id: holeId(gi, hi), gi, hi, class: g.class, diameterMm: g.diameterMm, hole }),
    ),
  );
  return out;
}

/** Return the set of stable hole ids whose group class is in the given set. */
export function holesForClasses(plan: PanelDrillPlan, classes: Set<DrillClass>): Set<string> {
  return new Set(enumerateHoles(plan).filter((h) => classes.has(h.class)).map((h) => h.id));
}

/** Build a plan containing only the selected holes (by stable id). Partially
 *  selected groups keep just their selected holes; empty groups are dropped. Each
 *  retained hole is tagged with its stable `id` so the route order can be mapped
 *  back to stable ids. Totals/unmatched recomputed; keep-out fields preserved
 *  (mirrors filterPlanByClasses). */
export function subPlanForSelection(plan: PanelDrillPlan, selected: Set<string>): PanelDrillPlan {
  const groups = plan.groups
    .map((g, gi) => {
      const holes: PlanHole[] = g.holes
        .map((h, hi) => ({ ...h, id: holeId(gi, hi) }))
        .filter((h) => selected.has(h.id!));
      return { ...g, holes };
    })
    .filter((g) => g.holes.length > 0);
  const unmatched = new Set<number>();
  for (const g of groups) if (!g.toolId) unmatched.add(g.diameterMm);
  return {
    ...plan,
    groups,
    totalHoles: groups.reduce((n, g) => n + g.holes.length, 0),
    unmatchedDiametersMm: [...unmatched].sort((a, b) => a - b),
  };
}

/** Stable hole ids in the route's drill order (route must be built from a sub-plan
 *  whose holes carry `id`). Used to map run progress (holesCompleted /
 *  currentHoleIndex, both in route order) back to stable hole ids. */
export function holeIdsInRunOrder(route: DrillRoute): (string | null)[] {
  return orderedHoleList(route).map((h) => h.id ?? null);
}

/** Selected minus already-drilled → still-to-drill. */
export function remainingHoles(selected: Set<string>, drilled: Set<string>): Set<string> {
  return new Set([...selected].filter((id) => !drilled.has(id)));
}

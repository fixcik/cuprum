import type { DrillClass } from "@/lib/api";
import type { PanelDrillPlan, DrillGroup } from "@/lib/panelDrill";

/** A drill pass: a named, fixed set of classes drilled together in one run. */
export interface DrillPass {
  id: "alignment" | "preplating" | "postplating";
  classes: DrillClass[];
}

/** The three process passes. Independent (non-overlapping) — between
 *  "preplating" and "postplating" the panel goes through the copper bath. */
export const DRILL_PASSES: DrillPass[] = [
  { id: "alignment", classes: ["registration"] },
  { id: "preplating", classes: ["pth"] },
  { id: "postplating", classes: ["npth", "mechanical"] },
];

/** All four classes in display order. */
export const DRILL_CLASSES: DrillClass[] = ["registration", "pth", "npth", "mechanical"];

/** Default selection when the drill window opens: the alignment pass. */
export const DEFAULT_SELECTED_CLASSES = (): Set<DrillClass> => new Set(["registration"]);

/** Hole count per class across the whole (unfiltered) plan. */
export function classCounts(plan: PanelDrillPlan): Record<DrillClass, number> {
  const counts: Record<DrillClass, number> = { registration: 0, pth: 0, npth: 0, mechanical: 0 };
  for (const g of plan.groups) counts[g.class] += g.holes.length;
  return counts;
}

/** Return a copy of the plan keeping only groups whose class is selected.
 *  Totals are recomputed; keep-out skip counts are preserved (they describe the
 *  whole panel, not the selection). */
export function filterPlanByClasses(plan: PanelDrillPlan, selected: Set<DrillClass>): PanelDrillPlan {
  const groups: DrillGroup[] = plan.groups.filter((g) => selected.has(g.class));
  const unmatched = new Set<number>();
  for (const g of groups) if (!g.toolId) unmatched.add(g.diameterMm);
  return {
    ...plan,
    groups,
    totalHoles: groups.reduce((n, g) => n + g.holes.length, 0),
    unmatchedDiametersMm: [...unmatched].sort((a, b) => a - b),
    // The loud "registration holes in a clamp zone" banner is only actionable
    // when this run actually drills registration holes — silence it otherwise.
    // (skippedInKeepout stays panel-wide: the plan doesn't track which class each
    // skipped board hole belonged to.)
    registrationInKeepout: selected.has("registration") ? plan.registrationInKeepout : 0,
  };
}

/** Which preset id exactly matches the current selection, or null ("custom"). */
export function activePresetId(selected: Set<DrillClass>): DrillPass["id"] | null {
  for (const p of DRILL_PASSES) {
    if (p.classes.length === selected.size && p.classes.every((c) => selected.has(c))) {
      return p.id;
    }
  }
  return null;
}

/** Return the class set for a given pass id. Empty set if the id is unknown. */
export function passToClasses(id: DrillPass["id"]): Set<DrillClass> {
  const p = DRILL_PASSES.find((x) => x.id === id);
  return new Set(p ? p.classes : []);
}

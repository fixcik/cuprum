import { describe, it, expect } from "vitest";
import {
  DRILL_PASSES, classCounts, filterPlanByClasses, activePresetId, DEFAULT_SELECTED_CLASSES,
} from "@/lib/drillPasses";
import type { PanelDrillPlan } from "@/lib/panelDrill";

const plan = (): PanelDrillPlan => ({
  groups: [
    { diameterMm: 3, class: "registration", toolId: "t1", holes: [{ xMm: 0, yMm: 0 }, { xMm: 1, yMm: 1 }] },
    { diameterMm: 0.6, class: "pth", toolId: "t2", holes: [{ xMm: 2, yMm: 2 }] },
    { diameterMm: 1, class: "mechanical", toolId: null, holes: [{ xMm: 3, yMm: 3 }] },
  ],
  totalHoles: 4,
  unmatchedDiametersMm: [1],
  skippedInKeepout: 5,
  registrationInKeepout: 0,
});

describe("drillPasses", () => {
  it("counts holes per class over the full plan", () => {
    expect(classCounts(plan())).toEqual({ registration: 2, pth: 1, npth: 0, mechanical: 1 });
  });

  it("filters groups by selected classes and recomputes totals", () => {
    const f = filterPlanByClasses(plan(), new Set(["registration"]));
    expect(f.groups.map((g) => g.class)).toEqual(["registration"]);
    expect(f.totalHoles).toBe(2);
    expect(f.unmatchedDiametersMm).toEqual([]);
    expect(f.skippedInKeepout).toBe(5);
  });

  it("preserves an unmatched diameter when its group stays selected", () => {
    const f = filterPlanByClasses(plan(), new Set(["mechanical"]));
    expect(f.unmatchedDiametersMm).toEqual([1]);
  });

  it("identifies the active preset, or null for a custom selection", () => {
    expect(activePresetId(new Set(["registration"]))).toBe("alignment");
    expect(activePresetId(new Set(["npth", "mechanical"]))).toBe("postplating");
    expect(activePresetId(new Set(["pth", "mechanical"]))).toBeNull();
    expect(activePresetId(new Set())).toBeNull();
  });

  it("defaults to the alignment pass", () => {
    expect([...DEFAULT_SELECTED_CLASSES()]).toEqual(["registration"]);
    expect(DRILL_PASSES[0].id).toBe("alignment");
  });
});

import { describe, expect, test } from "vitest";
import {
  enumerateHoles,
  holeId,
  holesForClasses,
  subPlanForSelection,
  remainingHoles,
  holeIdsInRunOrder,
} from "@/lib/drillSelection";
import { planDrillRoute } from "@/lib/drillRoute";
import type { PanelDrillPlan } from "@/lib/panelDrill";

// Fixture plan: 3 groups — registration (1 hole), pth (2 holes), npth (1 hole).
const plan: PanelDrillPlan = {
  groups: [
    { diameterMm: 2.0, class: "registration", toolId: "t1", holes: [{ xMm: 0, yMm: 0 }] },
    {
      diameterMm: 0.8,
      class: "pth",
      toolId: "t2",
      holes: [
        { xMm: 10, yMm: 0 },
        { xMm: 20, yMm: 0 },
      ],
    },
    { diameterMm: 1.0, class: "npth", toolId: null, holes: [{ xMm: 30, yMm: 0 }] },
  ],
  totalHoles: 4,
  unmatchedDiametersMm: [1.0],
  skippedInKeepout: 0,
  registrationInKeepout: 0,
};

describe("holeId", () => {
  test("formats group:hole", () => {
    expect(holeId(1, 0)).toBe("1:0");
  });

  test("handles zero indices", () => {
    expect(holeId(0, 0)).toBe("0:0");
  });
});

describe("enumerateHoles", () => {
  test("assigns stable ids over the full plan in plan order", () => {
    expect(enumerateHoles(plan).map((h) => h.id)).toEqual(["0:0", "1:0", "1:1", "2:0"]);
  });

  test("carries correct class and diameterMm for each hole", () => {
    const enumerated = enumerateHoles(plan);
    expect(enumerated[0].class).toBe("registration");
    expect(enumerated[1].class).toBe("pth");
    expect(enumerated[2].class).toBe("pth");
    expect(enumerated[3].class).toBe("npth");
    expect(enumerated[3].diameterMm).toBe(1.0);
  });

  test("provides gi and hi indices", () => {
    const enumerated = enumerateHoles(plan);
    expect(enumerated[2].gi).toBe(1);
    expect(enumerated[2].hi).toBe(1);
  });
});

describe("holesForClasses", () => {
  test("returns ids for selected classes", () => {
    expect([...holesForClasses(plan, new Set(["pth"]))].sort()).toEqual(["1:0", "1:1"]);
  });

  test("returns empty set when no classes match", () => {
    expect(holesForClasses(plan, new Set(["mechanical"])).size).toBe(0);
  });

  test("returns all ids when all classes selected", () => {
    const ids = holesForClasses(plan, new Set(["registration", "pth", "npth", "mechanical"]));
    expect([...ids].sort()).toEqual(["0:0", "1:0", "1:1", "2:0"]);
  });
});

describe("subPlanForSelection", () => {
  test("keeps only selected holes and tags ids", () => {
    const sp = subPlanForSelection(plan, new Set(["1:1", "2:0"]));
    expect(sp.totalHoles).toBe(2);
    expect(sp.groups.map((g) => g.class)).toEqual(["pth", "npth"]);
    // Only the second pth hole (1:1) kept
    expect(sp.groups[0].holes.map((h) => h.id)).toEqual(["1:1"]);
    // The npth hole (2:0) kept
    expect(sp.groups[1].holes.map((h) => h.id)).toEqual(["2:0"]);
  });

  test("drops empty groups", () => {
    // Select only registration — pth and npth groups should be dropped
    const sp = subPlanForSelection(plan, new Set(["0:0"]));
    expect(sp.groups.length).toBe(1);
    expect(sp.groups[0].class).toBe("registration");
  });

  test("recomputes totalHoles", () => {
    const sp = subPlanForSelection(plan, new Set(["0:0", "1:0"]));
    expect(sp.totalHoles).toBe(2);
  });

  test("recomputes unmatchedDiametersMm for retained groups", () => {
    // npth group has toolId: null, so its diameterMm should appear in unmatched
    const sp = subPlanForSelection(plan, new Set(["2:0"]));
    expect(sp.unmatchedDiametersMm).toEqual([1.0]);
  });

  test("does not include unmatched for groups with toolId", () => {
    // registration and pth both have toolIds
    const sp = subPlanForSelection(plan, new Set(["0:0", "1:0", "1:1"]));
    expect(sp.unmatchedDiametersMm).toEqual([]);
  });

  test("preserves keep-out skip counts from original plan", () => {
    const planWithSkips: PanelDrillPlan = { ...plan, skippedInKeepout: 3, registrationInKeepout: 1 };
    const sp = subPlanForSelection(planWithSkips, new Set(["0:0"]));
    expect(sp.skippedInKeepout).toBe(3);
    expect(sp.registrationInKeepout).toBe(1);
  });

  test("preserves original hole coordinates", () => {
    const sp = subPlanForSelection(plan, new Set(["1:0"]));
    expect(sp.groups[0].holes[0].xMm).toBe(10);
    expect(sp.groups[0].holes[0].yMm).toBe(0);
  });

  test("returns empty plan for empty selection", () => {
    const sp = subPlanForSelection(plan, new Set());
    expect(sp.groups.length).toBe(0);
    expect(sp.totalHoles).toBe(0);
  });
});

describe("holeIdsInRunOrder", () => {
  test("returns stable ids in run order", () => {
    const sp = subPlanForSelection(plan, holesForClasses(plan, new Set(["registration", "pth"])));
    const route = planDrillRoute(sp, { xMm: 0, yMm: 0 }, []);
    const ids = holeIdsInRunOrder(route);
    expect(ids).toContain("0:0");
    expect(ids.length).toBe(3);
    expect(new Set(ids).size).toBe(3); // no dupes, all stable ids
  });

  test("returns all selected ids (set membership)", () => {
    const sp = subPlanForSelection(plan, holesForClasses(plan, new Set(["registration", "pth"])));
    const route = planDrillRoute(sp, { xMm: 0, yMm: 0 }, []);
    const ids = new Set(holeIdsInRunOrder(route));
    expect(ids.has("0:0")).toBe(true);
    expect(ids.has("1:0")).toBe(true);
    expect(ids.has("1:1")).toBe(true);
  });

  test("returns empty array for empty route", () => {
    const sp = subPlanForSelection(plan, new Set());
    const route = planDrillRoute(sp, { xMm: 0, yMm: 0 }, []);
    expect(holeIdsInRunOrder(route)).toEqual([]);
  });
});

describe("remainingHoles", () => {
  test("subtracts drilled from selected", () => {
    expect([...remainingHoles(new Set(["1:0", "1:1"]), new Set(["1:0"]))]).toEqual(["1:1"]);
  });

  test("returns full selected when nothing drilled", () => {
    const remaining = remainingHoles(new Set(["0:0", "1:0"]), new Set());
    expect([...remaining].sort()).toEqual(["0:0", "1:0"]);
  });

  test("returns empty when all drilled", () => {
    const remaining = remainingHoles(new Set(["0:0"]), new Set(["0:0"]));
    expect(remaining.size).toBe(0);
  });
});

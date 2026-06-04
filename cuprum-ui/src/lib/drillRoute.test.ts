import { describe, expect, it } from "vitest";
import { orderNearest, planDrillRoute } from "@/lib/drillRoute";
import type { PanelDrillPlan } from "@/lib/panelDrill";

// ---------------------------------------------------------------------------
// orderNearest
// ---------------------------------------------------------------------------

describe("orderNearest", () => {
  it("returns indices in greedy nearest-neighbour order from start", () => {
    // Points: [0] at (10,0), [1] at (1,0), [2] at (5,0)
    // Start: (0,0) → nearest first = [1] (d=1), then [2] (d=4 from 1), then [0] (d=5 from 5)
    const pts: [number, number][] = [[10, 0], [1, 0], [5, 0]];
    const order = orderNearest(pts, 0, 0);
    expect(order).toEqual([1, 2, 0]);
  });

  it("is stable: ties resolve to the earlier index", () => {
    // Points [0] and [1] equidistant from (0,0)
    const pts: [number, number][] = [[1, 0], [-1, 0]];
    const order = orderNearest(pts, 0, 0);
    // d² = 1 for both; the loop picks the first k (k=0 → index 0)
    expect(order[0]).toBe(0);
  });

  it("handles empty input", () => {
    expect(orderNearest([], 0, 0)).toEqual([]);
  });

  it("handles a single point", () => {
    expect(orderNearest([[3, 4]], 0, 0)).toEqual([0]);
  });

  it("updates cursor between hops", () => {
    // Start (0,0). Points: [0]=(10,0), [1]=(11,0)
    // From origin, [0] is nearest (d²=100) vs [1] (d²=121).
    // After visiting [0], cursor=(10,0): [1] is at d²=1 → picked next.
    const pts: [number, number][] = [[10, 0], [11, 0]];
    const order = orderNearest(pts, 0, 0);
    expect(order).toEqual([0, 1]);
  });
});

// ---------------------------------------------------------------------------
// planDrillRoute
// ---------------------------------------------------------------------------

const makePlan = (groups: PanelDrillPlan["groups"]): PanelDrillPlan => ({
  groups,
  totalHoles: groups.reduce((n, g) => n + g.holes.length, 0),
  unmatchedDiametersMm: [],
});

describe("planDrillRoute", () => {
  it("orders groups: registration first, then pth/npth/mechanical ascending diameter", () => {
    const plan = makePlan([
      { diameterMm: 3.0, class: "mechanical", toolId: "t3", holes: [{ xMm: 0, yMm: 0 }] },
      { diameterMm: 0.6, class: "pth", toolId: "t06", holes: [{ xMm: 1, yMm: 1 }] },
      { diameterMm: 3.2, class: "registration", toolId: "t3r", holes: [{ xMm: 2, yMm: 2 }] },
    ]);
    const route = planDrillRoute(plan, { xMm: 0, yMm: 50 });
    expect(route.groups[0].class).toBe("registration");
    expect(route.groups[1].diameterMm).toBe(0.6); // pth before mechanical
    expect(route.groups[2].class).toBe("mechanical");
  });

  it("orders holes within a group by nearest-neighbour from start", () => {
    // Single pth group with 3 holes; start = (0, 0)
    const plan = makePlan([
      {
        diameterMm: 0.8,
        class: "pth",
        toolId: "t1",
        holes: [{ xMm: 10, yMm: 0 }, { xMm: 1, yMm: 0 }, { xMm: 5, yMm: 0 }],
      },
    ]);
    const route = planDrillRoute(plan, { xMm: 0, yMm: 0 });
    const xs = route.groups[0].orderedHoles.map((h) => h.xMm);
    expect(xs).toEqual([1, 5, 10]); // nearest-neighbour from (0,0)
  });

  it("carries cursor across groups", () => {
    // After first group ends at (5,0), second group's ordering starts from there.
    // Group1 (registration): single hole at (5,0)
    // Group2 (pth): holes at (4,0) and (10,0); from cursor (5,0), nearest is (4,0) (d=1) not (10,0) (d=25)
    const plan = makePlan([
      { diameterMm: 3.0, class: "registration", toolId: "tr", holes: [{ xMm: 5, yMm: 0 }] },
      {
        diameterMm: 0.8,
        class: "pth",
        toolId: "t1",
        holes: [{ xMm: 4, yMm: 0 }, { xMm: 10, yMm: 0 }],
      },
    ]);
    const route = planDrillRoute(plan, { xMm: 0, yMm: 0 });
    const pthHoles = route.groups[1].orderedHoles;
    expect(pthHoles[0].xMm).toBe(4); // nearest to cursor (5,0) after reg group
  });

  it("pathPoints is the flattened concatenation of orderedHoles across groups", () => {
    const plan = makePlan([
      { diameterMm: 0.6, class: "pth", toolId: "t1", holes: [{ xMm: 1, yMm: 0 }, { xMm: 2, yMm: 0 }] },
      { diameterMm: 1.0, class: "pth", toolId: "t2", holes: [{ xMm: 3, yMm: 0 }] },
    ]);
    const route = planDrillRoute(plan, { xMm: 0, yMm: 0 });
    expect(route.pathPoints).toHaveLength(3);
    expect(route.totalHoles).toBe(3);
  });

  it("toolCount counts distinct non-null toolIds", () => {
    const plan = makePlan([
      { diameterMm: 0.6, class: "pth", toolId: "t1", holes: [{ xMm: 0, yMm: 0 }] },
      { diameterMm: 0.7, class: "pth", toolId: null, holes: [{ xMm: 1, yMm: 0 }] }, // no tool
      { diameterMm: 1.0, class: "pth", toolId: "t2", holes: [{ xMm: 2, yMm: 0 }] },
      { diameterMm: 1.2, class: "npth", toolId: "t1", holes: [{ xMm: 3, yMm: 0 }] }, // same as first
    ]);
    const route = planDrillRoute(plan, { xMm: 0, yMm: 0 });
    expect(route.toolCount).toBe(2); // t1 and t2 only (null excluded, t1 deduped)
  });

  it("returns empty route for empty plan", () => {
    const plan = makePlan([]);
    const route = planDrillRoute(plan, { xMm: 0, yMm: 0 });
    expect(route.groups).toHaveLength(0);
    expect(route.pathPoints).toHaveLength(0);
    expect(route.totalHoles).toBe(0);
    expect(route.toolCount).toBe(0);
  });

  it("same-class groups sorted ascending by diameter", () => {
    const plan = makePlan([
      { diameterMm: 2.0, class: "pth", toolId: "t2", holes: [{ xMm: 0, yMm: 0 }] },
      { diameterMm: 0.5, class: "pth", toolId: "t05", holes: [{ xMm: 1, yMm: 0 }] },
      { diameterMm: 1.0, class: "pth", toolId: "t1", holes: [{ xMm: 2, yMm: 0 }] },
    ]);
    const route = planDrillRoute(plan, { xMm: 0, yMm: 0 });
    const diameters = route.groups.map((g) => g.diameterMm);
    expect(diameters).toEqual([0.5, 1.0, 2.0]);
  });
});

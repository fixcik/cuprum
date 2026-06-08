import { describe, expect, it } from "vitest";
import { orderNearest, planDrillRoute, orderedHoleList, buildHoleToPathIndex, activeGroupForHole, classAtRunIndex } from "@/lib/drillRoute";
import type { DrillRoute } from "@/lib/drillRoute";
import type { PanelDrillPlan } from "@/lib/panelDrill";
import { segIntersectsRect } from "@/lib/keepoutGeometry";
import type { Rect } from "@/lib/keepoutGeometry";

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
  skippedInKeepout: 0,
  registrationInKeepout: 0,
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

// ---------------------------------------------------------------------------
// planDrillRoute — keep-out zone detour
// ---------------------------------------------------------------------------

describe("planDrillRoute with keepout zones", () => {
  /** Checks that no consecutive segment in pathPoints crosses the expanded zone. */
  function noSegmentCrossesZone(
    pathPoints: { xMm: number; yMm: number }[],
    start: { xMm: number; yMm: number },
    zone: Rect,
    marginMm: number,
  ): boolean {
    const expanded: Rect = {
      x: zone.x - marginMm,
      y: zone.y - marginMm,
      w: zone.w + 2 * marginMm,
      h: zone.h + 2 * marginMm,
    };
    // Build the full point sequence including start.
    const pts = [start, ...pathPoints];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = { x: pts[i].xMm, y: pts[i].yMm };
      const b = { x: pts[i + 1].xMm, y: pts[i + 1].yMm };
      if (segIntersectsRect(a, b, expanded)) return false;
    }
    return true;
  }

  it("inserts detour waypoints when straight segment crosses a zone", () => {
    // Hole A at (5,5), hole B at (45,5). Zone centred at x=25, y=0..10.
    // Straight A→B passes through the zone; detour must go around.
    const zone: Rect = { x: 20, y: 0, w: 10, h: 10 };
    const plan = makePlan([
      {
        diameterMm: 0.8,
        class: "pth",
        toolId: "t1",
        holes: [{ xMm: 5, yMm: 5 }, { xMm: 45, yMm: 5 }],
      },
    ]);
    const start = { xMm: 0, yMm: 0 };
    const route = planDrillRoute(plan, start, [zone]);

    // pathPoints should contain more than just the 2 holes (waypoints were inserted).
    expect(route.pathPoints.length).toBeGreaterThan(2);

    // totalHoles must still be 2 (only actual holes, not waypoints).
    expect(route.totalHoles).toBe(2);

    // No segment in the full traversal (start + pathPoints) should cross the expanded zone.
    const MARGIN = 1.0; // KEEPOUT_TRAVERSE_MARGIN_MM
    expect(noSegmentCrossesZone(route.pathPoints, start, zone, MARGIN)).toBe(true);
  });

  it("does NOT insert waypoints when no zone is crossed", () => {
    // Holes well away from the zone.
    const zone: Rect = { x: 50, y: 50, w: 10, h: 10 };
    const plan = makePlan([
      {
        diameterMm: 0.8,
        class: "pth",
        toolId: "t1",
        holes: [{ xMm: 5, yMm: 5 }, { xMm: 10, yMm: 5 }],
      },
    ]);
    const route = planDrillRoute(plan, { xMm: 0, yMm: 0 }, [zone]);

    // Exactly the 2 holes, no extra waypoints.
    expect(route.pathPoints).toHaveLength(2);
    expect(route.totalHoles).toBe(2);
  });

  it("keeps detour waypoints inside the panel for an edge keep-out (#492)", () => {
    // Zone flush to the left edge; holes above and below it on the same x. The
    // straight line crosses the zone, and the only in-panel detour is to the
    // right — no waypoint may leave the panel rectangle.
    const panel = { minX: 0, minY: 0, maxX: 100, maxY: 60 };
    const zone: Rect = { x: 0, y: 20, w: 12, h: 20 };
    const plan = makePlan([
      {
        diameterMm: 0.8,
        class: "pth",
        toolId: "t1",
        holes: [{ xMm: 6, yMm: 10 }, { xMm: 6, yMm: 50 }],
      },
    ]);
    const start = { xMm: 6, yMm: 10 };
    const route = planDrillRoute(plan, start, [zone], panel);

    expect(route.pathPoints.length).toBeGreaterThan(2);
    const MARGIN = 1.0;
    expect(noSegmentCrossesZone(route.pathPoints, start, zone, MARGIN)).toBe(true);
    for (const p of route.pathPoints) {
      expect(p.xMm).toBeGreaterThanOrEqual(0);
      expect(p.xMm).toBeLessThanOrEqual(panel.maxX);
      expect(p.yMm).toBeGreaterThanOrEqual(0);
      expect(p.yMm).toBeLessThanOrEqual(panel.maxY);
    }
  });

  it("pathPoints equals holes-only when no zones passed (unchanged behaviour)", () => {
    const plan = makePlan([
      {
        diameterMm: 0.8,
        class: "pth",
        toolId: "t1",
        holes: [{ xMm: 5, yMm: 5 }, { xMm: 45, yMm: 5 }],
      },
    ]);
    const route = planDrillRoute(plan, { xMm: 0, yMm: 0 });
    expect(route.pathPoints).toHaveLength(2);
    expect(route.totalHoles).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// orderedHoleList
// ---------------------------------------------------------------------------

describe("orderedHoleList", () => {
  it("flattens holes across groups in group order", () => {
    const route: DrillRoute = {
      groups: [
        { diameterMm: 1, class: "registration", toolId: null, orderedHoles: [{ xMm: 1, yMm: 0 }, { xMm: 2, yMm: 0 }] },
        { diameterMm: 0.8, class: "pth", toolId: "t1", orderedHoles: [{ xMm: 3, yMm: 0 }] },
      ],
      pathPoints: [{ xMm: 1, yMm: 0 }, { xMm: 2, yMm: 0 }, { xMm: 3, yMm: 0 }],
      totalHoles: 3,
      toolCount: 1,
    };
    const holes = orderedHoleList(route);
    expect(holes).toHaveLength(3);
    expect(holes.map((h) => h.xMm)).toEqual([1, 2, 3]);
  });

  it("returns empty array for empty route", () => {
    const route: DrillRoute = { groups: [], pathPoints: [], totalHoles: 0, toolCount: 0 };
    expect(orderedHoleList(route)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildHoleToPathIndex
// ---------------------------------------------------------------------------

describe("buildHoleToPathIndex", () => {
  it("maps holes to their path indices, skipping waypoints", () => {
    // pathPoints = [waypoint, holeA, holeB] where waypoint has unique coords
    const holeA = { xMm: 10, yMm: 5 };
    const holeB = { xMm: 20, yMm: 5 };
    const waypoint = { xMm: 15, yMm: 0 }; // detour, not a hole
    const route: DrillRoute = {
      groups: [
        { diameterMm: 0.8, class: "pth", toolId: "t1", orderedHoles: [holeA, holeB] },
      ],
      pathPoints: [waypoint, holeA, holeB],
      totalHoles: 2,
      toolCount: 1,
    };
    const idx = buildHoleToPathIndex(route);
    expect(idx).toEqual([1, 2]); // holeA at path[1], holeB at path[2]
  });

  it("handles route without waypoints (indices match hole order)", () => {
    const h0 = { xMm: 0, yMm: 0 };
    const h1 = { xMm: 1, yMm: 0 };
    const route: DrillRoute = {
      groups: [{ diameterMm: 1, class: "registration", toolId: null, orderedHoles: [h0, h1] }],
      pathPoints: [h0, h1],
      totalHoles: 2,
      toolCount: 0,
    };
    expect(buildHoleToPathIndex(route)).toEqual([0, 1]);
  });
});

// ---------------------------------------------------------------------------
// activeGroupForHole
// ---------------------------------------------------------------------------

describe("activeGroupForHole", () => {
  const g0 = { diameterMm: 1, class: "registration" as const, toolId: null, orderedHoles: [{ xMm: 0, yMm: 0 }, { xMm: 1, yMm: 0 }] };
  const g1 = { diameterMm: 0.8, class: "pth" as const, toolId: "t1", orderedHoles: [{ xMm: 2, yMm: 0 }, { xMm: 3, yMm: 0 }, { xMm: 4, yMm: 0 }] };
  const route: DrillRoute = {
    groups: [g0, g1],
    pathPoints: [],
    totalHoles: 5,
    toolCount: 1,
  };

  it("returns first group for holeIndex=0 (first hole of g0)", () => {
    const result = activeGroupForHole(route, 0);
    expect(result).not.toBeNull();
    expect(result!.gi).toBe(0);
    expect(result!.group).toBe(g0);
  });

  it("returns first group for last hole of g0 (index=1)", () => {
    const result = activeGroupForHole(route, 1);
    expect(result!.gi).toBe(0);
  });

  it("returns second group for first hole of g1 (index=2)", () => {
    const result = activeGroupForHole(route, 2);
    expect(result!.gi).toBe(1);
    expect(result!.group).toBe(g1);
  });

  it("returns second group for last hole of g1 (index=4)", () => {
    const result = activeGroupForHole(route, 4);
    expect(result!.gi).toBe(1);
  });

  it("returns null for index out of range", () => {
    expect(activeGroupForHole(route, 5)).toBeNull();
    expect(activeGroupForHole(route, 100)).toBeNull();
  });

  it("returns null for negative index", () => {
    expect(activeGroupForHole(route, -1)).toBeNull();
  });

  it("returns null for holeIndex=null", () => {
    expect(activeGroupForHole(route, null)).toBeNull();
  });

  it("returns null for empty route", () => {
    const empty: DrillRoute = { groups: [], pathPoints: [], totalHoles: 0, toolCount: 0 };
    expect(activeGroupForHole(empty, 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// classAtRunIndex
// ---------------------------------------------------------------------------

describe("classAtRunIndex", () => {
  // Build a plan with 2 registration holes + 3 pth holes.
  // planDrillRoute sorts registration (CLASS_ORDER=0) before pth (CLASS_ORDER=1),
  // so run indices 0,1 → "registration" and 2,3,4 → "pth".
  const plan = makePlan([
    {
      diameterMm: 0.8,
      class: "pth",
      toolId: "t1",
      holes: [{ xMm: 10, yMm: 0 }, { xMm: 20, yMm: 0 }, { xMm: 30, yMm: 0 }],
    },
    {
      diameterMm: 3.2,
      class: "registration",
      toolId: "tr",
      holes: [{ xMm: 0, yMm: 0 }, { xMm: 5, yMm: 0 }],
    },
  ]);
  const route = planDrillRoute(plan, { xMm: 0, yMm: 0 });

  it("returns the class of the group the run index falls into", () => {
    expect(classAtRunIndex(route, 0)).toBe("registration");
    expect(classAtRunIndex(route, 1)).toBe("registration");
    expect(classAtRunIndex(route, 2)).toBe("pth");
    expect(classAtRunIndex(route, 4)).toBe("pth");
  });

  it("returns null for an out-of-range index", () => {
    expect(classAtRunIndex(route, 99)).toBeNull();
    expect(classAtRunIndex(route, -1)).toBeNull();
  });
});

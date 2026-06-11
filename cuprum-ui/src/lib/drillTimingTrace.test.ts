import { describe, expect, it } from "vitest";
import { buildDrillTimingReport, type DrillTimingSample } from "@/lib/drillTimingTrace";
import type { DrillRoute, RouteGroup } from "@/lib/drillRoute";

function routeOf(sizes: number[]): DrillRoute {
  const groups: RouteGroup[] = sizes.map((n, i) => ({
    diameterMm: i + 1,
    class: "pth",
    toolId: `t${i}`,
    orderedHoles: Array.from({ length: n }, (_, h) => ({ xMm: h, yMm: i })),
  }));
  return { groups, pathPoints: [], totalHoles: sizes.reduce((a, b) => a + b, 0), toolCount: sizes.length };
}

describe("buildDrillTimingReport", () => {
  // Two groups of 2 holes; estimates 4s and 10s.
  const route = routeOf([2, 2]);
  const secs = [4, 10];

  it("aggregates actual per group and computes ratios", () => {
    const samples: DrillTimingSample[] = [
      { holeIndex: 0, actualMs: 1500 },
      { holeIndex: 1, actualMs: 1500 }, // group 0 actual = 3s vs est 4s
      { holeIndex: 2, actualMs: 6000 },
      { holeIndex: 3, actualMs: 6000 }, // group 1 actual = 12s vs est 10s
    ];
    const r = buildDrillTimingReport(samples, route, secs, 100);
    expect(r.holesMeasured).toBe(4);
    expect(r.totalActualSec).toBeCloseTo(15);
    expect(r.totalEstimatedSec).toBeCloseTo(14);
    expect(r.totalRatio).toBeCloseTo(15 / 14);
    expect(r.perGroup).toHaveLength(2);
    expect(r.perGroup[0]).toMatchObject({ gi: 0, holes: 2, actualSec: 3, estimatedSec: 4 });
    expect(r.perGroup[0].ratio).toBeCloseTo(0.75);
    expect(r.perGroup[1]).toMatchObject({ gi: 1, holes: 2, actualSec: 12, estimatedSec: 10 });
    expect(r.perGroup[1].ratio).toBeCloseTo(1.2);
  });

  it("per-hole estimate is the group's bucket spread evenly", () => {
    const r = buildDrillTimingReport([{ holeIndex: 0, actualMs: 2000 }], route, secs, 100);
    // group 0 bucket 4s over 2 holes → 2s per hole.
    expect(r.perHole[0]).toMatchObject({ holeIndex: 0, gi: 0, actualSec: 2, estimatedSec: 2 });
  });

  it("records the feed override", () => {
    const r = buildDrillTimingReport([], route, secs, 150);
    expect(r.feedOverridePct).toBe(150);
  });

  it("omits groups with no measured holes (partial run)", () => {
    const r = buildDrillTimingReport([{ holeIndex: 0, actualMs: 1000 }], route, secs, 100);
    expect(r.perGroup).toHaveLength(1);
    expect(r.perGroup[0].gi).toBe(0);
    expect(r.totalActualSec).toBeCloseTo(1);
    expect(r.totalEstimatedSec).toBeCloseTo(4); // only group 0 counted
  });

  it("skips samples outside the route", () => {
    const r = buildDrillTimingReport([{ holeIndex: 99, actualMs: 5000 }], route, secs, 100);
    expect(r.holesMeasured).toBe(0);
    expect(r.perGroup).toHaveLength(0);
    expect(r.totalActualSec).toBe(0);
  });

  it("ratio is null when the estimate bucket is 0", () => {
    const r = buildDrillTimingReport([{ holeIndex: 0, actualMs: 1000 }], routeOf([1]), [0], 100);
    expect(r.perGroup[0].ratio).toBeNull();
    expect(r.totalRatio).toBeNull();
  });

  it("empty samples → zeroed report, no throw", () => {
    const r = buildDrillTimingReport([], route, secs, 100);
    expect(r).toMatchObject({ holesMeasured: 0, totalActualSec: 0, totalEstimatedSec: 0, totalRatio: null });
    expect(r.perGroup).toHaveLength(0);
    expect(r.perHole).toHaveLength(0);
  });
});

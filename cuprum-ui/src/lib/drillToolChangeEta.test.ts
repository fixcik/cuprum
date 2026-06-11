import { describe, expect, it } from "vitest";
import { toolChangeEta } from "@/lib/drillToolChangeEta";
import type { DrillRoute, RouteGroup } from "@/lib/drillRoute";

// Minimal route builder: group sizes → groups with that many dummy holes.
function routeOf(sizes: number[]): DrillRoute {
  const groups: RouteGroup[] = sizes.map((n, i) => ({
    diameterMm: i + 1,
    class: "pth",
    toolId: `t${i}`,
    orderedHoles: Array.from({ length: n }, (_, h) => ({ xMm: h, yMm: i })),
  }));
  const total = sizes.reduce((a, b) => a + b, 0);
  return { groups, pathPoints: [], totalHoles: total, toolCount: sizes.length };
}

describe("toolChangeEta", () => {
  // Two groups of 3 holes; group 0 estimated at 30s, group 1 at 60s.
  const route = routeOf([3, 3]);
  const secs = [30, 60];

  it("start of group 0 → full group-0 time and all its holes remain", () => {
    expect(toolChangeEta(route, secs, 0)).toEqual({ etaSec: 30, holesRemaining: 3 });
  });

  it("mid group 0 → scales by undrilled fraction (1 of 3 done → 2/3 of 30s)", () => {
    expect(toolChangeEta(route, secs, 1)).toEqual({ etaSec: 20, holesRemaining: 2 });
  });

  it("last hole of group 0 → one hole / one third of the time left", () => {
    expect(toolChangeEta(route, secs, 2)).toEqual({ etaSec: 10, holesRemaining: 1 });
  });

  it("in the LAST group → null (no tool change ahead)", () => {
    expect(toolChangeEta(route, secs, 3)).toBeNull(); // first hole of group 1
    expect(toolChangeEta(route, secs, 5)).toBeNull(); // last hole of group 1
  });

  it("run complete (holesCompleted == total) → null", () => {
    expect(toolChangeEta(route, secs, 6)).toBeNull();
  });

  it("negative / out-of-range index → null", () => {
    expect(toolChangeEta(route, secs, -1)).toBeNull();
  });

  it("single group → never a tool change ahead", () => {
    expect(toolChangeEta(routeOf([4]), [40], 0)).toBeNull();
  });

  it("skips empty trailing groups — no holes there means no change ahead", () => {
    // group 0 (2 holes) then an empty group: nothing real follows → null.
    expect(toolChangeEta(routeOf([2, 0]), [20, 0], 0)).toBeNull();
  });

  it("looks past an empty group to a later non-empty one", () => {
    // group 0 (2), empty group 1, group 2 (2): a change still lies ahead of group 0.
    const r = routeOf([2, 0, 2]);
    expect(toolChangeEta(r, [20, 0, 40], 0)).toEqual({ etaSec: 20, holesRemaining: 2 });
  });

  it("three groups → reports only up to the NEXT change, not the last", () => {
    const r = routeOf([2, 2, 2]);
    // In group 1 (holesCompleted 2..3): next change is after group 1, uses secs[1].
    expect(toolChangeEta(r, [20, 40, 60], 2)).toEqual({ etaSec: 40, holesRemaining: 2 });
  });
});

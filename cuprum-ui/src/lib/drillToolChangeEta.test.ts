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
  // Convenience: nominal 100% feed override, no feed share (override is a no-op).
  const eta = (r: DrillRoute, motion: number[], hc: number, feed = motion.map(() => 0)) =>
    toolChangeEta(r, motion, feed, hc, 100);

  it("start of group 0 → full group-0 time and all its holes remain", () => {
    expect(eta(route, secs, 0)).toEqual({ etaSec: 30, holesRemaining: 3 });
  });

  it("mid group 0 → scales by undrilled fraction (1 of 3 done → 2/3 of 30s)", () => {
    expect(eta(route, secs, 1)).toEqual({ etaSec: 20, holesRemaining: 2 });
  });

  it("last hole of group 0 → one hole / one third of the time left", () => {
    expect(eta(route, secs, 2)).toEqual({ etaSec: 10, holesRemaining: 1 });
  });

  it("in the LAST group → null (no tool change ahead)", () => {
    expect(eta(route, secs, 3)).toBeNull(); // first hole of group 1
    expect(eta(route, secs, 5)).toBeNull(); // last hole of group 1
  });

  it("run complete (holesCompleted == total) → null", () => {
    expect(eta(route, secs, 6)).toBeNull();
  });

  it("negative / out-of-range index → null", () => {
    expect(eta(route, secs, -1)).toBeNull();
  });

  it("single group → never a tool change ahead", () => {
    expect(eta(routeOf([4]), [40], 0)).toBeNull();
  });

  it("skips empty trailing groups — no holes there means no change ahead", () => {
    expect(eta(routeOf([2, 0]), [20, 0], 0)).toBeNull();
  });

  it("looks past an empty group to a later non-empty one", () => {
    const r = routeOf([2, 0, 2]);
    expect(eta(r, [20, 0, 40], 0)).toEqual({ etaSec: 20, holesRemaining: 2 });
  });

  it("three groups → reports only up to the NEXT change, not the last", () => {
    const r = routeOf([2, 2, 2]);
    expect(eta(r, [20, 40, 60], 2)).toEqual({ etaSec: 40, holesRemaining: 2 });
  });

  describe("feed override", () => {
    // Group 0: 30s total, of which 12s is feed-limited (plunge), 18s rapid.
    it("50% override slows only the feed share (18 + 12/0.5 = 42s, full group)", () => {
      const r = toolChangeEta(route, secs, [12, 0], 0, 50);
      expect(r).toEqual({ etaSec: 42, holesRemaining: 3 });
    });

    it("200% override speeds only the feed share (18 + 12/2 = 24s, full group)", () => {
      const r = toolChangeEta(route, secs, [12, 0], 0, 200);
      expect(r).toEqual({ etaSec: 24, holesRemaining: 3 });
    });

    it("override + partial group compose (50% → 42s, 2/3 left → 28s)", () => {
      const r = toolChangeEta(route, secs, [12, 0], 1, 50);
      expect(r?.etaSec).toBeCloseTo(28);
      expect(r?.holesRemaining).toBe(2);
    });
  });
});

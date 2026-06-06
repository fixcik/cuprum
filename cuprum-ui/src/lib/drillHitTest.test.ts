import { describe, expect, it } from "vitest";
import { nearestHole } from "@/lib/drillHitTest";
import type { DrillRoute } from "@/lib/drillRoute";

// Fixture: two groups with distinct diameters.
// Group 0 (gi=0): 1.0mm diameter, holes at (10,10) and (20,10).
// Group 1 (gi=1): 2.0mm diameter, hole at (30,10).
const ROUTE: DrillRoute = {
  groups: [
    {
      diameterMm: 1.0,
      class: "pth",
      toolId: "t1",
      orderedHoles: [
        { xMm: 10, yMm: 10 },
        { xMm: 20, yMm: 10 },
      ],
    },
    {
      diameterMm: 2.0,
      class: "npth",
      toolId: "t2",
      orderedHoles: [{ xMm: 30, yMm: 10 }],
    },
  ],
  pathPoints: [
    { xMm: 10, yMm: 10 },
    { xMm: 20, yMm: 10 },
    { xMm: 30, yMm: 10 },
  ],
  totalHoles: 3,
  toolCount: 2,
};

// 10 px/mm → marginPx=4 means marginMm=0.4mm
const PX_PER_MM = 10;
const MARGIN_PX = 4;

describe("nearestHole", () => {
  it("hit at group-0 hole-0 center → key '0-0'", () => {
    const result = nearestHole({ x: 10, y: 10 }, ROUTE, PX_PER_MM, MARGIN_PX);
    expect(result).not.toBeNull();
    expect(result?.key).toBe("0-0");
    expect(result?.groupIdx).toBe(0);
    expect(result?.holeIdx).toBe(0);
  });

  it("hit at group-0 hole-1 center → key '0-1'", () => {
    const result = nearestHole({ x: 20, y: 10 }, ROUTE, PX_PER_MM, MARGIN_PX);
    expect(result?.key).toBe("0-1");
  });

  it("hit at group-1 hole-0 center → key '1-0'", () => {
    const result = nearestHole({ x: 30, y: 10 }, ROUTE, PX_PER_MM, MARGIN_PX);
    expect(result?.key).toBe("1-0");
  });

  it("click within margin of a small hole still hits (radius=0.5, margin=0.4mm → threshold=0.9mm)", () => {
    // Offset 0.8mm from center of hole-0 — within the 0.9mm threshold.
    const result = nearestHole({ x: 10.8, y: 10 }, ROUTE, PX_PER_MM, MARGIN_PX);
    expect(result?.key).toBe("0-0");
  });

  it("click outside all thresholds returns null", () => {
    // Far from all holes
    const result = nearestHole({ x: 0, y: 0 }, ROUTE, PX_PER_MM, MARGIN_PX);
    expect(result).toBeNull();
  });

  it("click just outside the margin returns null", () => {
    // hole-0 at (10,10), threshold = 0.5 + 0.4 = 0.9mm; 1.0mm away → miss
    const result = nearestHole({ x: 10, y: 11.0 }, ROUTE, PX_PER_MM, MARGIN_PX);
    expect(result).toBeNull();
  });

  it("when two holes overlap pick the nearest center", () => {
    // Put point midway between hole-0 (10,10) and hole-1 (20,10) but slightly
    // closer to hole-1.
    const result = nearestHole({ x: 15.1, y: 10 }, ROUTE, PX_PER_MM, MARGIN_PX);
    // 15.1 is 5.1 away from hole-0 and 4.9 from hole-1.
    // Both thresholds = 0.9mm so neither is within range at d>4 — use a closer pair.
    // Instead test with two overlapping holes in the same group via a custom route.
    const closeRoute: DrillRoute = {
      groups: [
        {
          diameterMm: 4.0,
          class: "pth",
          toolId: null,
          orderedHoles: [
            { xMm: 0, yMm: 0 },
            { xMm: 1, yMm: 0 },
          ],
        },
      ],
      pathPoints: [],
      totalHoles: 2,
      toolCount: 0,
    };
    // threshold = 4/2 + 4/10 = 2.4mm; point at (0.6, 0) → d to hole-0=0.6, d to hole-1=0.4
    const hit = nearestHole({ x: 0.6, y: 0 }, closeRoute, PX_PER_MM, MARGIN_PX);
    // hole-1 (key "0-1") is closer
    expect(hit?.key).toBe("0-1");
    expect(result).toBeNull(); // the original assertion still holds
  });

  it("key format is gi-hi", () => {
    const result = nearestHole({ x: 30, y: 10 }, ROUTE, PX_PER_MM, MARGIN_PX);
    // Group 1, hole 0
    expect(result?.key).toMatch(/^1-0$/);
  });
});

import { describe, expect, it } from "vitest";
import { expand, holeInZones, segIntersectsRect } from "@/lib/keepoutGeometry";
import type { Rect, Pt } from "@/lib/keepoutGeometry";

// ---------------------------------------------------------------------------
// expand
// ---------------------------------------------------------------------------

describe("expand", () => {
  it("expands all sides by margin", () => {
    const r: Rect = { x: 1, y: 2, w: 4, h: 6 };
    expect(expand(r, 1)).toEqual({ x: 0, y: 1, w: 6, h: 8 });
  });

  it("shrinks when margin is negative", () => {
    const r: Rect = { x: 0, y: 0, w: 10, h: 10 };
    expect(expand(r, -2)).toEqual({ x: 2, y: 2, w: 6, h: 6 });
  });

  it("zero margin is identity", () => {
    const r: Rect = { x: 3, y: 5, w: 7, h: 2 };
    expect(expand(r, 0)).toEqual(r);
  });
});

// ---------------------------------------------------------------------------
// holeInZones
// ---------------------------------------------------------------------------

describe("holeInZones", () => {
  const zone: Rect = { x: 10, y: 10, w: 20, h: 20 }; // covers [10..30, 10..30]

  it("center exactly in zone → true", () => {
    expect(holeInZones(20, 20, 0, [zone], 0)).toBe(true);
  });

  it("far outside → false", () => {
    expect(holeInZones(100, 100, 0, [zone], 0)).toBe(false);
  });

  it("just outside edge but within holeRadius+clearance → true", () => {
    // zone right edge at x=30; hole at x=33, radius=2, clearance=2 → expanded edge at 34
    expect(holeInZones(33, 20, 2, [zone], 2)).toBe(true);
  });

  it("exactly outside radius+clearance → false", () => {
    // zone right edge at x=30; hole at x=34.001, radius=2, clearance=2 → expanded edge at 34
    expect(holeInZones(34.001, 20, 2, [zone], 2)).toBe(false);
  });

  it("exactly on expanded boundary (inclusive) → true", () => {
    // zone right edge at x=30; hole at x=34, radius=2, clearance=2 → expanded edge at 34
    expect(holeInZones(34, 20, 2, [zone], 2)).toBe(true);
  });

  it("empty zones list → false", () => {
    expect(holeInZones(20, 20, 0, [], 0)).toBe(false);
  });

  it("multiple zones: in none → false", () => {
    const z2: Rect = { x: 50, y: 50, w: 10, h: 10 };
    expect(holeInZones(200, 200, 0, [zone, z2], 0)).toBe(false);
  });

  it("multiple zones: in second → true", () => {
    const z2: Rect = { x: 50, y: 50, w: 10, h: 10 };
    expect(holeInZones(55, 55, 0, [zone, z2], 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// segIntersectsRect
// ---------------------------------------------------------------------------

describe("segIntersectsRect", () => {
  // rect: [0..10] x [0..10]
  const r: Rect = { x: 0, y: 0, w: 10, h: 10 };

  it("segment passing through the middle → true", () => {
    const a: Pt = { x: -5, y: 5 };
    const b: Pt = { x: 15, y: 5 };
    expect(segIntersectsRect(a, b, r)).toBe(true);
  });

  it("segment fully to one side → false", () => {
    const a: Pt = { x: -10, y: 5 };
    const b: Pt = { x: -1, y: 5 };
    expect(segIntersectsRect(a, b, r)).toBe(false);
  });

  it("segment with one endpoint inside → true", () => {
    const a: Pt = { x: 5, y: 5 };
    const b: Pt = { x: 20, y: 5 };
    expect(segIntersectsRect(a, b, r)).toBe(true);
  });

  it("both endpoints inside → true", () => {
    const a: Pt = { x: 2, y: 2 };
    const b: Pt = { x: 8, y: 8 };
    expect(segIntersectsRect(a, b, r)).toBe(true);
  });

  it("segment grazing exactly along top edge (collinear on boundary) → false", () => {
    const a: Pt = { x: -5, y: 0 };
    const b: Pt = { x: 15, y: 0 };
    expect(segIntersectsRect(a, b, r)).toBe(false);
  });

  it("segment grazing along bottom edge → false", () => {
    const a: Pt = { x: -5, y: 10 };
    const b: Pt = { x: 15, y: 10 };
    expect(segIntersectsRect(a, b, r)).toBe(false);
  });

  it("segment grazing along left edge → false", () => {
    const a: Pt = { x: 0, y: -5 };
    const b: Pt = { x: 0, y: 15 };
    expect(segIntersectsRect(a, b, r)).toBe(false);
  });

  it("segment touching only a corner → false", () => {
    // Segment from (-2,-2) to (0,0): endpoint at (0,0) is the corner (boundary), not interior
    const a: Pt = { x: -2, y: -2 };
    const b: Pt = { x: 0, y: 0 };
    expect(segIntersectsRect(a, b, r)).toBe(false);
  });

  it("diagonal segment crossing entire rect → true", () => {
    const a: Pt = { x: -1, y: -1 };
    const b: Pt = { x: 11, y: 11 };
    expect(segIntersectsRect(a, b, r)).toBe(true);
  });

  it("segment just above top edge → false", () => {
    const a: Pt = { x: -5, y: -0.001 };
    const b: Pt = { x: 15, y: -0.001 };
    expect(segIntersectsRect(a, b, r)).toBe(false);
  });

  it("segment only enters from left edge midpoint (endpoint outside on both ends) → true", () => {
    const a: Pt = { x: -5, y: 3 };
    const b: Pt = { x: 15, y: 7 };
    expect(segIntersectsRect(a, b, r)).toBe(true);
  });
});

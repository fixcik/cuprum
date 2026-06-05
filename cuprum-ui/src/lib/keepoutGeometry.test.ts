import { describe, expect, it } from "vitest";
import {
  expand,
  holeInZones,
  segIntersectsRect,
  avoidZones,
} from "@/lib/keepoutGeometry";
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

// ---------------------------------------------------------------------------
// avoidZones
// ---------------------------------------------------------------------------

describe("avoidZones", () => {
  // Helper: check the full polyline [a, ...wp, b] has no segment crossing the
  // expanded zone
  function polylineClear(
    a: Pt,
    wp: Pt[],
    b: Pt,
    zone: Rect,
    margin: number
  ): boolean {
    const expanded = expand(zone, margin);
    const pts = [a, ...wp, b];
    for (let i = 0; i < pts.length - 1; i++) {
      if (segIntersectsRect(pts[i], pts[i + 1], expanded)) return false;
    }
    return true;
  }

  it("clear straight line → [] (no waypoints)", () => {
    const zone: Rect = { x: 10, y: 10, w: 5, h: 5 };
    const a: Pt = { x: 0, y: 0 };
    const b: Pt = { x: 5, y: 0 };
    expect(avoidZones(a, b, [zone], 1)).toEqual([]);
  });

  it("horizontal segment through a centred rect → returns waypoints", () => {
    // rect centered around (50,50); segment goes through it horizontally
    const zone: Rect = { x: 40, y: 44, w: 20, h: 12 }; // [40..60] x [44..56]
    const a: Pt = { x: 0, y: 50 };
    const b: Pt = { x: 100, y: 50 };
    const margin = 2;
    const wp = avoidZones(a, b, [zone], margin);
    expect(wp.length).toBeGreaterThan(0);
    // Full polyline must not cross the expanded rect
    expect(polylineClear(a, wp, b, zone, margin)).toBe(true);
  });

  it("endpoints a, b are NOT included in returned array", () => {
    const zone: Rect = { x: 40, y: 44, w: 20, h: 12 };
    const a: Pt = { x: 0, y: 50 };
    const b: Pt = { x: 100, y: 50 };
    const wp = avoidZones(a, b, [zone], 2);
    for (const p of wp) {
      expect(p).not.toEqual(a);
      expect(p).not.toEqual(b);
    }
  });

  it("detour picks the shorter side (rect offset so one side is clearly shorter)", () => {
    // Rect at [40..60] x [45..55]; segment horizontal at y=50 from x=0 to x=100.
    // Top edge at y=45, bottom at y=55. With margin=2 → expanded top at y=43, bottom at y=57.
    // Going above (y=43) travels 7 units off-axis, going below (y=57) travels 7 too.
    // So shift the rect down: zone y=48, h=12 → [40..60] x [48..60].
    // Expanded top=46, bottom=62. Going above top (y=46) deviates 4, below bottom (y=62) deviates 12.
    // Shorter path must go above.
    const zone: Rect = { x: 40, y: 48, w: 20, h: 12 };
    const a: Pt = { x: 0, y: 50 };
    const b: Pt = { x: 100, y: 50 };
    const margin = 2;
    const wp = avoidZones(a, b, [zone], margin);
    // Waypoints should be above the segment (y < 50 since going over the top is shorter)
    const maxY = Math.max(...wp.map((p) => p.y));
    // All waypoints should be at or above the expanded top edge (y=46 for zone y=48, margin=2)
    // i.e., they should have y <= 46 if routing over top, or y >= 62 if routing below.
    // With expanded top=46, those corner waypoints are at y=46.
    expect(maxY).toBeLessThanOrEqual(50); // went over the top, not under
    // Also verify full polyline is clear
    expect(polylineClear(a, wp, b, zone, margin)).toBe(true);
  });

  it("two separate rects on the path → final polyline clears both", () => {
    // Two rects blocking a horizontal path at y=0
    const z1: Rect = { x: 10, y: -5, w: 10, h: 10 }; // [10..20] x [-5..5]
    const z2: Rect = { x: 40, y: -5, w: 10, h: 10 }; // [40..50] x [-5..5]
    const a: Pt = { x: 0, y: 0 };
    const b: Pt = { x: 60, y: 0 };
    const margin = 1;
    const wp = avoidZones(a, b, [z1, z2], margin);
    // Full polyline must clear both expanded rects
    expect(polylineClear(a, wp, b, z1, margin)).toBe(true);
    expect(polylineClear(a, wp, b, z2, margin)).toBe(true);
  });

  it("degenerate a===b → []", () => {
    const zone: Rect = { x: 10, y: 10, w: 5, h: 5 };
    const a: Pt = { x: 5, y: 5 };
    expect(avoidZones(a, a, [zone], 1)).toEqual([]);
  });

  it("empty zones → []", () => {
    const a: Pt = { x: 0, y: 0 };
    const b: Pt = { x: 100, y: 0 };
    expect(avoidZones(a, b, [], 2)).toEqual([]);
  });

  it("vertical segment through a rect → returns waypoints that clear it", () => {
    const zone: Rect = { x: -5, y: 20, w: 10, h: 20 }; // [-5..5] x [20..40]
    const a: Pt = { x: 0, y: 0 };
    const b: Pt = { x: 0, y: 60 };
    const margin = 1;
    const wp = avoidZones(a, b, [zone], margin);
    expect(wp.length).toBeGreaterThan(0);
    expect(polylineClear(a, wp, b, zone, margin)).toBe(true);
  });
});

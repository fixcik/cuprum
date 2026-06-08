import { describe, it, expect, vi } from "vitest";
import { routeAvoiding, pointInRect } from "@/lib/visibilityRoute";
import type { Rect } from "@/lib/keepoutGeometry";
import { segIntersectsRect, expand } from "@/lib/keepoutGeometry";

describe("pointInRect", () => {
  const r: Rect = { x: 0, y: 0, w: 10, h: 10 };
  it("includes interior and boundary", () => {
    expect(pointInRect({ x: 5, y: 5 }, r)).toBe(true);
    expect(pointInRect({ x: 0, y: 5 }, r)).toBe(true);
    expect(pointInRect({ x: 10, y: 10 }, r)).toBe(true);
  });
  it("excludes outside", () => {
    expect(pointInRect({ x: -1, y: 5 }, r)).toBe(false);
    expect(pointInRect({ x: 5, y: 11 }, r)).toBe(false);
  });
});

describe("routeAvoiding (unbounded)", () => {
  const a = { x: 0, y: 5 };
  const b = { x: 20, y: 5 };
  it("returns [] when the straight line is clear", () => {
    const zone: Rect = { x: 8, y: 40, w: 4, h: 4 }; // far from the a→b line
    expect(routeAvoiding(a, b, [zone], 1)).toEqual([]);
  });
  it("returns [] when there are no obstacles", () => {
    expect(routeAvoiding(a, b, [], 1)).toEqual([]);
  });
  it("returns [] for a zero-length segment", () => {
    expect(routeAvoiding(a, a, [{ x: 8, y: 4, w: 4, h: 4 }], 1)).toEqual([]);
  });
  it("detours around a blocking zone without crossing its interior", () => {
    const zone: Rect = { x: 8, y: 0, w: 4, h: 10 }; // straddles the a→b line at y=5
    const wp = routeAvoiding(a, b, [zone], 1);
    expect(wp.length).toBeGreaterThan(0);
    const exp = expand(zone, 1);
    const pts = [a, ...wp, b];
    for (let i = 0; i < pts.length - 1; i++) {
      expect(segIntersectsRect(pts[i], pts[i + 1], exp)).toBe(false);
    }
  });
});

describe("routeAvoiding (panel-bounded)", () => {
  const panel = { minX: 0, minY: 0, maxX: 100, maxY: 50 };
  it("routes a flush-to-left-edge zone from the inside (no waypoint leaves the panel)", () => {
    // Zone hugs the left edge; a above it, b below it on the same x → the straight
    // line crosses the zone and the only in-panel way around is to the right.
    const zone: Rect = { x: 0, y: 10, w: 10, h: 30 };
    const a = { x: 5, y: 5 };
    const b = { x: 5, y: 45 };
    const wp = routeAvoiding(a, b, [zone], 1, panel);
    expect(wp.length).toBeGreaterThan(0);
    for (const p of wp) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(panel.maxX);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(panel.maxY);
    }
    const exp = expand(zone, 1);
    const pts = [a, ...wp, b];
    for (let i = 0; i < pts.length - 1; i++) {
      expect(segIntersectsRect(pts[i], pts[i + 1], exp)).toBe(false);
    }
  });
  it("honours a negative-origin panel rectangle (machine space, flipped datum)", () => {
    // Machine-space panel for a top-left datum: x∈[0,100], y∈[-50,0].
    const neg = { minX: 0, minY: -50, maxX: 100, maxY: 0 };
    const zone: Rect = { x: 0, y: -30, w: 10, h: 20 }; // flush to the left edge
    const a = { x: 5, y: -5 };
    const b = { x: 5, y: -45 };
    const wp = routeAvoiding(a, b, [zone], 1, neg);
    expect(wp.length).toBeGreaterThan(0);
    for (const p of wp) {
      expect(p.x).toBeGreaterThanOrEqual(neg.minX);
      expect(p.x).toBeLessThanOrEqual(neg.maxX);
      expect(p.y).toBeGreaterThanOrEqual(neg.minY);
      expect(p.y).toBeLessThanOrEqual(neg.maxY);
    }
  });
  it("clips a near-edge expanded corner to the panel instead of going outside", () => {
    const zone: Rect = { x: 0.5, y: 10, w: 8, h: 8 };
    const a = { x: 40, y: 5 };
    const b = { x: 40, y: 45 };
    const wp = routeAvoiding(a, b, [zone], 1, panel);
    for (const p of wp) expect(p.x).toBeGreaterThanOrEqual(0);
  });
});

describe("routeAvoiding (edge cases)", () => {
  const panel = { minX: 0, minY: 0, maxX: 100, maxY: 50 };
  it("still routes when an endpoint sits inside a zone's margin band", () => {
    const zone: Rect = { x: 20, y: 20, w: 10, h: 10 };
    const a = { x: 5, y: 25 };
    const b = { x: 30.5, y: 25 }; // within the +1mm expanded band, outside the zone
    const wp = routeAvoiding(a, b, [zone], 1, panel);
    expect(Array.isArray(wp)).toBe(true);
  });
  it("warns and returns [] when a zone splits the panel between a and b", () => {
    const zone: Rect = { x: 45, y: 0, w: 10, h: 50 };
    const a = { x: 10, y: 25 };
    const b = { x: 90, y: 25 };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wp = routeAvoiding(a, b, [zone], 1, panel);
    expect(wp).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

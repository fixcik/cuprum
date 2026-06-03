import { describe, it, expect } from "vitest";
import { packLayout, instanceBounds, isOffPanel } from "@/lib/panelPlacement";
import { DEFAULT_NEST } from "@/lib/nest";
import type { NestSettings } from "@/lib/nest";

const nest = (o: Partial<NestSettings> = {}): NestSettings => ({ ...DEFAULT_NEST, ...o });

describe("packLayout", () => {
  it("places a single corner copy snug to the corner when nesting is disabled", () => {
    // Nesting off = "one copy snug in the corner": the edge margin / gap are
    // auto-nest params and do NOT apply, so the copy sits flush at the corner
    // (0, …). 40×30 board on a 100×100 panel, bl corner.
    const r = packLayout(40, 30, 100, 100, nest({ enabled: false }));
    expect(r.n).toBe(1);
    expect(r.placements).toEqual([{ x: 0, y: 70 }]);
    expect([r.bw, r.bh]).toEqual([40, 30]);
  });

  it("places the snug single copy whenever it fits the raw panel, even if the margin would not", () => {
    // Regression: with nesting off, a 228×98 board fits a 240×200 panel, but a
    // 10mm edge margin (228 + 2·10 = 248 > 240) used to report zero capacity and
    // reject it ("design larger than panel work area"). The edge margin must not
    // gate the snug single copy.
    const r = packLayout(228, 98, 240, 200, nest({ enabled: false, marginMm: 10 }));
    expect(r.max).toBeGreaterThanOrEqual(1);
    expect(r.n).toBe(1);
    expect(r.placements).toEqual([{ x: 0, y: 102 }]);
  });

  it("fills a row-major grid from the top-left for an explicit copy count", () => {
    const r = packLayout(40, 30, 100, 100, nest({ enabled: true, fillMode: "copies", copies: 3, corner: "tl" }));
    expect(r.n).toBe(3);
    expect(r.placements).toEqual([
      { x: 5, y: 5 },
      { x: 47, y: 5 },
      { x: 5, y: 37 },
    ]);
  });

  it("clamps the placed count to capacity and flags the overflow via requested", () => {
    const r = packLayout(40, 30, 100, 100, nest({ enabled: true, fillMode: "copies", copies: 10 }));
    expect(r.max).toBe(4);
    expect(r.requested).toBe(10);
    expect(r.n).toBe(4);
  });

  it("applies a 90° rotation to the effective footprint when rotate is on", () => {
    const r = packLayout(30, 40, 100, 100, nest({ enabled: true, rotate: true }));
    expect([r.bw, r.bh]).toEqual([40, 30]);
  });

  it("derives the requested count from a fill percentage", () => {
    const r = packLayout(40, 30, 100, 100, nest({ enabled: true, fillMode: "fill", fillPct: 50 }));
    expect(r.max).toBe(4);
    expect(r.n).toBe(2); // floor(4 * 50 / 100)
  });

  it("places nothing when the board is larger than the panel", () => {
    const r = packLayout(200, 200, 100, 100, nest({ enabled: false }));
    expect(r.cols).toBe(0);
    expect(r.rows).toBe(0);
    expect(r.max).toBe(0);
    expect(r.n).toBe(0);
    expect(r.placements).toEqual([]);
  });
});

describe("instanceBounds", () => {
  // (x,y) = top-left of the UNROTATED board; rotation is about the board centre.
  it("returns the board rectangle at 0°", () => {
    expect(instanceBounds({ xMm: 10, yMm: 20, boardW: 40, boardH: 30, rotationDeg: 0 })).toEqual({
      minX: 10, minY: 20, maxX: 50, maxY: 50,
    });
  });

  it("rotates a 90° instance about its centre (swapped footprint, same centre)", () => {
    // centre = (10+20, 20+15) = (30,35); 90° → 30 wide × 40 tall about centre.
    const b = instanceBounds({ xMm: 10, yMm: 20, boardW: 40, boardH: 30, rotationDeg: 90 });
    expect(b.minX).toBeCloseTo(15, 6);
    expect(b.maxX).toBeCloseTo(45, 6);
    expect(b.minY).toBeCloseTo(15, 6);
    expect(b.maxY).toBeCloseTo(55, 6);
  });

  it("handles an arbitrary angle (45°) as a true rotated-quad AABB", () => {
    // square 40×40 centred at (30,30); 45° → half-diagonal = 40*√2/2 ≈ 28.284.
    const b = instanceBounds({ xMm: 10, yMm: 10, boardW: 40, boardH: 40, rotationDeg: 45 });
    expect(b.minX).toBeCloseTo(30 - 28.2842712, 4);
    expect(b.maxX).toBeCloseTo(30 + 28.2842712, 4);
    expect(b.minY).toBeCloseTo(30 - 28.2842712, 4);
    expect(b.maxY).toBeCloseTo(30 + 28.2842712, 4);
  });
});

describe("isOffPanel", () => {
  const base = { boardW: 40, boardH: 30, rotationDeg: 0, panelW: 100, panelH: 100 };

  it("is false for a board fully inside the panel", () => {
    expect(isOffPanel({ ...base, xMm: 5, yMm: 5 })).toBe(false);
  });

  it("is true when the board pokes past the right edge", () => {
    expect(isOffPanel({ ...base, xMm: 80, yMm: 5 })).toBe(true);
  });

  it("is false for a board flush with the far edge (within tolerance)", () => {
    expect(isOffPanel({ ...base, xMm: 60, yMm: 70 })).toBe(false);
  });

  it("absorbs sub-tolerance negative overhang but flags a real one", () => {
    expect(isOffPanel({ ...base, xMm: -0.0005, yMm: 5 })).toBe(false);
    expect(isOffPanel({ ...base, xMm: -5, yMm: 5 })).toBe(true);
  });

  // Regression: a 90°-rotated instance placed inside the panel by the nester (its
  // footprint swapped to 30×40) must NOT be flagged. The old origin-rotation model
  // computed minX = x − boardH < 0 and falsely reported it off-panel.
  it("does not flag a rotated instance that sits inside the panel", () => {
    expect(isOffPanel({ ...base, xMm: 5, yMm: 5, rotationDeg: 90 })).toBe(false);
  });

  it("still flags a rotated instance whose swapped footprint pokes past an edge", () => {
    // 40×30 board rotated → 30×40 footprint; at y=70 it reaches 110 > 100.
    expect(isOffPanel({ ...base, xMm: 5, yMm: 70, rotationDeg: 90 })).toBe(true);
  });
});

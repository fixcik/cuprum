import { describe, it, expect } from "vitest";
import { packLayout, instanceBounds, isOffPanel } from "@/lib/panelPlacement";
import { DEFAULT_NEST } from "@/lib/nest";
import type { NestSettings } from "@/lib/nest";

const nest = (o: Partial<NestSettings> = {}): NestSettings => ({ ...DEFAULT_NEST, ...o });

describe("packLayout", () => {
  it("places a single corner copy when nesting is disabled", () => {
    // 40×30 board, 100×100 panel, margin 5 / gap 2 -> 2×2 capacity, bl corner.
    const r = packLayout(40, 30, 100, 100, nest({ enabled: false }));
    expect(r.cols).toBe(2);
    expect(r.rows).toBe(2);
    expect(r.max).toBe(4);
    expect(r.n).toBe(1);
    expect(r.placements).toEqual([{ x: 5, y: 65 }]);
    expect([r.bw, r.bh]).toEqual([40, 30]);
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
  it("returns the board rectangle unrotated", () => {
    expect(instanceBounds({ xMm: 10, yMm: 20, boardW: 40, boardH: 30, rotationDeg: 0 })).toEqual({
      minX: 10,
      minY: 20,
      maxX: 50,
      maxY: 50,
    });
  });

  // A 90°/270° instance occupies a w↔h-swapped axis-aligned footprint anchored at
  // (x, y) — exactly how packLayout places it and PanelBlankCanvas draws it (no
  // rotation about the origin). So a 40×30 board rotated 90° spans 30×40 from (x,y).
  it("swaps width/height for a 90° instance, anchored at the origin", () => {
    expect(instanceBounds({ xMm: 10, yMm: 20, boardW: 40, boardH: 30, rotationDeg: 90 })).toEqual({
      minX: 10,
      minY: 20,
      maxX: 40,
      maxY: 60,
    });
  });

  it("swaps width/height for a 270° instance too", () => {
    expect(instanceBounds({ xMm: 0, yMm: 0, boardW: 40, boardH: 30, rotationDeg: 270 })).toEqual({
      minX: 0,
      minY: 0,
      maxX: 30,
      maxY: 40,
    });
  });

  it("keeps the footprint for a 180° instance", () => {
    expect(instanceBounds({ xMm: 10, yMm: 20, boardW: 40, boardH: 30, rotationDeg: 180 })).toEqual({
      minX: 10,
      minY: 20,
      maxX: 50,
      maxY: 50,
    });
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

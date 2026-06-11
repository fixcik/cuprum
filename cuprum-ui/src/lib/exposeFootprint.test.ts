import { describe, it, expect } from "vitest";
import { footprintBoxMm } from "@/lib/exposeFootprint";

describe("footprintBoxMm", () => {
  it("returns top-left + size unchanged for an unrotated board", () => {
    const b = footprintBoxMm({ x_mm: 10, y_mm: 5, rotation_deg: 0 }, { w: 30, h: 20 });
    expect(b).toEqual({ xMm: 10, yMm: 5, wMm: 30, hMm: 20 });
  });

  it("treats 180° like 0° (no swap, no shift)", () => {
    const b = footprintBoxMm({ x_mm: 10, y_mm: 5, rotation_deg: 180 }, { w: 30, h: 20 });
    expect(b).toEqual({ xMm: 10, yMm: 5, wMm: 30, hMm: 20 });
  });

  it("swaps extents AND shifts top-left around the centre for 90°", () => {
    // board 30x20 at (10,5): centre = (25,15). Rotated bbox is 20x30,
    // top-left = (25-10, 15-15) = (15, 0).
    const b = footprintBoxMm({ x_mm: 10, y_mm: 5, rotation_deg: 90 }, { w: 30, h: 20 });
    expect(b).toEqual({ xMm: 15, yMm: 0, wMm: 20, hMm: 30 });
  });

  it("handles 270° the same as 90° (centre-pivot)", () => {
    const b = footprintBoxMm({ x_mm: 10, y_mm: 5, rotation_deg: 270 }, { w: 30, h: 20 });
    expect(b).toEqual({ xMm: 15, yMm: 0, wMm: 20, hMm: 30 });
  });

  it("keeps the centre fixed under rotation (square board is unchanged)", () => {
    const flat = footprintBoxMm({ x_mm: 4, y_mm: 4, rotation_deg: 0 }, { w: 10, h: 10 });
    const rot = footprintBoxMm({ x_mm: 4, y_mm: 4, rotation_deg: 90 }, { w: 10, h: 10 });
    expect(rot).toEqual(flat);
  });

  it("falls back to a square when the design size is unknown", () => {
    const b = footprintBoxMm({ x_mm: 0, y_mm: 0, rotation_deg: 0 }, undefined, 20);
    expect(b).toEqual({ xMm: 0, yMm: 0, wMm: 20, hMm: 20 });
  });
});

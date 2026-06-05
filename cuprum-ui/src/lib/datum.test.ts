import { describe, expect, it } from "vitest";
import { machinePoint, datumCornerPanelPoint } from "@/lib/datum";

const W = 100;
const H = 50;

describe("machinePoint", () => {
  // Interior test point
  const px = 30;
  const py = 20;

  it("bottom-left: (x, H-y) — all non-negative inside the panel", () => {
    expect(machinePoint(px, py, "bottom-left", W, H)).toEqual([30, 30]);
    expect(machinePoint(0, H, "bottom-left", W, H)).toEqual([0, 0]);   // corner itself → origin
    expect(machinePoint(W, 0, "bottom-left", W, H)).toEqual([W, H]);
  });

  it("top-left: (x, -y) — Y ≤ 0 inside the panel", () => {
    expect(machinePoint(px, py, "top-left", W, H)).toEqual([30, -20]);
    expect(machinePoint(0, 0, "top-left", W, H)).toEqual([0, 0]);      // corner itself → origin
  });

  it("bottom-right: (x-W, H-y) — X ≤ 0 inside the panel", () => {
    expect(machinePoint(px, py, "bottom-right", W, H)).toEqual([-70, 30]);
    expect(machinePoint(W, H, "bottom-right", W, H)).toEqual([0, 0]);  // corner itself → origin
  });

  it("top-right: (x-W, -y) — X ≤ 0 and Y ≤ 0 inside the panel", () => {
    expect(machinePoint(px, py, "top-right", W, H)).toEqual([-70, -20]);
    expect(machinePoint(W, 0, "top-right", W, H)).toEqual([0, 0]);     // corner itself → origin
  });

  it("no mirroring: relative left/right ordering of two points is preserved across all datums", () => {
    // holeLeft is at panel x=10, holeRight at panel x=80
    // For any datum, machineX(left) < machineX(right) because machineX = x - const.
    const datums = ["bottom-left", "bottom-right", "top-left", "top-right"] as const;
    for (const d of datums) {
      const [mxLeft] = machinePoint(10, 25, d, W, H);
      const [mxRight] = machinePoint(80, 25, d, W, H);
      expect(mxLeft).toBeLessThan(mxRight);
    }
  });

  it("no mirroring: relative top/bottom ordering of two points is preserved across all datums", () => {
    // panelTop at y=5, panelBottom at y=45
    // machineY always = C - y (C is H or 0), so a smaller panel-y → larger machineY.
    const datums = ["bottom-left", "bottom-right", "top-left", "top-right"] as const;
    for (const d of datums) {
      const [, myTop] = machinePoint(50, 5, d, W, H);
      const [, myBottom] = machinePoint(50, 45, d, W, H);
      expect(myTop).toBeGreaterThan(myBottom);
    }
  });
});

describe("datumCornerPanelPoint", () => {
  it("bottom-left → (0, H)", () => {
    expect(datumCornerPanelPoint("bottom-left", W, H)).toEqual({ xMm: 0, yMm: H });
  });

  it("top-left → (0, 0)", () => {
    expect(datumCornerPanelPoint("top-left", W, H)).toEqual({ xMm: 0, yMm: 0 });
  });

  it("bottom-right → (W, H)", () => {
    expect(datumCornerPanelPoint("bottom-right", W, H)).toEqual({ xMm: W, yMm: H });
  });

  it("top-right → (W, 0)", () => {
    expect(datumCornerPanelPoint("top-right", W, H)).toEqual({ xMm: W, yMm: 0 });
  });
});

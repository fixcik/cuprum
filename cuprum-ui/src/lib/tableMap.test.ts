import { describe, expect, it } from "vitest";
import type { PanelDrillPlan } from "@/lib/panelDrill";
import { envelopeFit, holeTablePoints, panelOnTable } from "@/lib/tableMap";

const W = 160;
const H = 120;

describe("panelOnTable", () => {
  it("bottom-left datum at machine origin → board extends +X +Y from origin", () => {
    const r = panelOnTable({ x: 0, y: 0 }, "bottom-left", W, H);
    expect(r).toEqual({ x0: 0, y0: 0, x1: W, y1: H });
  });

  it("bottom-left datum translates by the datum machine position", () => {
    const r = panelOnTable({ x: 20, y: 30 }, "bottom-left", W, H);
    expect(r).toEqual({ x0: 20, y0: 30, x1: 20 + W, y1: 30 + H });
  });

  it("top-right datum at far corner → board extends −X −Y from the datum", () => {
    const r = panelOnTable({ x: 300, y: 178 }, "top-right", W, H);
    expect(r).toEqual({ x0: 300 - W, y0: 178 - H, x1: 300, y1: 178 });
  });

  it("the datum corner always coincides with the datum machine point", () => {
    // For every corner, one board corner must land exactly on the datum machine XY.
    const D = { x: 50, y: 70 };
    for (const datum of ["bottom-left", "bottom-right", "top-left", "top-right"] as const) {
      const r = panelOnTable(D, datum, W, H);
      const corners = [
        [r.x0, r.y0],
        [r.x1, r.y0],
        [r.x0, r.y1],
        [r.x1, r.y1],
      ];
      expect(corners.some(([x, y]) => x === D.x && y === D.y)).toBe(true);
    }
  });
});

describe("envelopeFit", () => {
  it("reports ok when the board sits inside the travel", () => {
    const r = panelOnTable({ x: 20, y: 30 }, "bottom-left", W, H);
    expect(envelopeFit(r, 300, 178)).toEqual({ ok: true, ox: 0, oy: 0 });
  });

  it("reports the X overshoot past the max-travel end", () => {
    const r = panelOnTable({ x: 200, y: 30 }, "bottom-left", W, H); // x1 = 360 > 300
    const fit = envelopeFit(r, 300, 178);
    expect(fit.ok).toBe(false);
    expect(fit.ox).toBeCloseTo(60, 6);
    expect(fit.oy).toBe(0);
  });

  it("reports the overshoot past the 0 end (negative side)", () => {
    const r = panelOnTable({ x: 100, y: 178 }, "top-right", W, H); // x0 = -60
    const fit = envelopeFit(r, 300, 178);
    expect(fit.ok).toBe(false);
    expect(fit.ox).toBeCloseTo(60, 6);
    expect(fit.oy).toBe(0);
  });

  it("flags both axes when the board overruns in X and Y", () => {
    const r = panelOnTable({ x: 200, y: 100 }, "bottom-left", W, H); // x1=360, y1=220
    const fit = envelopeFit(r, 300, 178);
    expect(fit.ok).toBe(false);
    expect(fit.ox).toBeCloseTo(60, 6);
    expect(fit.oy).toBeCloseTo(42, 6);
  });
});

describe("holeTablePoints", () => {
  const plan: PanelDrillPlan = {
    totalHoles: 1,
    toolCount: 1,
    unmatchedDiametersMm: [],
    groups: [
      {
        diameterMm: 0.6,
        toolId: "t1",
        class: "pth",
        holes: [{ xMm: 10, yMm: 20 }],
      },
    ],
  } as unknown as PanelDrillPlan;

  it("projects a hole into machine coords matching the board placement", () => {
    // bottom-left datum at origin: panel (10,20) → work (10, H−20) → machine same.
    const pts = holeTablePoints(plan, { x: 0, y: 0 }, "bottom-left", W, H);
    expect(pts).toHaveLength(1);
    expect(pts[0]).toMatchObject({ x: 10, y: H - 20, class: "pth" });
  });

  it("translates hole dots by the datum machine position", () => {
    const pts = holeTablePoints(plan, { x: 25, y: 5 }, "bottom-left", W, H);
    expect(pts[0]).toMatchObject({ x: 25 + 10, y: 5 + (H - 20) });
  });
});

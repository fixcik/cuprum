import { describe, it, expect } from "vitest";
import {
  packLayout,
  instanceBounds,
  isOffPanel,
  clampDeltaToPanel,
  marqueeHits,
  snapAngle,
  boxesForInstances,
  alignInstances,
  distributeInstances,
  type AlignEdge,
} from "@/lib/panelPlacement";
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

describe("clampDeltaToPanel", () => {
  // One 40×30 board at (5,5) on a 100×100 panel; AABB = [5,45]×[5,35].
  const boxes = [{ minX: 5, minY: 5, maxX: 45, maxY: 35 }];
  it("passes a delta that keeps everything inside", () => {
    expect(clampDeltaToPanel(boxes, 10, 10, 100, 100)).toEqual({ dx: 10, dy: 10 });
  });
  it("clamps a delta that would cross the right/bottom edge", () => {
    expect(clampDeltaToPanel(boxes, 100, 100, 100, 100)).toEqual({ dx: 55, dy: 65 });
  });
  it("clamps a delta that would cross the left/top edge", () => {
    expect(clampDeltaToPanel(boxes, -20, -20, 100, 100)).toEqual({ dx: -5, dy: -5 });
  });
});

describe("marqueeHits", () => {
  const items = [
    { id: "a", box: { minX: 0, minY: 0, maxX: 10, maxY: 10 } },
    { id: "b", box: { minX: 50, minY: 50, maxX: 60, maxY: 60 } },
  ];
  it("returns ids whose AABB intersects the rect", () => {
    expect(marqueeHits(items, { minX: 5, minY: 5, maxX: 55, maxY: 55 }).sort()).toEqual(["a", "b"]);
    expect(marqueeHits(items, { minX: 20, minY: 20, maxX: 30, maxY: 30 })).toEqual([]);
  });
});

describe("boxesForInstances", () => {
  const sizes = { d1: { w: 10, h: 20 } };
  it("builds rotated AABB for known sizes, skips unknown", () => {
    const boxes = boxesForInstances(
      [
        { design_id: "d1", x_mm: 5, y_mm: 5, rotation_deg: 0 },
        { design_id: "missing", x_mm: 0, y_mm: 0, rotation_deg: 0 },
      ],
      sizes,
    );
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ minX: 5, minY: 5, maxX: 15, maxY: 25 });
  });
  it("90° rotation swaps the AABB footprint", () => {
    const [b] = boxesForInstances(
      [{ design_id: "d1", x_mm: 0, y_mm: 0, rotation_deg: 90 }],
      sizes,
    );
    // centre (5,10); rotated extents become 20×10 about that centre
    expect(b.maxX - b.minX).toBeCloseTo(20);
    expect(b.maxY - b.minY).toBeCloseTo(10);
  });
});

describe("snapAngle", () => {
  it("snaps to 15° by default", () => {
    expect(snapAngle(7, false)).toBe(0);
    expect(snapAngle(8, false)).toBe(15);
    expect(snapAngle(200, false)).toBe(195);
  });
  it("snaps to 1° when fine", () => {
    expect(snapAngle(37.4, true)).toBe(37);
    expect(snapAngle(37.6, true)).toBe(38);
  });
  it("normalises into [0,360)", () => {
    expect(snapAngle(-15, false)).toBe(345);
    expect(snapAngle(375, false)).toBe(15);
  });
});

// Helper for align/distribute tests: creates an axis-aligned item (no rotation).
const mk = (id: string, x: number, y: number, w: number, h: number) => ({
  id, x_mm: x, y_mm: y,
  box: { minX: x, minY: y, maxX: x + w, maxY: y + h },
});

// Suppress unused-type lint warning: AlignEdge is imported for typing clarity.
void (undefined as unknown as AlignEdge);

describe("alignInstances", () => {
  it("align left: every box's minX meets the selection's minX (x_mm shifts by delta)", () => {
    const items = [mk("a", 10, 0, 20, 10), mk("b", 40, 0, 10, 10)];
    const out = alignInstances(items, "left");
    expect(out.find((o) => o.id === "a")!.x_mm).toBe(10);
    expect(out.find((o) => o.id === "b")!.x_mm).toBe(10); // 40 + (10 - 40)
  });
  it("align right: boxes' maxX meet selection maxX", () => {
    const items = [mk("a", 10, 0, 20, 10), mk("b", 40, 0, 10, 10)];
    const out = alignInstances(items, "right");
    // selection maxX = max(30,50)=50; a: x=50-20=30; b: x=50-10=40
    expect(out.find((o) => o.id === "a")!.x_mm).toBe(30);
    expect(out.find((o) => o.id === "b")!.x_mm).toBe(40);
  });
  it("align hcenter: box centres meet selection centre", () => {
    const items = [mk("a", 0, 0, 20, 10), mk("b", 100, 0, 10, 10)];
    const out = alignInstances(items, "hcenter");
    // sel centre x = (0+110)/2 = 55; a centre→55: x=55-10=45; b: x=55-5=50
    expect(out.find((o) => o.id === "a")!.x_mm).toBe(45);
    expect(out.find((o) => o.id === "b")!.x_mm).toBe(50);
  });
  it("offset between box and x_mm (rotated) is preserved", () => {
    // box.minX is 5 to the right of x_mm (as if rotated): delta applies to x_mm.
    const it = { id: "r", x_mm: 0, y_mm: 0, box: { minX: 5, minY: 0, maxX: 25, maxY: 10 } };
    const other = mk("o", 100, 0, 10, 10);
    const out = alignInstances([it, other], "left");
    // selection minX = 5; r already there → x_mm unchanged 0; o: minX100→5 ⇒ x=100+(5-100)=5
    expect(out.find((o) => o.id === "r")!.x_mm).toBe(0);
    expect(out.find((o) => o.id === "o")!.x_mm).toBe(5);
  });
  it("returns input unchanged for < 2 items", () => {
    const items = [mk("a", 10, 0, 20, 10)];
    expect(alignInstances(items, "left")).toEqual(items.map(({ id, x_mm, y_mm }) => ({ id, x_mm, y_mm })));
  });
});

describe("distributeInstances", () => {
  it("evenly spaces centres along H (needs ≥3)", () => {
    const items = [mk("a", 0, 0, 10, 10), mk("c", 100, 0, 10, 10), mk("b", 30, 0, 10, 10)];
    const out = distributeInstances(items, "h");
    // centres sorted: a=5, b=35, c=105; ends fixed; middle centre → (5+105)/2=55 ⇒ b.x=55-5=50
    expect(out.find((o) => o.id === "a")!.x_mm).toBe(0);
    expect(out.find((o) => o.id === "c")!.x_mm).toBe(100);
    expect(out.find((o) => o.id === "b")!.x_mm).toBe(50);
  });
  it("returns input unchanged for < 3 items", () => {
    const items = [mk("a", 0, 0, 10, 10), mk("b", 30, 0, 10, 10)];
    expect(distributeInstances(items, "h").map((o) => o.x_mm)).toEqual([0, 30]);
  });
});

import { describe, it, expect } from "vitest";
import {
  packLayout,
  packLayoutAvoiding,
  instanceBounds,
  isOffPanel,
  clampDeltaToPanel,
  marqueeHits,
  snapAngle,
  boxesForInstances,
  alignInstances,
  distributeInstances,
  computeSmartGuides,
  renestSelection,
  type AlignEdge,
  type GuideLine,
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

const box = (minX: number, minY: number, maxX: number, maxY: number) => ({ minX, minY, maxX, maxY });

// Suppress unused-type lint warning: GuideLine is imported for typing clarity.
void (undefined as unknown as GuideLine);

describe("computeSmartGuides", () => {
  const panel = box(0, 0, 100, 100);
  it("snaps moving left edge to a target left edge within threshold", () => {
    const moving = box(11, 50, 31, 60); // left=11
    const target = box(10, 0, 20, 10);  // left=10
    const r = computeSmartGuides({ movingBox: moving, targets: [target, panel], thresholdMm: 2 });
    expect(r.dx).toBeCloseTo(-1); // 11 → 10
    expect(r.dy).toBe(0);
    expect(r.guides.some((g) => g.axis === "x" && Math.abs(g.pos - 10) < 1e-6)).toBe(true);
  });
  it("snaps centre-to-centre", () => {
    const moving = box(40, 40, 60, 60); // cx=50
    const target = box(0, 0, 104, 10);  // cx=52
    const r = computeSmartGuides({ movingBox: moving, targets: [target], thresholdMm: 3 });
    expect(r.dx).toBeCloseTo(2); // 50 → 52
  });
  it("no snap beyond threshold → zero delta, no guides", () => {
    const moving = box(40, 40, 60, 60);
    const target = box(0, 0, 6, 6);
    const r = computeSmartGuides({ movingBox: moving, targets: [target], thresholdMm: 1 });
    expect(r.dx).toBe(0);
    expect(r.dy).toBe(0);
    expect(r.guides).toHaveLength(0);
  });
  it("snaps to panel right edge (panel box as target)", () => {
    const moving = box(78, 10, 99, 30); // right=99
    const r = computeSmartGuides({ movingBox: moving, targets: [panel], thresholdMm: 2 });
    expect(r.dx).toBeCloseTo(1); // right 99 → 100
    expect(r.guides.some((g) => g.axis === "x" && Math.abs(g.pos - 100) < 1e-6)).toBe(true);
  });
  it("snaps both axes independently", () => {
    const moving = box(11, 21, 31, 41); // left=11, top=21
    const target = box(10, 20, 20, 30); // left=10, top=20
    const r = computeSmartGuides({ movingBox: moving, targets: [target], thresholdMm: 2 });
    expect(r.dx).toBeCloseTo(-1);
    expect(r.dy).toBeCloseTo(-1);
    expect(r.guides.filter((g) => g.axis === "x")).toHaveLength(1);
    expect(r.guides.filter((g) => g.axis === "y")).toHaveLength(1);
  });
  it("picks the nearest of several candidates on an axis", () => {
    const moving = box(12, 50, 32, 60); // left=12
    const near = box(10, 0, 30, 10);    // left=10 (Δ2), right=30 → moving.left? no; centre=20
    const r = computeSmartGuides({ movingBox: moving, targets: [near], thresholdMm: 5 });
    // candidates for moving.left=12: near.left=10 (Δ-2); moving.right=32: near.right=30 (Δ-2);
    // moving.centre=22: near.centre=20 (Δ-2). All −2 ⇒ dx=−2.
    expect(r.dx).toBeCloseTo(-2);
  });
});

describe("packLayoutAvoiding", () => {
  const n = (o: Partial<NestSettings> = {}): NestSettings => ({ ...DEFAULT_NEST, ...o });

  it("matches packLayout when there are no obstacles", () => {
    const a = packLayout(40, 30, 100, 100, n({ enabled: true, fillMode: "copies", copies: 3, corner: "tl" }));
    const b = packLayoutAvoiding(40, 30, 100, 100, n({ enabled: true, fillMode: "copies", copies: 3, corner: "tl" }), [], 0);
    expect(b.placements).toEqual(a.placements);
    expect([b.n, b.requested, b.max]).toEqual([a.n, a.requested, a.max]);
  });

  it("skips a cell occupied by an existing instance", () => {
    // tl grid of 40×30 on 100×100: cells at (0,0),(42? no gap) ... use no-gap nesting.
    // With gap=0,margin=0: cols=floor(100/40)=2, rows=floor(100/30)=3 → cell at (0,0),(40,0),(0,30)...
    const nest = n({ enabled: true, marginMm: 0, gapMm: 0, fillMode: "copies", copies: 2, corner: "tl" });
    // Obstacle covering the first cell [0,40]×[0,30].
    const obst = [{ minX: 0, minY: 0, maxX: 40, maxY: 30 }];
    const r = packLayoutAvoiding(40, 30, 100, 100, nest, obst, 0);
    expect(r.n).toBe(2);
    // First free cells skip (0,0): expect (40,0) then (0,30) [row-major].
    expect(r.placements).toEqual([{ x: 40, y: 0 }, { x: 0, y: 30 }]);
  });

  it("keeps the clearance gap from an existing instance", () => {
    // Single snug copy (nesting off) 40×30 on 100×100, tl corner → would sit at (0,0).
    // Obstacle at the bottom-right far away; clearance shouldn't matter → still (0,0).
    const nest = n({ enabled: false, corner: "tl" });
    const r = packLayoutAvoiding(40, 30, 100, 100, nest, [{ minX: 60, minY: 60, maxX: 90, maxY: 90 }], 5);
    expect(r.placements).toEqual([{ x: 0, y: 0 }]);
  });

  it("treats a cell within the clearance of an obstacle as occupied", () => {
    // nesting off, tl, margin=0, gap=0. Obstacle [41,0]-[80,30]; clearance=5 →
    // inflated obstacle [36,-5]-[85,35]. Greedy lattice (step=1) places the board
    // flush against the clearance boundary: first y where [0,40]×[y,y+30] clears
    // the inflated obstacle's maxY=35 is y=35 (strict overlap test: 35 < 35 is false).
    // Old grid logic placed at (0,60) because it only tested board-pitch-aligned cells.
    const nestOpts = n({ enabled: false, marginMm: 0, gapMm: 0, corner: "tl" });
    const r = packLayoutAvoiding(40, 30, 100, 100, nestOpts, [{ minX: 41, minY: 0, maxX: 80, maxY: 30 }], 5);
    // Greedy packs tight to the clearance boundary, not to a board-pitch grid cell.
    expect(r.placements).toEqual([{ x: 0, y: 35 }]);
  });

  it("flags overflow via requested when free cells run out", () => {
    const nest = n({ enabled: true, marginMm: 0, gapMm: 0, fillMode: "copies", copies: 6, corner: "tl" });
    // Occupy the entire left column-ish: block first row fully (3 cells across? cols=2,rows=3 → 6 cells).
    // Obstacle covering left half [0,40]×[0,100] removes column 0 (3 cells) → 3 free remain.
    const r = packLayoutAvoiding(40, 30, 100, 100, nest, [{ minX: 0, minY: 0, maxX: 40, maxY: 100 }], 0);
    expect(r.max).toBe(6);
    expect(r.requested).toBe(6);
    expect(r.n).toBe(3);
  });

  it("placed count is non-increasing as the board gap grows (with obstacles)", () => {
    // 18 obstacles (27.1×40 in a 6×3 grid), gerber 11.4×7 on 200×150, edge 4, fill 15%.
    const obst: ReturnType<typeof box>[] = [];
    const mw = 27.1, mh = 40, mg = 2, mm = 5;
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 6; c++)
        obst.push({ minX: mm + c * (mw + mg), minY: mm + r * (mh + mg), maxX: mm + c * (mw + mg) + mw, maxY: mm + r * (mh + mg) + mh });
    let prev = Infinity;
    for (const gap of [1, 1.5, 2, 2.5, 3]) {
      const r = packLayoutAvoiding(11.4, 7, 200, 150, n({ enabled: true, marginMm: 4, gapMm: gap, fillMode: "fill", fillPct: 15, corner: "tl" }), obst, gap);
      expect(r.n).toBeLessThanOrEqual(prev); // bigger gap never fits MORE
      prev = r.n;
    }
  });

  it("anchors the greedy fill flush to the corner even when step doesn't divide the range", () => {
    // board 10×10 on 100×95, no margin/gap, snap 3 (step 3 ∤ yEnd=85), corner bl, 1 copy.
    // Obstacle parked at the top so it doesn't block the bottom-left target.
    const nest = n({ enabled: true, marginMm: 0, gapMm: 0, snapMm: 3, corner: "bl", fillMode: "copies", copies: 1 });
    const r = packLayoutAvoiding(10, 10, 100, 95, nest, [box(0, 0, 10, 10)], 0);
    // bl → first candidate flush to the bottom (yEnd = 95−10 = 85), not 84 (the
    // largest multiple of 3 from y0). Left-anchored x stays at 0.
    expect(r.placements[0]).toEqual({ x: 0, y: 85 });
  });
});

const NEST = { ...DEFAULT_NEST, enabled: true, marginMm: 0, gapMm: 0, corner: "tl" as const, rotate: false };

describe("renestSelection", () => {
  it("packs one design's selection into a corner grid", () => {
    // 40×30 board, 100×100 panel, tl, no margin/gap → cols=2, rows=3. 3 selected.
    const r = renestSelection({
      selected: [
        { id: "a", design_id: "d1" },
        { id: "b", design_id: "d1" },
        { id: "c", design_id: "d1" },
      ],
      sizes: { d1: { w: 40, h: 30 } },
      obstacles: [],
      panelW: 100, panelH: 100,
      nest: NEST,
    });
    expect(r.requested).toBe(3);
    expect(r.placed).toBe(3);
    // row-major tl: (0,0),(40,0),(0,30)
    expect(r.transforms.map((t) => [t.x_mm, t.y_mm, t.rotation_deg])).toEqual([
      [0, 0, 0], [40, 0, 0], [0, 30, 0],
    ]);
  });

  it("avoids non-selected obstacles", () => {
    // Obstacle covers the first cell [0,40]×[0,30]; 1 selected → goes to (40,0).
    const r = renestSelection({
      selected: [{ id: "a", design_id: "d1" }],
      sizes: { d1: { w: 40, h: 30 } },
      obstacles: [{ minX: 0, minY: 0, maxX: 40, maxY: 30 }],
      panelW: 100, panelH: 100,
      nest: NEST,
    });
    expect(r.transforms).toEqual([{ id: "a", x_mm: 40, y_mm: 0, rotation_deg: 0 }]);
  });

  it("rotate swaps footprint and sets centre-pivot pose (rotation 90)", () => {
    // 40×30 with rotate → footprint 30×40; tl cell at (0,0). Centre-pivot:
    // x = 0 + (30-40)/2 = -5; y = 0 + (40-30)/2 = 5; rotation 90.
    const r = renestSelection({
      selected: [{ id: "a", design_id: "d1" }],
      sizes: { d1: { w: 40, h: 30 } },
      obstacles: [],
      panelW: 100, panelH: 100,
      nest: { ...NEST, rotate: true },
    });
    expect(r.transforms).toEqual([{ id: "a", x_mm: -5, y_mm: 5, rotation_deg: 90 }]);
  });

  it("rotate works when nest.enabled is false (default settings)", () => {
    // re-nest always grids (groupNest forces enabled:true), so rotate alone must
    // drive the 90° flip even with the persisted default nest.enabled === false.
    const r = renestSelection({
      selected: [{ id: "a", design_id: "d1" }],
      sizes: { d1: { w: 40, h: 30 } },
      obstacles: [],
      panelW: 100, panelH: 100,
      nest: { ...NEST, enabled: false, rotate: true },
    });
    expect(r.transforms).toEqual([{ id: "a", x_mm: -5, y_mm: 5, rotation_deg: 90 }]);
  });

  it("two designs pack into non-overlapping groups", () => {
    // d1 40×30 (1 copy) → (0,0); d2 40×30 (1 copy) avoids d1's new cell → (40,0).
    const r = renestSelection({
      selected: [
        { id: "a", design_id: "d1" },
        { id: "b", design_id: "d2" },
      ],
      sizes: { d1: { w: 40, h: 30 }, d2: { w: 40, h: 30 } },
      obstacles: [],
      panelW: 100, panelH: 100,
      nest: NEST,
    });
    const a = r.transforms.find((t) => t.id === "a")!;
    const b = r.transforms.find((t) => t.id === "b")!;
    expect([a.x_mm, a.y_mm]).toEqual([0, 0]);
    expect([b.x_mm, b.y_mm]).toEqual([40, 0]);
  });

  it("places as many as fit when the grid is too small (partial)", () => {
    // 60×60 board on 100×100, tl, no margin/gap → cols=1,rows=1 → max 1. 2 selected.
    const r = renestSelection({
      selected: [
        { id: "a", design_id: "d1" },
        { id: "b", design_id: "d1" },
      ],
      sizes: { d1: { w: 60, h: 60 } },
      obstacles: [],
      panelW: 100, panelH: 100,
      nest: NEST,
    });
    expect(r.requested).toBe(2);
    expect(r.placed).toBe(1);
    expect(r.transforms).toHaveLength(1);
  });

  it("skips a group whose design size is unknown", () => {
    const r = renestSelection({
      selected: [{ id: "a", design_id: "missing" }],
      sizes: {},
      obstacles: [],
      panelW: 100, panelH: 100,
      nest: NEST,
    });
    expect(r.requested).toBe(0);
    expect(r.placed).toBe(0);
    expect(r.transforms).toEqual([]);
  });
});

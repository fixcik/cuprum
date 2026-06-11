import { describe, it, expect } from "vitest";
import {
  packLayout,
  packLayoutAvoiding,
  packMaxRects,
  boxesOverlap,
  instanceBounds,
  isOffPanel,
  clampDeltaToPanel,
  clampPoseIntoPanel,
  marqueeHits,
  snapAngle,
  boxesForInstances,
  alignInstances,
  distributeInstances,
  computeSmartGuides,
  renestSelection,
  toolingHoleBounds,
  clampToolingHoleCenter,
  registrationSetPositions,
  panelObstacles,
  keepOutBox,
  clampZoneRect,
  clampZonesForHoles,
  buildSnapCandidates,
  computeSelectionBBox,
  type AlignEdge,
  type GuideLine,
  type Box,
} from "@/lib/panelPlacement";
import { DEFAULT_NEST } from "@/lib/nest";
import type { NestSettings } from "@/lib/nest";
import type { BoardInstance, ToolingHole } from "@/lib/api";

const nest = (o: Partial<NestSettings> = {}): NestSettings => ({ ...DEFAULT_NEST, ...o });

describe("packLayout", () => {
  it("places a single corner copy snug to the corner when nesting is disabled", () => {
    // Nesting off = "one copy snug in the corner": the edge margin / gap are
    // auto-nest params and do NOT apply, so the copy sits flush at the corner
    // (0, …). 40×30 board on a 100×100 panel, bl corner.
    const r = packLayout(40, 30, 100, 100, nest({ enabled: false }));
    expect(r.n).toBe(1);
    expect(r.placements).toEqual([{ x: 0, y: 70, rotated: false }]);
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
    expect(r.placements).toEqual([{ x: 0, y: 102, rotated: false }]);
  });

  it("fills a row-major grid from the top-left for an explicit copy count", () => {
    const r = packLayout(40, 30, 100, 100, nest({ enabled: true, fillMode: "copies", copies: 3, corner: "tl" }));
    expect(r.n).toBe(3);
    expect(r.placements).toEqual([
      { x: 5, y: 5, rotated: false },
      { x: 47, y: 5, rotated: false },
      { x: 5, y: 37, rotated: false },
    ]);
  });

  it("clamps the placed count to capacity and flags the overflow via requested", () => {
    const r = packLayout(40, 30, 100, 100, nest({ enabled: true, fillMode: "copies", copies: 10 }));
    expect(r.max).toBe(4);
    expect(r.requested).toBe(10);
    expect(r.n).toBe(4);
  });

  it("applies a 90° rotation to the effective footprint when rotate is on", () => {
    // Grid path (single orientation) reports the swapped footprint; pin mixRotation
    // off so the dispatch stays on the grid rather than falling to MaxRects.
    const r = packLayout(30, 40, 100, 100, nest({ enabled: true, rotate: true, mixRotation: false }));
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

describe("clampPoseIntoPanel", () => {
  it("leaves an inside pose unchanged", () => {
    expect(clampPoseIntoPanel({ x_mm: 10, y_mm: 20, rotation_deg: 0 }, 40, 30, 100, 100)).toEqual({
      x_mm: 10,
      y_mm: 20,
    });
  });
  it("pulls a board poking off the right/bottom back in", () => {
    // 40×30 at (80,80): AABB [80,120]×[80,110] overflows a 100×100 panel.
    expect(clampPoseIntoPanel({ x_mm: 80, y_mm: 80, rotation_deg: 0 }, 40, 30, 100, 100)).toEqual({
      x_mm: 60,
      y_mm: 70,
    });
  });
  it("clamps using the ROTATED footprint (90° swaps w/h)", () => {
    // 40×30 rotated 90° → AABB is 30 wide × 40 tall around the centre. At x=85 it
    // overflows; the corrected origin keeps the rotated AABB inside.
    const r = clampPoseIntoPanel({ x_mm: 85, y_mm: 10, rotation_deg: 90 }, 40, 30, 100, 100);
    const b = instanceBounds({ xMm: r.x_mm, yMm: r.y_mm, boardW: 40, boardH: 30, rotationDeg: 90 });
    expect(b.maxX).toBeLessThanOrEqual(100 + 1e-9);
    expect(b.minX).toBeGreaterThanOrEqual(-1e-9);
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

  it("places copies that avoid an existing instance", () => {
    // With an obstacle present the packer is MaxRects; pin a single orientation so
    // the assertion is about avoidance, not which rotation the heuristic prefers.
    const nest = n({ enabled: true, marginMm: 0, gapMm: 0, fillMode: "copies", copies: 2, corner: "tl", mixRotation: false });
    const obst = [{ minX: 0, minY: 0, maxX: 40, maxY: 30 }];
    const r = packLayoutAvoiding(40, 30, 100, 100, nest, obst, 0);
    expect(r.n).toBe(2);
    const boxes = r.placements.map((p) => ({ minX: p.x, minY: p.y, maxX: p.x + 40, maxY: p.y + 30 }));
    for (const b of boxes) expect(boxesOverlap(b, obst[0])).toBe(false);
    expect(boxesOverlap(boxes[0], boxes[1])).toBe(false);
  });

  it("keeps the clearance gap from an existing instance", () => {
    // Single snug copy (nesting off) 40×30 on 100×100, tl corner; far obstacle →
    // MaxRects still anchors the lone copy at the corner (0,0).
    const nest = n({ enabled: false, corner: "tl" });
    const r = packLayoutAvoiding(40, 30, 100, 100, nest, [{ minX: 60, minY: 60, maxX: 90, maxY: 90 }], 5);
    expect(r.placements).toEqual([{ x: 0, y: 0, rotated: false }]);
  });

  it("packs flush against an obstacle's clearance boundary", () => {
    // nesting off, tl, margin=0, gap=0, single orientation. Obstacle [41,0]-[80,30],
    // clearance 5 → inflated [36,-5]-[85,35]. The board can't fit left of x=36 (needs
    // width 40), so MaxRects drops it just below the clearance band at (0,35).
    const nestOpts = n({ enabled: false, marginMm: 0, gapMm: 0, corner: "tl", mixRotation: false });
    const r = packLayoutAvoiding(40, 30, 100, 100, nestOpts, [{ minX: 41, minY: 0, maxX: 80, maxY: 30 }], 5);
    expect(r.placements).toEqual([{ x: 0, y: 35, rotated: false }]);
  });

  it("flags overflow via requested when free cells run out", () => {
    // Pin a single orientation: with rotation the packer would fit MORE than 3.
    const nest = n({ enabled: true, marginMm: 0, gapMm: 0, fillMode: "copies", copies: 6, corner: "tl", mixRotation: false });
    // Obstacle covering left half [0,40]×[0,100] leaves the right 60mm band → 1 col × 3 rows.
    const r = packLayoutAvoiding(40, 30, 100, 100, nest, [{ minX: 0, minY: 0, maxX: 40, maxY: 100 }], 0);
    expect(r.max).toBe(6);
    expect(r.requested).toBe(6);
    expect(r.n).toBe(3);
  });

  it("packs 6 copies of 40×27.1 around side keep-outs (mixRotation on)", () => {
    // The user's regression: 6 boards fit by hand around two side keep-out zones,
    // but the old fixed-lattice packer placed 5 with an overlap. A 2×3 single-
    // orientation witness fits (cols x=5,47; rows y=5,34.1,63.2; boards end at x=87),
    // and both keep-outs live in the free right band (x≥89), clear by ≥gap.
    const keepouts: Box[] = [
      { minX: 89, minY: 10, maxX: 95, maxY: 40 },
      { minX: 89, minY: 55, maxX: 95, maxY: 85 },
    ];
    const nest = n({ enabled: true, fillMode: "copies", copies: 6, gapMm: 2, marginMm: 5, corner: "tl", mixRotation: true });
    const r = packLayoutAvoiding(40, 27.1, 100, 100, nest, keepouts, 2);
    expect(r.n).toBe(6);
    const boxes = r.placements.map((p) => ({
      minX: p.x, minY: p.y,
      maxX: p.x + (p.rotated ? 27.1 : 40), maxY: p.y + (p.rotated ? 40 : 27.1),
    }));
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++)
        expect(boxesOverlap(boxes[i], boxes[j])).toBe(false);
    for (const b of boxes)
      for (const k of keepouts)
        expect(boxesOverlap(b, { minX: k.minX - 2, minY: k.minY - 2, maxX: k.maxX + 2, maxY: k.maxY + 2 })).toBe(false);
  });
});

describe("packMaxRects", () => {
  it("fits 6 single-orientation copies around side keep-out zones", () => {
    // Core packer in one orientation finds the 2×3 witness around the right-band
    // keep-outs (the mixed best-of is exercised via packLayoutAvoiding above).
    const keepouts: Box[] = [
      { minX: 89, minY: 10, maxX: 95, maxY: 40 },
      { minX: 89, minY: 55, maxX: 95, maxY: 85 },
    ];
    const out = packMaxRects({
      boardW: 40, boardH: 27.1, panelW: 100, panelH: 100,
      requested: 6, marginMm: 5, gapMm: 2, clearanceMm: 2,
      corner: "tl", mixRotation: false, forceRotate: false, obstacles: keepouts,
    });
    expect(out.length).toBe(6);
    const boxes = out.map((p) => ({
      minX: p.x, minY: p.y,
      maxX: p.x + (p.rotated ? 27.1 : 40), maxY: p.y + (p.rotated ? 40 : 27.1),
    }));
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++)
        expect(boxesOverlap(boxes[i], boxes[j])).toBe(false);
    for (const b of boxes) {
      for (const k of keepouts)
        expect(boxesOverlap(b, { minX: k.minX - 2, minY: k.minY - 2, maxX: k.maxX + 2, maxY: k.maxY + 2 })).toBe(false);
      expect(b.minX).toBeGreaterThanOrEqual(5 - 1e-6);
      expect(b.minY).toBeGreaterThanOrEqual(5 - 1e-6);
      expect(b.maxX).toBeLessThanOrEqual(95 + 1e-6);
      expect(b.maxY).toBeLessThanOrEqual(95 + 1e-6);
    }
  });

  it("rotates copies to fit more when mixRotation is on", () => {
    // 40×15 board on 50×42, no margin/gap. 0° → 1 col × 2 rows = 2; 90° (15×40) →
    // 3 across × 1 = 3. mixRotation must place 3, all rotated.
    const out = packMaxRects({
      boardW: 40, boardH: 15, panelW: 50, panelH: 42,
      requested: 3, marginMm: 0, gapMm: 0, clearanceMm: 0,
      corner: "tl", mixRotation: true, forceRotate: false, obstacles: [],
    });
    expect(out.length).toBe(3);
    expect(out.every((p) => p.rotated)).toBe(true);
  });

  it("keeps a single orientation when mixRotation is off", () => {
    const out = packMaxRects({
      boardW: 40, boardH: 15, panelW: 50, panelH: 42,
      requested: 3, marginMm: 0, gapMm: 0, clearanceMm: 0,
      corner: "tl", mixRotation: false, forceRotate: false, obstacles: [],
    });
    expect(out.length).toBe(2);
    expect(out.every((p) => !p.rotated)).toBe(true);
  });

  it("is deterministic", () => {
    const args = {
      boardW: 40, boardH: 27.1, panelW: 100, panelH: 100,
      requested: 6, marginMm: 5, gapMm: 2, clearanceMm: 2,
      corner: "tl" as const, mixRotation: true, forceRotate: false,
      obstacles: [{ minX: 89, minY: 10, maxX: 95, maxY: 40 }] as Box[],
    };
    expect(packMaxRects(args)).toEqual(packMaxRects(args));
  });

  it("respects the board gap between placed copies", () => {
    const out = packMaxRects({
      boardW: 40, boardH: 10, panelW: 100, panelH: 30,
      requested: 2, marginMm: 0, gapMm: 5, clearanceMm: 0,
      corner: "tl", mixRotation: false, forceRotate: false, obstacles: [],
    });
    expect(out.length).toBe(2);
    const b = out.map((p) => ({ minX: p.x, minY: p.y, maxX: p.x + 40, maxY: p.y + 10 }));
    expect(boxesOverlap(
      { minX: b[0].minX - 5, minY: b[0].minY - 5, maxX: b[0].maxX + 5, maxY: b[0].maxY + 5 },
      b[1],
    )).toBe(false);
  });
});

const NEST = { ...DEFAULT_NEST, enabled: true, marginMm: 0, gapMm: 0, corner: "tl" as const, rotate: false, mixRotation: false };

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

describe("toolingHoleBounds", () => {
  it("AABB centred on the centre, side == diameter", () => {
    expect(toolingHoleBounds({ xMm: 10, yMm: 20, diameterMm: 4 })).toEqual({ minX: 8, minY: 18, maxX: 12, maxY: 22 });
  });
});

describe("clampToolingHoleCenter", () => {
  it("keeps the whole bore inside the panel", () => {
    expect(clampToolingHoleCenter(0, 0, 1.5, 100, 80)).toEqual({ x: 1.5, y: 1.5 });
    expect(clampToolingHoleCenter(200, 200, 1.5, 100, 80)).toEqual({ x: 98.5, y: 78.5 });
  });
  it("centres when the panel is smaller than the bore", () => {
    expect(clampToolingHoleCenter(5, 5, 10, 12, 12)).toEqual({ x: 6, y: 6 });
  });
});

describe("registrationSetPositions", () => {
  it("four corners inset by margin (TL, TR, BL, BR)", () => {
    expect(registrationSetPositions(100, 80, 5)).toEqual([
      { x: 5, y: 5 }, { x: 95, y: 5 }, { x: 5, y: 75 }, { x: 95, y: 75 },
    ]);
  });
  it("clamps margin to half the shorter side", () => {
    expect(registrationSetPositions(8, 8, 5)).toEqual([
      { x: 4, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 4 },
    ]);
  });
  it("count 2 returns the diagonal pair (TL, BR)", () => {
    expect(registrationSetPositions(100, 80, 5, 2)).toEqual([
      { x: 5, y: 5 }, { x: 95, y: 75 },
    ]);
  });
});

describe("panelObstacles", () => {
  it("merges board boxes and raw tooling-hole bounds", () => {
    const sizes = { d1: { w: 10, h: 10 } };
    const panel = {
      instances: [{ id: "i1", design_id: "d1", x_mm: 0, y_mm: 0, rotation_deg: 0 }],
      tooling_holes: [{ id: "th-1", x_mm: 50, y_mm: 50, diameter_mm: 4, role: "registration" }],
    } as any;
    const obs = panelObstacles(panel, sizes);
    expect(obs).toContainEqual({ minX: 48, minY: 48, maxX: 52, maxY: 52 });
    expect(obs.length).toBe(2);
  });
  it("includes keep-out zones as obstacles for boards", () => {
    const panel = {
      instances: [] as BoardInstance[],
      tooling_holes: [] as ToolingHole[],
      keep_out_zones: [
        { id: "z1", x_mm: 10, y_mm: 20, width_mm: 5, height_mm: 8 },
      ],
    };
    const obs = panelObstacles(panel, {});
    expect(obs).toContainEqual({ minX: 10, minY: 20, maxX: 15, maxY: 28 });
  });
});

describe("keepOutBox", () => {
  it("converts x_mm/y_mm/width_mm/height_mm to an AABB", () => {
    expect(keepOutBox({ x_mm: 10, y_mm: 20, width_mm: 30, height_mm: 15 })).toEqual({
      minX: 10,
      minY: 20,
      maxX: 40,
      maxY: 35,
    });
  });
  it("handles zero-origin zone", () => {
    expect(keepOutBox({ x_mm: 0, y_mm: 0, width_mm: 100, height_mm: 50 })).toEqual({
      minX: 0,
      minY: 0,
      maxX: 100,
      maxY: 50,
    });
  });
});

describe("clampZoneRect", () => {
  it("normalises negative size and clamps both edges into the panel", () => {
    const r = clampZoneRect({ x_mm: 90, y_mm: 90, width_mm: 30, height_mm: 30 }, 100, 100, 1);
    expect(r).toEqual({ x_mm: 90, y_mm: 90, width_mm: 10, height_mm: 10 });
  });
  it("normalises a negative-size rect (anchor on the far corner)", () => {
    const r = clampZoneRect({ x_mm: 50, y_mm: 50, width_mm: -20, height_mm: -10 }, 100, 100, 1);
    expect(r).toEqual({ x_mm: 30, y_mm: 40, width_mm: 20, height_mm: 10 });
  });
  it("enforces the minimum size", () => {
    const r = clampZoneRect({ x_mm: 10, y_mm: 10, width_mm: 0.2, height_mm: 0.2 }, 100, 100, 1);
    expect(r.width_mm).toBeGreaterThanOrEqual(1);
    expect(r.height_mm).toBeGreaterThanOrEqual(1);
  });
});

describe("clampZonesForHoles", () => {
  const reg = (id: string, x: number, y: number, d = 3): ToolingHole =>
    ({ id, x_mm: x, y_mm: y, diameter_mm: d, role: "registration" });
  it("returns a centred square = diameter + 2·radius for registration/flip", () => {
    const z = clampZonesForHoles([reg("h1", 50, 50, 4)], 3);
    expect(z).toEqual([{ holeId: "h1", box: { minX: 45, minY: 45, maxX: 55, maxY: 55 } }]);
  });
  it("skips unused-role holes", () => {
    const z = clampZonesForHoles([{ id: "u", x_mm: 10, y_mm: 10, diameter_mm: 3, role: "unused" }], 3);
    expect(z).toEqual([]);
  });
  it("returns nothing when radius is 0 (feature off)", () => {
    expect(clampZonesForHoles([reg("h1", 50, 50)], 0)).toEqual([]);
  });
  it("includes flip-role holes", () => {
    const z = clampZonesForHoles([{ id: "f", x_mm: 20, y_mm: 20, diameter_mm: 2, role: "flip" }], 1);
    expect(z).toEqual([{ holeId: "f", box: { minX: 18, minY: 18, maxX: 22, maxY: 22 } }]);
  });
});

const inst = (o: Partial<BoardInstance> = {}): BoardInstance => ({
  id: "i", design_id: "d", x_mm: 0, y_mm: 0, rotation_deg: 0, ...o,
});

describe("buildSnapCandidates", () => {
  it("yields only the blank's nine points when there are no instances", () => {
    const pts = buildSnapCandidates(100, 80, [], {});
    expect(pts).toHaveLength(9);
    // Corners (TL, TR, BL, BR), edge midpoints (top, bottom, left, right), centre.
    expect(pts).toEqual([
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 80 }, { x: 100, y: 80 },
      { x: 50, y: 0 }, { x: 50, y: 80 }, { x: 0, y: 40 }, { x: 100, y: 40 }, { x: 50, y: 40 },
    ]);
  });

  it("adds nine more points for each visible instance (axis-aligned bounds)", () => {
    // 40×30 board at (10,10), unrotated → AABB [10,10]..[50,40].
    const pts = buildSnapCandidates(100, 80, [inst({ x_mm: 10, y_mm: 10 })], { d: { w: 40, h: 30 } });
    expect(pts).toHaveLength(18);
    const boardPts = pts.slice(9);
    expect(boardPts).toEqual([
      { x: 10, y: 10 }, { x: 50, y: 10 }, { x: 10, y: 40 }, { x: 50, y: 40 },
      { x: 30, y: 10 }, { x: 30, y: 40 }, { x: 10, y: 25 }, { x: 50, y: 25 }, { x: 30, y: 25 },
    ]);
  });

  it("skips instances whose board size is unknown", () => {
    const pts = buildSnapCandidates(100, 80, [inst({ design_id: "missing" })], {});
    expect(pts).toHaveLength(9);
  });
});

describe("computeSelectionBBox", () => {
  const sizes = { d: { w: 40, h: 30 } };

  it("returns null when nothing is selected", () => {
    expect(computeSelectionBBox([inst({ id: "a", x_mm: 10, y_mm: 10 })], new Set(), sizes, null)).toBeNull();
  });

  it("returns the box + bottom-right anchor for a single selection", () => {
    const r = computeSelectionBBox([inst({ id: "a", x_mm: 10, y_mm: 10 })], new Set(["a"]), sizes, null);
    expect(r).toEqual({ minX: 10, minY: 10, maxX: 50, maxY: 40, anchorX: 50, anchorY: 40 });
  });

  it("unions two selected boards and anchors to the nearest real corner", () => {
    const boards = [
      inst({ id: "a", x_mm: 0, y_mm: 0 }),
      inst({ id: "b", x_mm: 100, y_mm: 60 }),
    ];
    const r = computeSelectionBBox(boards, new Set(["a", "b"]), sizes, null);
    // Union AABB [0,0]..[140,90]; the union's bottom-right (140,90) IS board b's
    // bottom-right corner, so the anchor pins there.
    expect(r).toEqual({ minX: 0, minY: 0, maxX: 140, maxY: 90, anchorX: 140, anchorY: 90 });
  });

  it("grows the box when a rotation preview is applied", () => {
    const sel = new Set(["a"]);
    const board = [inst({ id: "a", x_mm: 10, y_mm: 10 })];
    const flat = computeSelectionBBox(board, sel, sizes, null)!;
    const spun = computeSelectionBBox(board, sel, sizes, 45)!;
    // A 45° spin of a 40×30 board about its centre widens its AABB on both axes.
    expect(spun.maxX - spun.minX).toBeGreaterThan(flat.maxX - flat.minX);
    expect(spun.maxY - spun.minY).toBeGreaterThan(flat.maxY - flat.minY);
    // Centre is preserved by a centre-pivot rotation.
    expect((spun.minX + spun.maxX) / 2).toBeCloseTo((flat.minX + flat.maxX) / 2);
    expect((spun.minY + spun.maxY) / 2).toBeCloseTo((flat.minY + flat.maxY) / 2);
  });

  it("ignores selected ids whose size is unknown (null when none resolve)", () => {
    expect(computeSelectionBBox([inst({ id: "a", design_id: "missing" })], new Set(["a"]), sizes, null)).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { evaluatePanel, MIN_PANEL_GAP_MM } from "@/lib/panelFeasibility";
import { overallVerdict } from "@/lib/feasibility";
import { boxesOverlap, instanceBounds, type Box } from "@/lib/panelPlacement";
import type { PanelDoc, KeepOutZone, ToolingHole } from "@/lib/api";
import type { CapabilityProfile } from "@/lib/capabilityProfile";

const prof = { maxPanelWidthMm: 200, maxPanelHeightMm: 100 } as CapabilityProfile;
const inst = (id: string, design_id: string, x: number, y: number, rot = 0) =>
  ({ id, design_id, x_mm: x, y_mm: y, rotation_deg: rot });
const panel = (w: number, h: number, instances: ReturnType<typeof inst>[], tooling_holes: ToolingHole[] = [], keep_out_zones: KeepOutZone[] = []): PanelDoc =>
  ({ width_mm: w, height_mm: h, instances, tooling_holes, keep_out_zones } as unknown as PanelDoc);
const zone = (id: string, x: number, y: number, w: number, h: number): KeepOutZone =>
  ({ id, x_mm: x, y_mm: y, width_mm: w, height_mm: h });
const hole = (id: string, x: number, y: number, d = 3): ToolingHole =>
  ({ id, x_mm: x, y_mm: y, diameter_mm: d, role: "registration" as const });

describe("evaluatePanel", () => {
  it("empty panel → single info finding, verdict ok", () => {
    const f = evaluatePanel({ panel: panel(100, 100, []), sizes: {}, profile: prof, designVerdicts: {} });
    expect(f).toHaveLength(1);
    expect(f[0].category).toBe("empty");
    expect(f[0].severity).toBe("info");
    expect(overallVerdict(f)).toBe("ok");
  });

  it("off-panel instance → block finding carrying its id", () => {
    const f = evaluatePanel({
      panel: panel(50, 50, [inst("a", "d1", 40, 40)]),  // 20×20 board pokes past 50×50
      sizes: { d1: { w: 20, h: 20 } }, profile: prof, designVerdicts: { d1: "ok" },
    });
    const off = f.find((x) => x.category === "off-panel");
    expect(off?.severity).toBe("block");
    expect(off?.instanceIds).toContain("a");
    expect(overallVerdict(f)).toBe("block");
  });

  it("overlapping boards → block finding with both ids", () => {
    const f = evaluatePanel({
      panel: panel(100, 100, [inst("a", "d1", 0, 0), inst("b", "d1", 5, 5)]),
      sizes: { d1: { w: 20, h: 20 } }, profile: prof, designVerdicts: { d1: "ok" },
    });
    const ov = f.find((x) => x.category === "overlap");
    expect(ov?.severity).toBe("block");
    expect(ov?.instanceIds.sort()).toEqual(["a", "b"]);
  });

  it("overlapping boards are NOT also double-counted as a spacing warning", () => {
    // Both boards sit at the panel corner → overlap AND within minGap of an edge.
    const f = evaluatePanel({
      panel: panel(100, 100, [inst("a", "d1", 0, 0), inst("b", "d1", 5, 5)]),
      sizes: { d1: { w: 20, h: 20 } }, profile: prof, designVerdicts: { d1: "ok" },
    });
    expect(f.some((x) => x.category === "overlap")).toBe(true);
    expect(f.some((x) => x.category === "spacing")).toBe(false);
  });

  it("boards within MIN_PANEL_GAP but not overlapping → warn spacing", () => {
    // a:[0,20], b at x=20+0.5 → gap 0.5 < 1 mm, no overlap.
    const f = evaluatePanel({
      panel: panel(100, 100, [inst("a", "d1", 0, 0), inst("b", "d1", 20.5, 0)]),
      sizes: { d1: { w: 20, h: 20 } }, profile: prof, designVerdicts: { d1: "ok" },
    });
    expect(f.some((x) => x.category === "spacing" && x.severity === "warn")).toBe(true);
    expect(f.some((x) => x.category === "overlap")).toBe(false);
  });

  it("boards exactly MIN_PANEL_GAP apart → no spacing warning (Auto-gap layout is clean)", () => {
    // a:[5,25], b at x = 25 + MIN_PANEL_GAP → gap == minGap exactly. With the tolerance
    // this must pass (what the Auto button + solver produce).
    const f = evaluatePanel({
      panel: panel(100, 100, [inst("a", "d1", 5, 5), inst("b", "d1", 25 + MIN_PANEL_GAP_MM, 5)]),
      sizes: { d1: { w: 20, h: 20 } }, profile: prof, designVerdicts: { d1: "ok" },
    });
    expect(f.some((x) => x.category === "spacing")).toBe(false);
  });

  it("board exactly MIN_PANEL_GAP from the panel edge → no spacing warning", () => {
    // box [MIN_PANEL_GAP, MIN_PANEL_GAP + 20]; edge margin == minGap exactly.
    const f = evaluatePanel({
      panel: panel(100, 100, [inst("a", "d1", MIN_PANEL_GAP_MM, MIN_PANEL_GAP_MM)]),
      sizes: { d1: { w: 20, h: 20 } }, profile: prof, designVerdicts: { d1: "ok" },
    });
    expect(f.some((x) => x.category === "spacing")).toBe(false);
  });

  it("instance inside panel but past the old machine work-area limit → no extra finding", () => {
    // panel 200×150, old work area 200×100; board at y=120 (within panel, past old 100 limit).
    // After the refactor, panel DFM no longer checks machine work-area bounds — only off-panel matters.
    const f = evaluatePanel({
      panel: panel(200, 150, [inst("a", "d1", 10, 120)]),
      sizes: { d1: { w: 20, h: 20 } }, profile: prof, designVerdicts: { d1: "ok" },
    });
    // Board is fully inside the panel → no off-panel finding; no work-area category exists.
    expect(f.some((x) => x.category === "off-panel")).toBe(false);
    expect(f).toHaveLength(0);
  });

  it("a placed design's own block verdict escalates the panel verdict", () => {
    const f = evaluatePanel({
      panel: panel(100, 100, [inst("a", "d1", 0, 0)]),
      sizes: { d1: { w: 20, h: 20 } }, profile: prof, designVerdicts: { d1: "block" },
    });
    const dv = f.find((x) => x.category === "design");
    expect(dv?.severity).toBe("block");
    expect(dv?.instanceIds).toContain("a");
    expect(overallVerdict(f)).toBe("block");
  });

  it("MIN_PANEL_GAP_MM is 1", () => {
    expect(MIN_PANEL_GAP_MM).toBe(1);
  });

  it("board exactly on edge (flush) is not off-panel", () => {
    // 20×20 board at (80,80) in a 100×100 panel — flush on two edges.
    const f = evaluatePanel({
      panel: panel(100, 100, [inst("a", "d1", 80, 80)]),
      sizes: { d1: { w: 20, h: 20 } }, profile: prof, designVerdicts: { d1: "ok" },
    });
    expect(f.some((x) => x.category === "off-panel")).toBe(false);
  });

  it("a placed design's warn verdict propagates to the panel as warn", () => {
    const f = evaluatePanel({
      panel: panel(100, 100, [inst("a", "d1", 0, 0)]),
      sizes: { d1: { w: 20, h: 20 } }, profile: prof, designVerdicts: { d1: "warn" },
    });
    const dv = f.find((x) => x.category === "design" && x.severity === "warn");
    expect(dv).toBeTruthy();
    expect(overallVerdict(f)).toBe("warn");
  });

  it("instance with unknown size is skipped in geometry checks", () => {
    // sizes has no entry for d1 → instance should be skipped (no off-panel / overlap)
    const f = evaluatePanel({
      panel: panel(100, 100, [inst("a", "d1", 200, 200)]), // clearly off-panel coordinates
      sizes: {}, profile: prof, designVerdicts: {},
    });
    expect(f.some((x) => x.category === "off-panel")).toBe(false);
  });

  it("all-ok layout → no findings (empty array), verdict ok", () => {
    // board fully inside, no overlap, within work area
    const f = evaluatePanel({
      panel: panel(100, 100, [inst("a", "d1", 10, 10)]),
      sizes: { d1: { w: 20, h: 20 } }, profile: prof, designVerdicts: { d1: "ok" },
    });
    expect(f).toHaveLength(0);
    expect(overallVerdict(f)).toBe("ok");
  });

  it("flags a board intersecting any keep-out zone (block)", () => {
    // 20×20 board at (10,10) → AABB [10,30]×[10,30]; zone [15,45]×[15,45] → overlap
    const f = evaluatePanel({
      panel: panel(100, 100, [inst("b1", "d1", 10, 10)], [], [zone("z1", 15, 15, 30, 30)]),
      sizes: { d1: { w: 20, h: 20 } }, profile: prof, designVerdicts: { d1: "ok" },
    });
    const ko = f.find((x) => x.category === "keep-out");
    expect(ko?.severity).toBe("block");
    expect(ko?.instanceIds).toEqual(["b1"]);
    expect(overallVerdict(f)).toBe("block");
  });

  it("flags a tooling hole inside any keep-out zone as keep-out (block)", () => {
    // h1 at (20,20) d=3 → AABB [18.5,21.5]×[18.5,21.5]; zone [10,30]×[10,30] → overlap
    // h2 at (80,20) d=3 → AABB [78.5,81.5]×[18.5,21.5]; zone [70,90]×[10,30] → also flagged
    const f = evaluatePanel({
      panel: panel(
        100, 100,
        [inst("clear", "d1", 50, 50)],
        [hole("h1", 20, 20), hole("h2", 80, 20)],
        [zone("z1", 10, 10, 20, 20), zone("z2", 70, 10, 20, 20)],
      ),
      sizes: { d1: { w: 5, h: 5 } }, profile: prof, designVerdicts: { d1: "ok" },
    });
    const ko = f.find((x) => x.category === "keep-out");
    expect(ko?.severity).toBe("block");
    expect(ko?.toolingHoleIds).toEqual(["h1", "h2"]);
    expect(overallVerdict(f)).toBe("block");
  });

  it("flags a board overlapping a registration hole's clamp zone (block)", () => {
    // board [10,30]×[10,30]; hole at (25,25) d=3, clampRadius=5 → half=1.5+5=6.5 → clamp [18.5,31.5]×[18.5,31.5]
    const f = evaluatePanel({
      panel: panel(100, 100, [inst("a", "d1", 10, 10, 0)], [hole("h1", 25, 25, 3)]),
      sizes: { d1: { w: 20, h: 20 } },
      profile: { ...prof, toolingClampRadiusMm: 5 } as CapabilityProfile,
      designVerdicts: {},
    });
    const c = f.find((x) => x.category === "clamp");
    expect(c?.severity).toBe("block");
    expect(c?.instanceIds).toEqual(["a"]);
  });

  it("no clamp finding when radius is 0", () => {
    const f = evaluatePanel({
      panel: panel(100, 100, [inst("a", "d1", 10, 10, 0)], [hole("h1", 25, 25, 3)]),
      sizes: { d1: { w: 20, h: 20 } },
      profile: { ...prof, toolingClampRadiusMm: 0 } as CapabilityProfile,
      designVerdicts: {},
    });
    expect(f.some((x) => x.category === "clamp")).toBe(false);
  });

  it("ignores unused-role holes for the clamp zone", () => {
    const f = evaluatePanel({
      panel: panel(100, 100, [inst("a", "d1", 10, 10, 0)], [{ id: "h1", x_mm: 25, y_mm: 25, diameter_mm: 3, role: "unused" as const }]),
      sizes: { d1: { w: 20, h: 20 } },
      profile: { ...prof, toolingClampRadiusMm: 5 } as CapabilityProfile,
      designVerdicts: {},
    });
    expect(f.some((x) => x.category === "clamp")).toBe(false);
  });
});

describe("evaluatePanel — sweep matches the all-pairs reference", () => {
  // Layouts keep boards well inside the panel so neither off-panel nor the
  // edge-margin rule fires: the overlap/spacing findings then come ONLY from
  // pairwise interactions, which is exactly what the sweep replaced.
  const PANEL_W = 500;
  const PANEL_H = 500;
  const MIN_GAP = 2;

  /** All-pairs reference classification (the pre-sweep original). */
  const naiveSets = (
    instances: ReturnType<typeof inst>[],
    sizes: Record<string, { w: number; h: number }>,
    minGap: number,
  ) => {
    const boxes = instances.map((i) => {
      const sz = sizes[i.design_id];
      return instanceBounds({ xMm: i.x_mm, yMm: i.y_mm, boardW: sz.w, boardH: sz.h, rotationDeg: i.rotation_deg });
    });
    const gap = (a: Box, b: Box) =>
      Math.max(a.minX - b.maxX, b.minX - a.maxX, a.minY - b.maxY, b.minY - a.maxY);
    const overlap = new Set<string>();
    const spacing = new Set<string>();
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        if (boxesOverlap(boxes[i], boxes[j])) {
          overlap.add(instances[i].id);
          overlap.add(instances[j].id);
        } else if (gap(boxes[i], boxes[j]) < minGap - 1e-3) {
          spacing.add(instances[i].id);
          spacing.add(instances[j].id);
        }
      }
    }
    return { overlap, spacing };
  };

  const idsOf = (f: ReturnType<typeof evaluatePanel>, cat: string) =>
    [...(f.find((x) => x.category === cat)?.instanceIds ?? [])].sort();

  const expectMatch = (
    instances: ReturnType<typeof inst>[],
    sizes: Record<string, { w: number; h: number }>,
  ) => {
    const f = evaluatePanel({
      panel: panel(PANEL_W, PANEL_H, instances),
      sizes,
      profile: prof,
      designVerdicts: {},
      minGapMm: MIN_GAP,
    });
    const ref = naiveSets(instances, sizes, MIN_GAP);
    expect(idsOf(f, "overlap")).toEqual([...ref.overlap].sort());
    expect(idsOf(f, "spacing")).toEqual([...ref.spacing].sort());
  };

  /** Deterministic PRNG (mulberry32) for randomized layouts. */
  const mulberry32 = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  it("matches on a single column sharing one x (sweep worst case)", () => {
    // Same minX for every box → nothing is ever evicted from the active window;
    // mixed y-gaps produce overlaps, spacing violations and clean pairs.
    const instances = [
      inst("c0", "d1", 100, 10),
      inst("c1", "d1", 100, 25), // gap 5 → clean
      inst("c2", "d1", 100, 36), // gap 1 → spacing
      inst("c3", "d1", 100, 44), // overlaps c2
      inst("c4", "d1", 100, 70), // far → clean
    ];
    expectMatch(instances, { d1: { w: 10, h: 10 } });
  });

  it("matches on a tight uniform grid with mixed-size designs", () => {
    const sizes = { small: { w: 6, h: 6 }, wide: { w: 18, h: 4 } };
    const instances = Array.from({ length: 144 }, (_, i) =>
      inst(`g${i}`, i % 3 === 0 ? "wide" : "small", 20 + (i % 12) * 8, 20 + Math.floor(i / 12) * 8),
    );
    expectMatch(instances, sizes);
  });

  it("matches on random scatters with rotation", () => {
    const sizes = { d1: { w: 8, h: 8 }, d2: { w: 14, h: 5 } };
    for (const seed of [1, 2, 3, 4]) {
      const rnd = mulberry32(seed);
      const instances = Array.from({ length: 120 }, (_, i) =>
        inst(
          `r${i}`,
          rnd() < 0.5 ? "d1" : "d2",
          30 + rnd() * (PANEL_W - 80),
          30 + rnd() * (PANEL_H - 80),
          rnd() < 0.3 ? 90 : 0,
        ),
      );
      expectMatch(instances, sizes);
    }
  });

  it("matches when everything overlaps in one heap", () => {
    const rnd = mulberry32(9);
    const instances = Array.from({ length: 40 }, (_, i) =>
      inst(`h${i}`, "d1", 200 + rnd() * 6, 200 + rnd() * 6),
    );
    expectMatch(instances, { d1: { w: 12, h: 12 } });
  });
});

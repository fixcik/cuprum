import { describe, it, expect } from "vitest";
import { evaluatePanel, MIN_PANEL_GAP_MM } from "@/lib/panelFeasibility";
import { overallVerdict } from "@/lib/feasibility";
import type { PanelDoc, KeepOutZone, ToolingHole } from "@/lib/api";
import type { CapabilityProfile } from "@/lib/capabilityProfile";

const prof = { maxPanelWidthMm: 200, maxPanelHeightMm: 100 } as CapabilityProfile;
const inst = (id: string, design_id: string, x: number, y: number, rot = 0) =>
  ({ id, design_id, x_mm: x, y_mm: y, rotation_deg: rot, layer_ref: "Top" as const });
const panel = (w: number, h: number, instances: ReturnType<typeof inst>[], tooling_holes: ToolingHole[] = [], keep_out_zones: KeepOutZone[] = []): PanelDoc =>
  ({ width_mm: w, height_mm: h, instances, tooling_holes, keep_out_zones } as unknown as PanelDoc);
const zone = (id: string, x: number, y: number, w: number, h: number, kind: KeepOutZone["kind"] = "fixture"): KeepOutZone =>
  ({ id, x_mm: x, y_mm: y, width_mm: w, height_mm: h, kind });
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

  it("instance inside panel but past the machine work area → warn", () => {
    // panel 200×150, work area 200×100; board at y=120 (within panel, past 100).
    const f = evaluatePanel({
      panel: panel(200, 150, [inst("a", "d1", 10, 120)]),
      sizes: { d1: { w: 20, h: 20 } }, profile: prof, designVerdicts: { d1: "ok" },
    });
    expect(f.some((x) => x.category === "work-area" && x.severity === "warn")).toBe(true);
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

  it("flags a tooling hole in a dead zone, ignores fixture/reserved (block)", () => {
    // h1 at (20,20) d=3 → AABB [18.5,21.5]×[18.5,21.5]; dead zone [10,30]×[10,30] → overlap
    // h2 at (80,20) d=3 → AABB [78.5,81.5]×[18.5,21.5]; fixture zone [70,90]×[10,30] → NOT flagged
    const f = evaluatePanel({
      panel: panel(
        100, 100,
        [inst("clear", "d1", 50, 50)],
        [hole("h1", 20, 20), hole("h2", 80, 20)],
        [zone("z1", 10, 10, 20, 20, "dead"), zone("z2", 70, 10, 20, 20, "fixture")],
      ),
      sizes: { d1: { w: 5, h: 5 } }, profile: prof, designVerdicts: { d1: "ok" },
    });
    const ko = f.find((x) => x.category === "keep-out-tooling");
    expect(ko?.severity).toBe("block");
    expect(ko?.toolingHoleIds).toEqual(["h1"]);
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

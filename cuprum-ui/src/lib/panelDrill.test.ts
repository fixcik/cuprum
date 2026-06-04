import { describe, expect, it } from "vitest";
import { instanceBounds } from "@/lib/panelPlacement";
import {
  buildPanelDrillPlan,
  collectDesignHoles,
  projectHoleToPanel,
} from "@/lib/panelDrill";
import type { BoardInstance, Hole, ToolingHole } from "@/lib/api";
import type { Tool } from "@/lib/toolLibrary";

const inst = (over: Partial<BoardInstance> = {}): BoardInstance => ({
  id: "inst-1",
  design_id: "design-1",
  x_mm: 10,
  y_mm: 20,
  rotation_deg: 0,
  layer_ref: "Top",
  ...over,
});

const drillTool = (id: string, d: number): Tool => ({
  id,
  name: `D${d}`,
  kind: "drill",
  diameterMm: d,
  material: "carbide",
  recommendedRpm: 9000,
  recommendedFeedMmMin: 100,
  recommendedPlungeMmMin: 60,
});

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

describe("collectDesignHoles", () => {
  it("translates absolute gerber coords to board-local (minus origin)", () => {
    const holes: Hole[] = [
      { x: 12, y: 25, d: 0.8 },
      { x: 40, y: 60, d: 1.0 },
    ];
    expect(collectDesignHoles(holes, 10, 20)).toEqual([
      { xMm: 2, yMm: 5, dMm: 0.8 },
      { xMm: 30, yMm: 40, dMm: 1.0 },
    ]);
  });
});

describe("projectHoleToPanel", () => {
  const W = 30, H = 40;
  // Board-local corners (Y-up, origin at board min corner).
  const corners = [
    { xMm: 0, yMm: 0 },
    { xMm: W, yMm: 0 },
    { xMm: 0, yMm: H },
    { xMm: W, yMm: H },
  ];

  it("rotation 0, Top: corners map to the footprint, bbox == instanceBounds", () => {
    const i = inst({ rotation_deg: 0 });
    const pts = corners.map((c) => projectHoleToPanel(c, i, W, H));
    const xs = pts.map((p) => p.xMm), ys = pts.map((p) => p.yMm);
    const b = instanceBounds({ xMm: i.x_mm, yMm: i.y_mm, boardW: W, boardH: H, rotationDeg: 0 });
    expect(close(Math.min(...xs), b.minX)).toBe(true);
    expect(close(Math.max(...xs), b.maxX)).toBe(true);
    expect(close(Math.min(...ys), b.minY)).toBe(true);
    expect(close(Math.max(...ys), b.maxY)).toBe(true);
    // local (0,0) is the board's bottom-left → panel bottom-left of the footprint.
    expect(projectHoleToPanel({ xMm: 0, yMm: 0 }, i, W, H)).toEqual({ xMm: 10, yMm: 60 });
    expect(projectHoleToPanel({ xMm: W, yMm: H }, i, W, H)).toEqual({ xMm: 40, yMm: 20 });
  });

  it.each([90, 180, 270, 37])("rotation %d: projected corners' bbox == instanceBounds", (deg) => {
    const i = inst({ rotation_deg: deg });
    const pts = corners.map((c) => projectHoleToPanel(c, i, W, H));
    const xs = pts.map((p) => p.xMm), ys = pts.map((p) => p.yMm);
    const b = instanceBounds({ xMm: i.x_mm, yMm: i.y_mm, boardW: W, boardH: H, rotationDeg: deg });
    expect(close(Math.min(...xs), b.minX)).toBe(true);
    expect(close(Math.max(...xs), b.maxX)).toBe(true);
    expect(close(Math.min(...ys), b.minY)).toBe(true);
    expect(close(Math.max(...ys), b.maxY)).toBe(true);
  });

  it("Bottom mirrors X within the footprint", () => {
    const i = inst({ rotation_deg: 0, layer_ref: "Bottom" });
    // local (0,0) on Bottom → mirrored to x = W → panel x = x_mm + W.
    expect(projectHoleToPanel({ xMm: 0, yMm: 0 }, i, W, H)).toEqual({ xMm: 40, yMm: 60 });
  });
});

describe("buildPanelDrillPlan", () => {
  const sizes = new Map([["design-1", { w: 30, h: 40 }]]);
  const designHoles = new Map([
    ["design-1", [
      { xMm: 0, yMm: 0, dMm: 0.5 }, // pth (≤0.6)
      { xMm: 30, yMm: 40, dMm: 3.0 }, // mechanical
    ]],
  ]);
  const tools = [drillTool("tool-1", 0.5), drillTool("tool-2", 3.0)];
  const opts = { viaMaxDiameterMm: 0.6, drillBitToleranceMm: 0.05 };

  it("groups by diameter+class, assigns tools, counts holes", () => {
    const panel = {
      instances: [inst(), inst({ id: "inst-2", x_mm: 100 })],
      tooling_holes: [] as ToolingHole[],
    };
    const plan = buildPanelDrillPlan(panel, designHoles, sizes, tools, opts);
    expect(plan.totalHoles).toBe(4); // 2 holes × 2 instances
    const g05 = plan.groups.find((g) => close(g.diameterMm, 0.5))!;
    expect(g05.class).toBe("pth");
    expect(g05.toolId).toBe("tool-1");
    expect(g05.holes).toHaveLength(2);
    const g3 = plan.groups.find((g) => close(g.diameterMm, 3.0))!;
    expect(g3.class).toBe("mechanical");
    expect(g3.toolId).toBe("tool-2");
    expect(plan.unmatchedDiametersMm).toEqual([]);
  });

  it("tooling holes fold in by role; unused skipped; registration is its own group", () => {
    const panel = {
      instances: [],
      tooling_holes: [
        { id: "th-1", x_mm: 5, y_mm: 5, diameter_mm: 3.0, role: "registration" as const },
        { id: "th-2", x_mm: 9, y_mm: 9, diameter_mm: 3.0, role: "unused" as const },
      ],
    };
    const plan = buildPanelDrillPlan(panel, designHoles, sizes, tools, opts);
    expect(plan.totalHoles).toBe(1); // unused skipped
    const reg = plan.groups.find((g) => g.class === "registration")!;
    expect(reg.diameterMm).toBe(3.0);
    expect(reg.toolId).toBe("tool-2");
  });

  it("reports unmatched diameters with toolId null", () => {
    const panel = { instances: [inst()], tooling_holes: [] as ToolingHole[] };
    const odd = new Map([["design-1", [{ xMm: 0, yMm: 0, dMm: 0.7 }]]]);
    const plan = buildPanelDrillPlan(panel, odd, sizes, tools, opts);
    const g = plan.groups[0];
    expect(g.toolId).toBeNull();
    expect(plan.unmatchedDiametersMm).toEqual([0.7]);
  });
});

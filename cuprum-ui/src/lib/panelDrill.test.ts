import { describe, expect, it } from "vitest";
import { instanceBounds } from "@/lib/panelPlacement";
import {
  buildPanelDrillPlan,
  collectDesignHoles,
  projectHoleToPanel,
} from "@/lib/panelDrill";
import type { Rect } from "@/lib/panelDrill";
import type { BoardInstance, Hole, ToolingHole } from "@/lib/api";
import type { Tool } from "@/lib/toolLibrary";

const inst = (over: Partial<BoardInstance> = {}): BoardInstance => ({
  id: "inst-1",
  design_id: "design-1",
  x_mm: 10,
  y_mm: 20,
  rotation_deg: 0,
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
    const plan = buildPanelDrillPlan(panel, designHoles, sizes, tools, opts, []);
    expect(plan.totalHoles).toBe(4); // 2 holes × 2 instances
    const g05 = plan.groups.find((g) => close(g.diameterMm, 0.5))!;
    expect(g05.class).toBe("pth");
    expect(g05.toolId).toBe("tool-1");
    expect(g05.holes).toHaveLength(2);
    const g3 = plan.groups.find((g) => close(g.diameterMm, 3.0))!;
    expect(g3.class).toBe("mechanical");
    expect(g3.toolId).toBe("tool-2");
    expect(plan.unmatchedDiametersMm).toEqual([]);
    expect(plan.skippedInKeepout).toBe(0);
    expect(plan.registrationInKeepout).toBe(0);
  });

  it("tooling holes fold in by role; unused skipped; registration is its own group", () => {
    const panel = {
      instances: [],
      tooling_holes: [
        { id: "th-1", x_mm: 5, y_mm: 5, diameter_mm: 3.0, role: "registration" as const },
        { id: "th-2", x_mm: 9, y_mm: 9, diameter_mm: 3.0, role: "unused" as const },
      ],
    };
    const plan = buildPanelDrillPlan(panel, designHoles, sizes, tools, opts, []);
    expect(plan.totalHoles).toBe(1); // unused skipped
    const reg = plan.groups.find((g) => g.class === "registration")!;
    expect(reg.diameterMm).toBe(3.0);
    expect(reg.toolId).toBe("tool-2");
  });

  it("reports unmatched diameters with toolId null", () => {
    const panel = { instances: [inst()], tooling_holes: [] as ToolingHole[] };
    const odd = new Map([["design-1", [{ xMm: 0, yMm: 0, dMm: 0.7 }]]]);
    const plan = buildPanelDrillPlan(panel, odd, sizes, tools, opts, []);
    const g = plan.groups[0];
    expect(g.toolId).toBeNull();
    expect(plan.unmatchedDiametersMm).toEqual([0.7]);
  });
});

describe("buildPanelDrillPlan — keep-out zone exclusion", () => {
  const sizes = new Map([["design-1", { w: 30, h: 40 }]]);
  const tools = [
    { id: "tool-1", name: "D0.5", kind: "drill" as const, diameterMm: 0.5, material: "carbide" as const, recommendedRpm: 9000, recommendedFeedMmMin: 100, recommendedPlungeMmMin: 60 },
    { id: "tool-2", name: "D3.0", kind: "drill" as const, diameterMm: 3.0, material: "carbide" as const, recommendedRpm: 9000, recommendedFeedMmMin: 100, recommendedPlungeMmMin: 60 },
  ];
  const opts = { viaMaxDiameterMm: 0.6, drillBitToleranceMm: 0.05 };

  // inst at x=0, y=0, no rotation; board 30×40
  // local (0,0) → panel (0, 40); local (30,40) → panel (30, 0)
  const baseInst: BoardInstance = { id: "i1", design_id: "design-1", x_mm: 0, y_mm: 0, rotation_deg: 0 };

  it("board hole whose projected position is inside a zone → excluded, skippedInKeepout===1", () => {
    // local (0,0) projects to panel (0, 40) — place zone there
    const zone: Rect = { x: -1, y: 39, w: 3, h: 3 }; // covers (0,40)
    const designHoles = new Map([["design-1", [{ xMm: 0, yMm: 0, dMm: 0.5 }]]]);
    const panel = { instances: [baseInst], tooling_holes: [] as ToolingHole[] };
    const plan = buildPanelDrillPlan(panel, designHoles, sizes, tools, opts, [zone]);
    expect(plan.skippedInKeepout).toBe(1);
    expect(plan.totalHoles).toBe(0);
    expect(plan.groups).toHaveLength(0);
  });

  it("board hole outside all zones → included, counts 0", () => {
    // zone far away from the projected hole at (0,40)
    const zone: Rect = { x: 100, y: 100, w: 10, h: 10 };
    const designHoles = new Map([["design-1", [{ xMm: 0, yMm: 0, dMm: 0.5 }]]]);
    const panel = { instances: [baseInst], tooling_holes: [] as ToolingHole[] };
    const plan = buildPanelDrillPlan(panel, designHoles, sizes, tools, opts, [zone]);
    expect(plan.skippedInKeepout).toBe(0);
    expect(plan.registrationInKeepout).toBe(0);
    expect(plan.totalHoles).toBe(1);
  });

  it("tooling hole inside a zone → excluded, registrationInKeepout===1, not in any group", () => {
    const zone: Rect = { x: 4, y: 4, w: 4, h: 4 }; // covers (5,5) with no clearance needed
    const panel = {
      instances: [],
      tooling_holes: [
        { id: "th-1", x_mm: 5, y_mm: 5, diameter_mm: 3.0, role: "registration" as const },
      ],
    };
    const plan = buildPanelDrillPlan(panel, new Map(), sizes, tools, opts, [zone]);
    expect(plan.registrationInKeepout).toBe(1);
    expect(plan.totalHoles).toBe(0);
    expect(plan.groups).toHaveLength(0);
  });

  it("tooling hole outside zones → included as before", () => {
    const zone: Rect = { x: 100, y: 100, w: 10, h: 10 };
    const panel = {
      instances: [],
      tooling_holes: [
        { id: "th-1", x_mm: 5, y_mm: 5, diameter_mm: 3.0, role: "registration" as const },
      ],
    };
    const plan = buildPanelDrillPlan(panel, new Map(), sizes, tools, opts, [zone]);
    expect(plan.registrationInKeepout).toBe(0);
    expect(plan.totalHoles).toBe(1);
  });

  it("radius edge: hole center just outside zone rect but within radius+clearance → excluded", () => {
    // zone at x=10,y=10,w=10,h=10 → right edge at x=20
    // hole center at x=20.1, y=15 (just outside right edge)
    // radius=1.0, clearance=0.2 → expand margin=1.2 → expanded right edge at 21.2
    // 20.1 < 21.2 → inside expanded zone → excluded
    const zone: Rect = { x: 10, y: 10, w: 10, h: 10 };
    // Place hole directly in panel space: use a tooling hole for simplicity
    const panel = {
      instances: [],
      tooling_holes: [
        { id: "th-edge", x_mm: 20.1, y_mm: 15, diameter_mm: 2.0, role: "registration" as const },
      ],
    };
    // radius = 1.0, KEEPOUT_DRILL_CLEARANCE_MM = 0.2 → margin = 1.2
    // zone expanded right edge: 10 + 10 + 1.2 = 21.2 → 20.1 is inside
    const plan = buildPanelDrillPlan(panel, new Map(), sizes, tools, opts, [zone]);
    expect(plan.registrationInKeepout).toBe(1);
    expect(plan.totalHoles).toBe(0);
  });
});

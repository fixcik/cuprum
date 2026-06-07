import { describe, expect, it } from "vitest";
import { emitDrillProgram, emitDrillGcode } from "@/lib/drillGcode";
import { planDrillRoute } from "@/lib/drillRoute";
import type { PanelDrillPlan } from "@/lib/panelDrill";
import type { CncProfile } from "@/lib/cncProfile";
import type { Tool } from "@/lib/toolLibrary";
import { segIntersectsRect } from "@/lib/keepoutGeometry";
import type { Rect } from "@/lib/keepoutGeometry";

const tool = (id: string, d: number, over: Partial<Tool> = {}): Tool => ({
  id, name: `Сверло ${d}`, kind: "drill", diameterMm: d, material: "carbide",
  recommendedRpm: 9000, recommendedFeedMmMin: 100, recommendedPlungeMmMin: 60, ...over,
});
const profile = (over: Partial<CncProfile> = {}): CncProfile => ({
  name: "t", port: null, baud: 115200, jogFeedMmMin: 500, jogStepsMm: [1],
  workEnvelopeMm: { x: 300, y: 180, z: 45 }, spindleMaxRpm: 9000,
  spindleControllable: true, spindleHasPwm: true,
  probeFeedMmMin: 50, probeMaxDistMm: 8, probePlateOffsetMm: 0, hasProbe: true,
  gcodeDialect: "grbl_1_1",
  safeZMm: 5, machineSafeZMm: -1, runoutMm: 0.15, backlashMm: { x: 0, y: 0, z: 0 },
  prependGcode: "", appendGcode: "", workZeroMm: null, ...over,
});
const plan = (groups: PanelDrillPlan["groups"]): PanelDrillPlan => ({
  groups, totalHoles: groups.reduce((n, g) => n + g.holes.length, 0), unmatchedDiametersMm: [],
  skippedInKeepout: 0, registrationInKeepout: 0,
});
const ctx = (over: Partial<Parameters<typeof emitDrillProgram>[1]> = {}) =>
  ({ panelHeightMm: 50, profile: profile(), substrateThicknessMm: 1.6, tools: [], ...over });

describe("emitDrillProgram", () => {
  const p = plan([
    { diameterMm: 3.0, class: "registration", toolId: "t3", holes: [{ xMm: 2, yMm: 2 }] },
    { diameterMm: 0.6, class: "pth", toolId: "t06", holes: [{ xMm: 1, yMm: 1 }, { xMm: 5, yMm: 5 }] },
  ]);
  const tools = [tool("t3", 3.0), tool("t06", 0.6)];

  it("gcode text is identical to emitDrillGcode", () => {
    const a = emitDrillProgram(p, ctx({ tools }));
    const b = emitDrillGcode(p, ctx({ tools }));
    expect(a.gcode).toBe(b.gcode);
    expect(a.skippedDiametersMm).toEqual(b.skippedDiametersMm);
  });

  it("hole steps carry holeIndex matching planDrillRoute order", () => {
    const { steps } = emitDrillProgram(p, ctx({ tools }));
    const route = planDrillRoute(p, { xMm: 0, yMm: 50 });
    const holeSteps = steps.filter((s) => s.kind === "hole");
    expect(holeSteps.length).toBe(route.pathPoints.length);
    holeSteps.forEach((s, i) => expect(s.holeIndex).toBe(i));
  });

  it("toolchange steps carry tool name + diameter and pause flag, never contain M0", () => {
    const { steps } = emitDrillProgram(p, ctx({ tools }));
    const tc = steps.filter((s) => s.kind === "toolchange");
    expect(tc.length).toBe(2);
    expect(tc[0]).toMatchObject({ pauseForToolChange: true, diameterMm: 3.0 });
    expect(tc[0].toolName).toContain("Сверло 3");
    steps.forEach((s) => s.lines.forEach((l) => expect(l).not.toBe("M0")));
  });

  it("spindle-up precedes the first hole of each group in run steps", () => {
    const { steps } = emitDrillProgram(p, ctx({ tools }));
    const firstHole = steps.find((s) => s.kind === "hole")!;
    expect(firstHole.lines.some((l) => /^M3( S\d+)?$/.test(l))).toBe(true);
  });

  it("omits skipped groups from steps but reports their diameter", () => {
    const sp = plan([{ diameterMm: 0.7, class: "pth", toolId: null, holes: [{ xMm: 0, yMm: 0 }] }]);
    const { steps, skippedDiametersMm } = emitDrillProgram(sp, ctx({ tools: [] }));
    expect(skippedDiametersMm).toEqual([0.7]);
    expect(steps.filter((s) => s.kind === "hole")).toHaveLength(0);
  });

  it("run steps never contain M2 (program end handled by runner)", () => {
    const { steps } = emitDrillProgram(p, ctx({ tools }));
    steps.forEach((s) => expect(s.lines).not.toContain("M2"));
  });
});

// ---------------------------------------------------------------------------
// G-code detour waypoints via keepOutZones
// ---------------------------------------------------------------------------

describe("emitDrillGcode keepOutZones", () => {
  // Panel is 50mm tall.  Hole A is at panel (5, 25) → machine (5, 25).
  // Hole B is at panel (45, 25) → machine (45, 25).
  // Zone (panel-space): x=20, y=20, w=10, h=10 → machine: y=50-(20+10)=20, same w/h.
  // Straight traverse A→B in machine coords (5,25)→(45,25) passes through machine zone
  // (x 20-30, y 20-30) since y=25 is inside.
  const panelH = 50;
  const holeA = { xMm: 5, yMm: 25 };
  const holeB = { xMm: 45, yMm: 25 };
  const panelZone: Rect = { x: 20, y: 20, w: 10, h: 10 };

  const tp = (groups: PanelDrillPlan["groups"]): PanelDrillPlan => ({
    groups,
    totalHoles: groups.reduce((n, g) => n + g.holes.length, 0),
    unmatchedDiametersMm: [],
    skippedInKeepout: 0,
    registrationInKeepout: 0,
  });

  const tt = (id: string, d: number): Tool => ({
    id, name: `Drill ${d}`, kind: "drill", diameterMm: d, material: "carbide",
    recommendedRpm: 9000, recommendedFeedMmMin: 100, recommendedPlungeMmMin: 60,
  });

  const pp = (over: Partial<CncProfile> = {}): CncProfile => ({
    name: "t", port: null, baud: 115200, jogFeedMmMin: 500, jogStepsMm: [1],
    workEnvelopeMm: { x: 300, y: 180, z: 45 }, spindleMaxRpm: 9000,
    spindleControllable: true, spindleHasPwm: true,
    probeFeedMmMin: 50, probeMaxDistMm: 8, probePlateOffsetMm: 0, hasProbe: true,
    gcodeDialect: "grbl_1_1",
    safeZMm: 5, machineSafeZMm: -1, runoutMm: 0.15, backlashMm: { x: 0, y: 0, z: 0 },
    prependGcode: "", appendGcode: "", workZeroMm: null, ...over,
  });

  it("gcode is UNCHANGED without zones (byte-identical to no-zones call)", () => {
    const planObj = tp([
      { diameterMm: 0.8, class: "pth", toolId: "t1", holes: [holeA, holeB] },
    ]);
    const baseCtx = {
      panelHeightMm: panelH,
      profile: pp(),
      tools: [tt("t1", 0.8)],
      substrateThicknessMm: 1.6,
    };
    const withoutZones = emitDrillGcode(planObj, baseCtx);
    const emptyZones = emitDrillGcode(planObj, { ...baseCtx, keepOutZones: [] });
    expect(withoutZones.gcode).toBe(emptyZones.gcode);
  });

  it("emits extra G0 X Y waypoints when traverse crosses a zone", () => {
    const planObj = tp([
      { diameterMm: 0.8, class: "pth", toolId: "t1", holes: [holeA, holeB] },
    ]);
    const baseCtx = {
      panelHeightMm: panelH,
      profile: pp(),
      tools: [tt("t1", 0.8)],
      substrateThicknessMm: 1.6,
    };
    const withoutZones = emitDrillGcode(planObj, baseCtx);
    const withZones = emitDrillGcode(planObj, { ...baseCtx, keepOutZones: [panelZone] });

    // With zones the gcode must be different (extra waypoints inserted).
    expect(withZones.gcode).not.toBe(withoutZones.gcode);

    // Extra G0 X Y lines should appear (more rapids between holeA and holeB).
    const rapidLines = (g: string) =>
      g.split("\n").filter((l) => /^G0 X[\d.-]+ Y[\d.-]+$/.test(l.trim()));
    expect(rapidLines(withZones.gcode).length).toBeGreaterThan(
      rapidLines(withoutZones.gcode).length,
    );
  });

  it("no consecutive G0 X Y rapid pair crosses the machine-space zone", () => {
    const planObj = tp([
      { diameterMm: 0.8, class: "pth", toolId: "t1", holes: [holeA, holeB] },
    ]);
    const { gcode } = emitDrillGcode(planObj, {
      panelHeightMm: panelH,
      profile: pp(),
      tools: [tt("t1", 0.8)],
      substrateThicknessMm: 1.6,
      keepOutZones: [panelZone],
    });

    // Extract all lateral rapid points from the gcode in order.
    const rapidPts: { x: number; y: number }[] = [];
    for (const line of gcode.split("\n")) {
      const m = line.trim().match(/^G0 X([\d.-]+) Y([\d.-]+)$/);
      if (m) rapidPts.push({ x: parseFloat(m[1]), y: parseFloat(m[2]) });
    }

    // Machine-space zone (Y-flip: panel y=20..30 → machine y=50-30=20..50-20=30).
    const machineZone: Rect = { x: 20, y: 20, w: 10, h: 10 };
    const MARGIN = 1.0;
    const expanded: Rect = {
      x: machineZone.x - MARGIN,
      y: machineZone.y - MARGIN,
      w: machineZone.w + 2 * MARGIN,
      h: machineZone.h + 2 * MARGIN,
    };

    for (let i = 0; i < rapidPts.length - 1; i++) {
      const a = rapidPts[i];
      const b = rapidPts[i + 1];
      expect(segIntersectsRect(a, b, expanded)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Datum corner: coordinate sign and byte-identical default invariant
// ---------------------------------------------------------------------------

describe("emitDrillGcode datum corner", () => {
  const panelW = 100;
  const panelH = 50;
  // Interior hole: panel (30, 20)
  const holeInterior = { xMm: 30, yMm: 20 };
  // Second hole to check left/right ordering: panel (70, 20)
  const holeRight = { xMm: 70, yMm: 20 };

  const tl = (id: string, d: number): Tool => ({
    id, name: `Drill ${d}`, kind: "drill", diameterMm: d, material: "carbide",
    recommendedRpm: 9000, recommendedFeedMmMin: 100, recommendedPlungeMmMin: 60,
  });
  const pp = (): CncProfile => ({
    name: "t", port: null, baud: 115200, jogFeedMmMin: 500, jogStepsMm: [1],
    workEnvelopeMm: { x: 300, y: 180, z: 45 }, spindleMaxRpm: 9000,
    spindleControllable: true, spindleHasPwm: true,
    probeFeedMmMin: 50, probeMaxDistMm: 8, probePlateOffsetMm: 0, hasProbe: true,
    gcodeDialect: "grbl_1_1",
    safeZMm: 5, machineSafeZMm: -1, runoutMm: 0.15, backlashMm: { x: 0, y: 0, z: 0 },
    prependGcode: "", appendGcode: "", workZeroMm: null,
  });
  const tp = (holes: { xMm: number; yMm: number }[]): PanelDrillPlan => ({
    groups: [{ diameterMm: 0.8, class: "pth", toolId: "t1", holes }],
    totalHoles: holes.length,
    unmatchedDiametersMm: [],
    skippedInKeepout: 0,
    registrationInKeepout: 0,
  });

  const baseCtx = {
    panelHeightMm: panelH,
    panelWidthMm: panelW,
    profile: pp(),
    tools: [tl("t1", 0.8)],
    substrateThicknessMm: 1.6,
  };

  it("default (no datum) output is byte-identical to explicit bottom-left", () => {
    const noD  = emitDrillGcode(tp([holeInterior]), { ...baseCtx });
    const botL = emitDrillGcode(tp([holeInterior]), { ...baseCtx, datumCorner: "bottom-left" });
    expect(noD.gcode).toBe(botL.gcode);
  });

  it("default bottom-left matches explicit bottom-left with panelWidthMm=0 (legacy no-width call)", () => {
    // When panelWidthMm is omitted entirely (legacy callers), bottom-left is unaffected.
    const legacy  = emitDrillGcode(tp([holeInterior]), { panelHeightMm: panelH, profile: pp(), tools: [tl("t1", 0.8)], substrateThicknessMm: 1.6 });
    const explicit = emitDrillGcode(tp([holeInterior]), { ...baseCtx, datumCorner: "bottom-left" });
    expect(legacy.gcode).toBe(explicit.gcode);
  });

  it("top-left: interior hole has negative machine Y and X unchanged", () => {
    const { gcode } = emitDrillGcode(tp([holeInterior]), { ...baseCtx, datumCorner: "top-left" });
    // machineX = 30 - 0 = 30, machineY = 0 - 20 = -20
    expect(gcode).toContain("G0 X30.000 Y-20.000");
  });

  it("bottom-right: interior hole has negative machine X and Y unchanged relative to H", () => {
    const { gcode } = emitDrillGcode(tp([holeInterior]), { ...baseCtx, datumCorner: "bottom-right" });
    // machineX = 30 - 100 = -70, machineY = 50 - 20 = 30
    expect(gcode).toContain("G0 X-70.000 Y30.000");
  });

  it("top-right: interior hole has negative X and negative Y", () => {
    const { gcode } = emitDrillGcode(tp([holeInterior]), { ...baseCtx, datumCorner: "top-right" });
    // machineX = 30 - 100 = -70, machineY = 0 - 20 = -20
    expect(gcode).toContain("G0 X-70.000 Y-20.000");
  });

  it("no mirroring: machineX(panelX=30) < machineX(panelX=70) for all datums (X never flips)", () => {
    // machineX = x - (right ? W : 0), which is a pure translation in X.
    // holeInterior at panel x=30 → machineX = 30 or 30-100 = -70
    // holeRight    at panel x=70 → machineX = 70 or 70-100 = -30
    // In both cases machineX(30) < machineX(70) regardless of datum.
    const datums = ["bottom-left", "bottom-right", "top-left", "top-right"] as const;
    for (const d of datums) {
      const { gcode: gcLeft }  = emitDrillGcode(tp([holeInterior]), { ...baseCtx, datumCorner: d });
      const { gcode: gcRight } = emitDrillGcode(tp([holeRight]),    { ...baseCtx, datumCorner: d });
      const xLeft  = parseFloat(gcLeft.split("\n").find((l) => /^G0 X/.test(l.trim()))!.match(/X([\d.-]+)/)![1]);
      const xRight = parseFloat(gcRight.split("\n").find((l) => /^G0 X/.test(l.trim()))!.match(/X([\d.-]+)/)![1]);
      expect(xLeft).toBeLessThan(xRight);
    }
  });
});

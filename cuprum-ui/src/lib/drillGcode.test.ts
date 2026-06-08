import { describe, expect, it } from "vitest";
import { emitDrillGcode } from "@/lib/drillGcode";
import type { PanelDrillPlan } from "@/lib/panelDrill";
import type { CncProfile } from "@/lib/cncProfile";
import type { Tool } from "@/lib/toolLibrary";

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
  safeZMm: 5, machineSafeZMm: -1, toolChangeZMm: 20, runoutMm: 0.15, backlashMm: { x: 0, y: 0, z: 0 },
  prependGcode: "", appendGcode: "", workZeroMm: null, ...over,
});

const plan = (groups: PanelDrillPlan["groups"]): PanelDrillPlan => ({
  groups, totalHoles: groups.reduce((n, g) => n + g.holes.length, 0), unmatchedDiametersMm: [],
  skippedInKeepout: 0, registrationInKeepout: 0,
});

describe("emitDrillGcode", () => {
  it("emits a GRBL-valid single-tool program with Y-flip, depth, safe-Z retracts", () => {
    const p = plan([
      { diameterMm: 0.8, class: "pth", toolId: "t1", holes: [{ xMm: 10, yMm: 20 }] },
    ]);
    const { gcode, skippedDiametersMm } = emitDrillGcode(p, {
      panelHeightMm: 100, profile: profile(), tools: [tool("t1", 0.8)],
      substrateThicknessMm: 1.6,
    });
    expect(skippedDiametersMm).toEqual([]);
    // mm + absolute preamble
    expect(gcode).toContain("G21 G90");
    // panel (10,20) → machine (10, 100-20=80)
    expect(gcode).toContain("G0 X10.000 Y80.000");
    // plunge to -(1.6+0.3) at plunge feed, then retract to safe Z
    expect(gcode).toContain("G1 Z-1.900 F60");
    expect(gcode).toContain("G0 Z5.000");
    // spindle controllable → M3 S(clamped), tool-change pause, end
    expect(gcode).toContain("M3 S9000");
    expect(gcode).toContain("M0");
    expect(gcode.trimEnd().endsWith("M2")).toBe(true);
  });

  it("retracts to tool-change Z before each tool change, safe-Z between holes", () => {
    const p = plan([
      { diameterMm: 0.8, class: "pth", toolId: "t1", holes: [{ xMm: 1, yMm: 1 }] },
      { diameterMm: 1.0, class: "pth", toolId: "t2", holes: [{ xMm: 2, yMm: 2 }] },
    ]);
    const { gcode } = emitDrillGcode(p, {
      panelHeightMm: 10, profile: profile({ safeZMm: 3, toolChangeZMm: 25 }),
      tools: [tool("t1", 0.8), tool("t2", 1.0)], substrateThicknessMm: 1.6,
    });
    // The second group's tool-change retracts to the high tool-change Z.
    expect(gcode).toContain("G0 Z25.000");
    // Per-hole retract stays at safe-Z.
    expect(gcode).toContain("G0 Z3.000");
    // The preamble no longer parks Z (work-Z is unbound until the first probe), so
    // the FIRST Z move is the first hole's safe-Z retract; the high tool-change Z
    // shows up only at the second group's tool change, after the first hole drilled.
    const firstZ = gcode.indexOf("G0 Z");
    expect(gcode.slice(firstZ, firstZ + 9)).toBe("G0 Z3.000");
    expect(gcode.indexOf("G0 Z25.000")).toBeGreaterThan(gcode.indexOf("G1 Z-"));
  });

  it("emits no Z park in the preamble (work-Z is unbound until the first probe)", () => {
    // Regression: a work-frame Z park here tripped the Z soft limit → ALARM:2 on
    // start, because the per-tool-Z model binds work-Z only at the first tool change.
    const p = plan([{ diameterMm: 0.8, class: "pth", toolId: "t1", holes: [{ xMm: 0, yMm: 0 }] }]);
    const { gcode } = emitDrillGcode(p, {
      panelHeightMm: 10, profile: profile({ safeZMm: 3, toolChangeZMm: 25 }),
      tools: [tool("t1", 0.8)], substrateThicknessMm: 1.6,
    });
    // Single group → the high tool-change Z must never appear (no preamble park, and
    // the first group's tool change skips its retract).
    expect(gcode).not.toContain("G0 Z25.000");
    // The preamble line is followed directly by a lateral move / spindle-up, not a Z park.
    const afterPreamble = gcode.slice(gcode.indexOf("G21 G90 G94 G17") + "G21 G90 G94 G17".length);
    expect(afterPreamble.trimStart().startsWith("G0 Z")).toBe(false);
  });

  it("lifts to safe Z before the first traverse of every group", () => {
    // Regression: after a tool-change touch-off the bit sits at the surface (manual
    // touch-off sets work-Z 0 and never retracts; the probe retract is fire-and-forget
    // and may not finish). The program must raise to safe Z itself before the first
    // XY move of each group, or it drags the bit across the board. Holds for both the
    // first group (no work-frame retract in its tool change) and later groups.
    const p = plan([
      { diameterMm: 0.8, class: "pth", toolId: "t1", holes: [{ xMm: 1, yMm: 1 }] },
      { diameterMm: 1.0, class: "pth", toolId: "t2", holes: [{ xMm: 2, yMm: 2 }] },
    ]);
    const { gcode } = emitDrillGcode(p, {
      panelHeightMm: 10, profile: profile({ safeZMm: 4, toolChangeZMm: 25 }),
      tools: [tool("t1", 0.8), tool("t2", 1.0)], substrateThicknessMm: 1.6,
    });
    const ls = gcode.split("\n").map((l) => l.trim()).filter(Boolean);
    // Every group's first lateral move is immediately preceded by a safe-Z lift.
    ls.forEach((l, i) => {
      if (/^M3/.test(l)) {
        // The spindle-up marks a group start; a safe-Z lift sits just above it.
        const before = ls.slice(0, i).reverse();
        const firstZ = before.find((x) => /^G[01] Z/.test(x));
        expect(firstZ).toBe("G0 Z4.000");
      }
    });
    // First lateral of the program: a safe-Z lift precedes it (nothing drilled yet).
    const firstXY = ls.findIndex((l) => /^G0 X/.test(l));
    const priorZ = ls.slice(0, firstXY).reverse().find((x) => /^G[01] Z/.test(x));
    expect(priorZ).toBe("G0 Z4.000");
  });

  it("orders groups registration-first then by ascending diameter", () => {
    const p = plan([
      { diameterMm: 3.0, class: "mechanical", toolId: "t3", holes: [{ xMm: 0, yMm: 0 }] },
      { diameterMm: 0.6, class: "pth", toolId: "t06", holes: [{ xMm: 1, yMm: 1 }] },
      { diameterMm: 3.0, class: "registration", toolId: "t3", holes: [{ xMm: 2, yMm: 2 }] },
    ]);
    const { gcode } = emitDrillGcode(p, {
      panelHeightMm: 50, profile: profile(), substrateThicknessMm: 1.6,
      tools: [tool("t3", 3.0), tool("t06", 0.6)],
    });
    const iReg = gcode.indexOf("Сверло 3"); // registration group (3.0) comes first
    const iPth = gcode.indexOf("Сверло 0.6");
    expect(iReg).toBeGreaterThanOrEqual(0);
    expect(iReg).toBeLessThan(iPth); // registration before the smaller pth
  });

  it("uncontrollable spindle → bare M3 + a recommended-rpm comment, no S word", () => {
    const p = plan([{ diameterMm: 0.8, class: "pth", toolId: "t1", holes: [{ xMm: 0, yMm: 0 }] }]);
    const { gcode } = emitDrillGcode(p, {
      panelHeightMm: 10, profile: profile({ spindleControllable: false }),
      tools: [tool("t1", 0.8)], substrateThicknessMm: 1.6,
    });
    expect(gcode).toMatch(/\(set spindle ~9000 rpm\)/);
    expect(gcode).toContain("\nM3\n");
    expect(gcode).not.toMatch(/M3 S/);
  });

  it("skips groups with no tool and reports their diameters", () => {
    const p = plan([{ diameterMm: 0.7, class: "pth", toolId: null, holes: [{ xMm: 0, yMm: 0 }, { xMm: 1, yMm: 1 }] }]);
    const { gcode, skippedDiametersMm } = emitDrillGcode(p, {
      panelHeightMm: 10, profile: profile(), tools: [], substrateThicknessMm: 1.6,
    });
    expect(skippedDiametersMm).toEqual([0.7]);
    expect(gcode).toMatch(/\(SKIP: no tool for D0\.700/);
    expect(gcode).not.toMatch(/G1 Z/); // nothing drilled
  });

  it("wraps prepend/append G-code", () => {
    const p = plan([{ diameterMm: 0.8, class: "pth", toolId: "t1", holes: [{ xMm: 0, yMm: 0 }] }]);
    const { gcode } = emitDrillGcode(p, {
      panelHeightMm: 10, substrateThicknessMm: 1.6, tools: [tool("t1", 0.8)],
      profile: profile({ prependGcode: "; HELLO", appendGcode: "; BYE" }),
    });
    expect(gcode.startsWith("; HELLO")).toBe(true);
    expect(gcode).toContain("; BYE");
    expect(gcode.indexOf("; BYE")).toBeLessThan(gcode.indexOf("M2"));
  });

  it("peck breaks the plunge into increments with retracts", () => {
    const p = plan([{ diameterMm: 0.8, class: "pth", toolId: "t1", holes: [{ xMm: 0, yMm: 0 }] }]);
    const { gcode } = emitDrillGcode(p, {
      panelHeightMm: 10, substrateThicknessMm: 1.6, tools: [tool("t1", 0.8)],
      profile: profile(), opts: { peckDepthMm: 0.8 }, // depth 1.9 → pecks at 0.8,1.6,1.9
    });
    expect(gcode).toContain("G1 Z-0.800 F60");
    expect(gcode).toContain("G1 Z-1.600 F60");
    expect(gcode).toContain("G1 Z-1.900 F60");
  });

  it("never rapids laterally while at depth", () => {
    const p = plan([{ diameterMm: 0.8, class: "pth", toolId: "t1", holes: [{ xMm: 0, yMm: 0 }, { xMm: 5, yMm: 5 }] }]);
    const { gcode } = emitDrillGcode(p, { panelHeightMm: 20, profile: profile(), tools: [tool("t1", 0.8)], substrateThicknessMm: 1.6 });
    const ls = gcode.split("\n").map((l) => l.trim()).filter(Boolean);
    ls.forEach((l, i) => {
      if (/^G0 [XY]/.test(l)) {
        const prevZ = ls.slice(0, i).reverse().find((x) => /^G[01] Z/.test(x)) ?? "";
        // If a Z move preceded this lateral, it must be a retract (never a plunge).
        // Every group's first lateral is now preceded by a safe-Z lift, so the very
        // first lateral too has a prior Z move — and it must be a G0 Z retract.
        if (prevZ) expect(prevZ).toMatch(/^G0 Z/);
      }
    });
  });

  it("routes the first traverse around a keep-out zone from the real start position", () => {
    // One hole at panel (90,10) → machine (90,90) on a 100mm-tall panel.
    // A keep-out zone (panel {85,60,10,20} → machine x[85,95] y[20,40]) sits below it.
    const p = plan([{ diameterMm: 0.8, class: "pth", toolId: "t1", holes: [{ xMm: 90, yMm: 10 }] }]);
    const ctx = {
      panelHeightMm: 100,
      profile: profile(),
      tools: [tool("t1", 0.8)],
      substrateThicknessMm: 1.6,
      keepOutZones: [{ x: 85, y: 60, w: 10, h: 20 }],
    };
    const countXY = (g: string) => g.split("\n").filter((l) => /^G0 X/.test(l.trim())).length;

    // Default start (0,0): the straight line to (90,90) clears the zone — no detour.
    const flat = emitDrillGcode(p, ctx).gcode;
    expect(flat).toContain("G0 X90.000 Y90.000");
    expect(countXY(flat)).toBe(1);

    // Real start at machine (90,0): the straight line up to (90,90) crosses the
    // zone, so a detour waypoint must be inserted before the hole.
    const detoured = emitDrillGcode(p, { ...ctx, startMachineXY: { x: 90, y: 0 } }).gcode;
    expect(detoured).toContain("G0 X90.000 Y90.000");
    expect(countXY(detoured)).toBeGreaterThan(1);
  });
});

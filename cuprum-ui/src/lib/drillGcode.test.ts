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
  spindleControllable: true, spindleHasPwm: true, gcodeDialect: "grbl_1_1",
  safeZMm: 5, runoutMm: 0.15, backlashMm: { x: 0, y: 0, z: 0 },
  prependGcode: "", appendGcode: "", workZeroMm: null, ...over,
});

const plan = (groups: PanelDrillPlan["groups"]): PanelDrillPlan => ({
  groups, totalHoles: groups.reduce((n, g) => n + g.holes.length, 0), unmatchedDiametersMm: [],
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
        expect(prevZ).toMatch(/^G0 Z/); // last Z move before a lateral rapid was a retract
      }
    });
  });
});

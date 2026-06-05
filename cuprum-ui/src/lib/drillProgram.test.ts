import { describe, expect, it } from "vitest";
import { emitDrillProgram, emitDrillGcode } from "@/lib/drillGcode";
import { planDrillRoute } from "@/lib/drillRoute";
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

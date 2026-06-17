import { describe, it, expect } from "vitest";
import { stepMetaLine, type StepMetaLabels } from "./stepMetaLine";
import type { OperationRun } from "@/lib/api";

const L: StepMetaLabels = {
  holes: "отв.",
  tools: (n) => `${n} св.`,
  dur: { h: "ч", m: "м", s: "с" },
  sec: "с",
  side: (s) => (s === "top" ? "Верх" : "Низ"),
};

function run(p: Partial<OperationRun>): OperationRun {
  return {
    runUid: "u",
    projectPath: "/p",
    opType: "drill",
    startedAt: 0,
    endedAt: 100,
    outcome: "completed",
    progressTotal: 84,
    progressDone: 84,
    paramsJson: "{}",
    summaryJson: null,
    ...p,
  };
}

describe("stepMetaLine", () => {
  it("null run → null", () => {
    expect(stepMetaLine(null, L)).toBeNull();
  });
  it("drill: holes + tools + estimate", () => {
    const r = run({ opType: "drill", progressTotal: 84, paramsJson: JSON.stringify({ toolCount: 2, estimateSec: 74 }) });
    expect(stepMetaLine(r, L)).toBe("84 отв. · 2 св. · ≈ 1 м 14 с");
  });
  it("drill: holes only when params empty", () => {
    const r = run({ opType: "drill", progressTotal: 84, paramsJson: "{}" });
    expect(stepMetaLine(r, L)).toBe("84 отв.");
  });
  it("drill: skips zero/absent estimate", () => {
    const r = run({ opType: "drill", progressTotal: 10, paramsJson: JSON.stringify({ toolCount: 1, estimateSec: 0 }) });
    expect(stepMetaLine(r, L)).toBe("10 отв. · 1 св.");
  });
  it("drill: malformed params → holes only, no crash", () => {
    const r = run({ opType: "drill", progressTotal: 12, paramsJson: "{not json" });
    expect(stepMetaLine(r, L)).toBe("12 отв.");
  });
  it("expose: side + exposure seconds", () => {
    const r = run({ opType: "expose", progressTotal: null, paramsJson: JSON.stringify({ side: "top", exposureS: 45 }) });
    expect(stepMetaLine(r, L)).toBe("Верх · 45 с");
  });
  it("expose: bottom only when no exposure", () => {
    const r = run({ opType: "expose", progressTotal: null, paramsJson: JSON.stringify({ side: "bottom" }) });
    expect(stepMetaLine(r, L)).toBe("Низ");
  });
  it("mill → null", () => {
    const r = run({ opType: "mill", progressTotal: null, paramsJson: "{}" });
    expect(stepMetaLine(r, L)).toBeNull();
  });
  it("drill with nothing extractable → null", () => {
    const r = run({ opType: "drill", progressTotal: null, paramsJson: "{}" });
    expect(stepMetaLine(r, L)).toBeNull();
  });
});

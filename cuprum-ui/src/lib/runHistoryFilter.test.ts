import { describe, it, expect } from "vitest";
import {
  statusKey,
  filterRuns,
  statusCounts,
  groupByDay,
  runMetaLine,
} from "./runHistoryFilter";
import type { OperationRun } from "@/lib/api";

function run(p: Partial<OperationRun>): OperationRun {
  return {
    runUid: Math.random().toString(36),
    projectPath: "/p",
    opType: "drill",
    startedAt: 1_000_000,
    endedAt: 1_000_060,
    outcome: "completed",
    progressTotal: 84,
    progressDone: 84,
    paramsJson: "{}",
    summaryJson: null,
    ...p,
  };
}

const labels = { holes: "Отв.", tools: "Свёрла", typeLabel: (op: string) => op };

describe("statusKey", () => {
  it("maps error and interrupted both to 'interrupted'", () => {
    expect(statusKey("error")).toBe("interrupted");
    expect(statusKey("interrupted")).toBe("interrupted");
  });
  it("passes completed/stopped through, null → running", () => {
    expect(statusKey("completed")).toBe("completed");
    expect(statusKey("stopped")).toBe("stopped");
    expect(statusKey(null)).toBe("running");
  });
});

describe("filterRuns", () => {
  const runs = [
    run({ opType: "drill", outcome: "completed" }),
    run({ opType: "drill", outcome: "error" }),
    run({ opType: "mill", outcome: "stopped" }),
  ];

  it("selStep narrows by opType", () => {
    expect(filterRuns({ runs, selStep: "mill", status: "all", query: "", labels }).length).toBe(1);
  });
  it("status 'interrupted' catches error", () => {
    const r = filterRuns({ runs, selStep: null, status: "interrupted", query: "", labels });
    expect(r.length).toBe(1);
    expect(r[0].outcome).toBe("error");
  });
  it("query matches the type label", () => {
    const r = filterRuns({ runs, selStep: null, status: "all", query: "mill", labels });
    expect(r.length).toBe(1);
  });
  it("query matches meta content (progress count)", () => {
    const meta = [run({ progressTotal: 84 }), run({ progressTotal: 12 })];
    const r = filterRuns({ runs: meta, selStep: null, status: "all", query: "84", labels });
    expect(r.length).toBe(1);
    expect(r[0].progressTotal).toBe(84);
  });
});

describe("runMetaLine", () => {
  const L = { holes: "Отв.", tools: "Свёрла" };
  it("joins holes and tool count from progress + params", () => {
    const r = run({ progressTotal: 84, paramsJson: JSON.stringify({ toolCount: 3 }) });
    expect(runMetaLine(r, L)).toBe("Отв. 84 · Свёрла 3");
  });
  it("empty when no progress and no toolCount", () => {
    const r = run({ progressTotal: null, paramsJson: "{}" });
    expect(runMetaLine(r, L)).toBe("");
  });
  it("swallows malformed params and keeps the holes part", () => {
    const r = run({ progressTotal: 12, paramsJson: "{not json" });
    expect(runMetaLine(r, L)).toBe("Отв. 12");
  });
});

describe("statusCounts", () => {
  it("counts per status key over the base set", () => {
    const base = [
      run({ outcome: "completed" }),
      run({ outcome: "completed" }),
      run({ outcome: "stopped" }),
      run({ outcome: "error" }),
    ];
    expect(statusCounts(base)).toEqual({ all: 4, completed: 2, stopped: 1, interrupted: 1 });
  });
});

describe("groupByDay", () => {
  it("preserves order and groups consecutive same-day runs", () => {
    const now = new Date(2026, 5, 17, 12, 0, 0).getTime() / 1000;
    const today = new Date(2026, 5, 17, 9, 0, 0).getTime() / 1000;
    const sixAgo = new Date(2026, 5, 11, 9, 0, 0).getTime() / 1000;
    const rows = [run({ startedAt: today }), run({ startedAt: sixAgo })];
    const groups = groupByDay(rows, now);
    expect(groups.map((g) => g.days)).toEqual([0, 6]);
    expect(groups[0].runs.length).toBe(1);
  });
});

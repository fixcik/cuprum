import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  drillRunReducer,
  initialDrillRunState,
  type DrillRunState,
} from "@/lib/drillRunState";

describe("drillRunReducer", () => {
  // 1. start sets phase running, holesTotal, zeroes completed, clears error/toolChange
  it("start: sets phase=running, holesTotal, zeroes completed, clears error and toolChange", () => {
    const withPrior: DrillRunState = {
      ...initialDrillRunState,
      phase: "error",
      holesCompleted: 5,
      holesTotal: 10,
      error: "some error",
      toolChange: { toolName: "Сверло 0.8", diameterMm: 0.8 },
    };
    const next = drillRunReducer(withPrior, { type: "start", holesTotal: 20 });
    expect(next.phase).toBe("running");
    expect(next.holesTotal).toBe(20);
    expect(next.holesCompleted).toBe(0);
    expect(next.currentHoleIndex).toBeNull();
    expect(next.error).toBeNull();
    expect(next.toolChange).toBeNull();
  });

  // 2. toolchange → phase awaitingToolChange and carries toolName, diameterMm
  it("toolchange: sets phase=awaitingToolChange and stores toolChange payload", () => {
    const running: DrillRunState = {
      ...initialDrillRunState,
      phase: "running",
      holesTotal: 10,
      holesCompleted: 3,
    };
    const next = drillRunReducer(running, {
      type: "toolchange",
      toolName: "Сверло 1.0",
      diameterMm: 1.0,
    });
    expect(next.phase).toBe("awaitingToolChange");
    expect(next.toolChange).toEqual({ toolName: "Сверло 1.0", diameterMm: 1.0 });
    // counters unchanged
    expect(next.holesCompleted).toBe(3);
    expect(next.holesTotal).toBe(10);
  });

  // 3. From awaitingToolChange, progress event → phase running, toolChange null, counters updated
  it("progress from awaitingToolChange: resumes running, clears toolChange, updates counters", () => {
    const awaiting: DrillRunState = {
      ...initialDrillRunState,
      phase: "awaitingToolChange",
      holesTotal: 10,
      holesCompleted: 3,
      toolChange: { toolName: "Сверло 1.0", diameterMm: 1.0 },
    };
    const next = drillRunReducer(awaiting, {
      type: "progress",
      holesCompleted: 4,
      holeIndex: 7,
    });
    expect(next.phase).toBe("running");
    expect(next.toolChange).toBeNull();
    expect(next.holesCompleted).toBe(4);
    expect(next.currentHoleIndex).toBe(7);
    // holesTotal must not change
    expect(next.holesTotal).toBe(10);
  });

  // 3b. progress while paused → phase stays paused, counters updated
  it("progress from paused: keeps phase=paused, updates holesCompleted and currentHoleIndex", () => {
    const paused: DrillRunState = {
      ...initialDrillRunState,
      phase: "paused",
      holesTotal: 10,
      holesCompleted: 3,
      currentHoleIndex: 5,
      toolChange: null,
    };
    const next = drillRunReducer(paused, {
      type: "progress",
      holesCompleted: 4,
      holeIndex: 6,
    });
    expect(next.phase).toBe("paused");
    expect(next.holesCompleted).toBe(4);
    expect(next.currentHoleIndex).toBe(6);
    expect(next.holesTotal).toBe(10);
  });

  // 3c. progress while running → phase stays running
  it("progress from running: keeps phase=running, updates counters", () => {
    const running: DrillRunState = {
      ...initialDrillRunState,
      phase: "running",
      holesTotal: 10,
      holesCompleted: 2,
      currentHoleIndex: 3,
      toolChange: null,
    };
    const next = drillRunReducer(running, {
      type: "progress",
      holesCompleted: 3,
      holeIndex: 4,
    });
    expect(next.phase).toBe("running");
    expect(next.holesCompleted).toBe(3);
    expect(next.currentHoleIndex).toBe(4);
  });

  // 4. error → phase error + message preserved
  it("error: sets phase=error and stores message", () => {
    const running: DrillRunState = {
      ...initialDrillRunState,
      phase: "running",
      holesTotal: 5,
      holesCompleted: 2,
    };
    const next = drillRunReducer(running, { type: "error", message: "Alarm 1" });
    expect(next.phase).toBe("error");
    expect(next.error).toBe("Alarm 1");
    // counters preserved
    expect(next.holesCompleted).toBe(2);
    expect(next.holesTotal).toBe(5);
  });

  // 5. done → phase done, currentHoleIndex null, toolChange null
  it("done: sets phase=done, clears currentHoleIndex and toolChange", () => {
    const running: DrillRunState = {
      ...initialDrillRunState,
      phase: "running",
      holesTotal: 5,
      holesCompleted: 5,
      currentHoleIndex: 4,
      toolChange: { toolName: "Сверло 0.8", diameterMm: 0.8 },
    };
    const next = drillRunReducer(running, { type: "done" });
    expect(next.phase).toBe("done");
    expect(next.currentHoleIndex).toBeNull();
    expect(next.toolChange).toBeNull();
    expect(next.holesCompleted).toBe(5);
    expect(next.holesTotal).toBe(5);
  });

  // 6. pause/resume via state: keeps counters, state{running} clears toolChange
  it("state{paused}: sets phase=paused, keeps counters and toolChange", () => {
    const running: DrillRunState = {
      ...initialDrillRunState,
      phase: "running",
      holesTotal: 10,
      holesCompleted: 4,
      currentHoleIndex: 6,
      toolChange: null,
    };
    const next = drillRunReducer(running, { type: "state", phase: "paused" });
    expect(next.phase).toBe("paused");
    expect(next.holesCompleted).toBe(4);
    expect(next.holesTotal).toBe(10);
    expect(next.currentHoleIndex).toBe(6);
  });

  it("state{running}: sets phase=running, clears toolChange, keeps counters", () => {
    const paused: DrillRunState = {
      ...initialDrillRunState,
      phase: "paused",
      holesTotal: 10,
      holesCompleted: 4,
      currentHoleIndex: 6,
      toolChange: { toolName: "Сверло 0.8", diameterMm: 0.8 },
    };
    const next = drillRunReducer(paused, { type: "state", phase: "running" });
    expect(next.phase).toBe("running");
    expect(next.toolChange).toBeNull();
    expect(next.holesCompleted).toBe(4);
    expect(next.holesTotal).toBe(10);
    expect(next.currentHoleIndex).toBe(6);
  });

  it("state{done}: sets phase=done, clears currentHoleIndex and toolChange, keeps counters", () => {
    const running: DrillRunState = {
      ...initialDrillRunState,
      phase: "running",
      holesTotal: 10,
      holesCompleted: 10,
      currentHoleIndex: 9,
      toolChange: { toolName: "Сверло 0.8", diameterMm: 0.8 },
    };
    const next = drillRunReducer(running, { type: "state", phase: "done" });
    expect(next.phase).toBe("done");
    expect(next.currentHoleIndex).toBeNull();
    expect(next.toolChange).toBeNull();
    expect(next.holesCompleted).toBe(10);
    expect(next.holesTotal).toBe(10);
  });

  // 6b. pausing/stopping intermediate states
  it("state{pausing} from running: sets phase=pausing, keeps counters", () => {
    const running: DrillRunState = {
      ...initialDrillRunState,
      phase: "running",
      holesTotal: 10,
      holesCompleted: 4,
      currentHoleIndex: 6,
    };
    const next = drillRunReducer(running, { type: "state", phase: "pausing" });
    expect(next.phase).toBe("pausing");
    expect(next.holesCompleted).toBe(4);
    expect(next.holesTotal).toBe(10);
    expect(next.currentHoleIndex).toBe(6);
  });

  it("state{paused} from pausing: transitions to paused, keeps counters", () => {
    const pausing: DrillRunState = {
      ...initialDrillRunState,
      phase: "pausing",
      holesTotal: 10,
      holesCompleted: 4,
      currentHoleIndex: 6,
    };
    const next = drillRunReducer(pausing, { type: "state", phase: "paused" });
    expect(next.phase).toBe("paused");
    expect(next.holesCompleted).toBe(4);
    expect(next.holesTotal).toBe(10);
  });

  it("state{running} from pausing: resumes running, clears toolChange", () => {
    const pausing: DrillRunState = {
      ...initialDrillRunState,
      phase: "pausing",
      holesTotal: 10,
      holesCompleted: 4,
      currentHoleIndex: 6,
      toolChange: null,
    };
    const next = drillRunReducer(pausing, { type: "state", phase: "running" });
    expect(next.phase).toBe("running");
    expect(next.toolChange).toBeNull();
    expect(next.holesCompleted).toBe(4);
  });

  it("state{stopping} from running: sets phase=stopping, keeps counters", () => {
    const running: DrillRunState = {
      ...initialDrillRunState,
      phase: "running",
      holesTotal: 10,
      holesCompleted: 5,
      currentHoleIndex: 7,
    };
    const next = drillRunReducer(running, { type: "state", phase: "stopping" });
    expect(next.phase).toBe("stopping");
    expect(next.holesCompleted).toBe(5);
    expect(next.holesTotal).toBe(10);
    expect(next.currentHoleIndex).toBe(7);
  });

  it("state{idle} from stopping: transitions to idle, keeps counters", () => {
    const stopping: DrillRunState = {
      ...initialDrillRunState,
      phase: "stopping",
      holesTotal: 10,
      holesCompleted: 5,
      currentHoleIndex: 7,
    };
    const next = drillRunReducer(stopping, { type: "state", phase: "idle" });
    expect(next.phase).toBe("idle");
    expect(next.holesCompleted).toBe(5);
    expect(next.holesTotal).toBe(10);
  });

  // 7. reset returns initial state
  it("reset: returns initialDrillRunState regardless of current state", () => {
    const messy: DrillRunState = {
      phase: "error",
      holesCompleted: 7,
      holesTotal: 10,
      currentHoleIndex: 3,
      toolChange: { toolName: "Сверло 1.2", diameterMm: 1.2 },
      zBound: true,
      toolChangeSeq: 3,
      error: "something went wrong",
      runStartedAt: 1234567890,
    };
    const next = drillRunReducer(messy, { type: "reset" });
    expect(next).toEqual(initialDrillRunState);
  });

  // 8. runStartedAt is set on start and cleared on reset
  describe("runStartedAt", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("start: sets runStartedAt to Date.now()", () => {
      vi.setSystemTime(1_000_000);
      const next = drillRunReducer(initialDrillRunState, { type: "start", holesTotal: 5 });
      expect(next.runStartedAt).toBe(1_000_000);
    });

    it("reset: clears runStartedAt to null", () => {
      const running: DrillRunState = { ...initialDrillRunState, phase: "running", holesTotal: 5, runStartedAt: 999 };
      const next = drillRunReducer(running, { type: "reset" });
      expect(next.runStartedAt).toBeNull();
    });

    it("initialDrillRunState has runStartedAt=null", () => {
      expect(initialDrillRunState.runStartedAt).toBeNull();
    });
  });

describe("drillRunReducer — zBound (per-tool Z gate)", () => {
  it("starts unbound", () => {
    expect(initialDrillRunState.zBound).toBe(false);
    const started = drillRunReducer(initialDrillRunState, { type: "start", holesTotal: 5 });
    expect(started.zBound).toBe(false);
  });

  it("zbound sets zBound true", () => {
    const s = drillRunReducer(initialDrillRunState, { type: "zbound" });
    expect(s.zBound).toBe(true);
  });

  it("entering a tool change clears zBound", () => {
    const bound = drillRunReducer(initialDrillRunState, { type: "zbound" });
    const tc = drillRunReducer(bound, { type: "toolchange", toolName: "0.8mm", diameterMm: 0.8 });
    expect(tc.phase).toBe("awaitingToolChange");
    expect(tc.zBound).toBe(false);
  });

  it("reset clears zBound", () => {
    const bound = drillRunReducer(initialDrillRunState, { type: "zbound" });
    expect(drillRunReducer(bound, { type: "reset" }).zBound).toBe(false);
  });
});

describe("drillRunReducer — toolChangeSeq (per-pause remount key)", () => {
  it("starts at 0", () => {
    expect(initialDrillRunState.toolChangeSeq).toBe(0);
  });

  it("increments on each toolchange event", () => {
    const first = drillRunReducer(initialDrillRunState, {
      type: "toolchange",
      toolName: "0.8mm",
      diameterMm: 0.8,
    });
    expect(first.toolChangeSeq).toBe(1);
    const second = drillRunReducer(first, {
      type: "toolchange",
      toolName: "1.0mm",
      diameterMm: 1.0,
    });
    expect(second.toolChangeSeq).toBe(2);
  });
});

  // 9. reducer does not mutate the input state object
  it("does not mutate the input state", () => {
    const original: DrillRunState = {
      ...initialDrillRunState,
      phase: "running",
      holesTotal: 5,
      holesCompleted: 2,
      currentHoleIndex: 1,
      runStartedAt: 123,
    };
    const snapshot = JSON.stringify(original);
    drillRunReducer(original, { type: "progress", holesCompleted: 3, holeIndex: 2 });
    drillRunReducer(original, { type: "toolchange", toolName: "T", diameterMm: 0.8 });
    drillRunReducer(original, { type: "error", message: "oops" });
    drillRunReducer(original, { type: "done" });
    drillRunReducer(original, { type: "reset" });
    drillRunReducer(original, { type: "state", phase: "paused" });
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

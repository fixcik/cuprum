import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  drillRunReducer,
  initialDrillRunState,
  isMachineRunning,
  machineElapsedMs,
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
      probeChecked: true,
      lastManualZMm: -42.5,
      toolChangeSeq: 3,
      error: "something went wrong",
      runStartedAt: 1234567890,
      machineActiveMs: 42000,
      activeSince: 1234567000,
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

  // 8b. Machine clock — "прошло" counts movement/drilling only, frozen on operator wait
  describe("machine clock (machineActiveMs / activeSince)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("isMachineRunning: true only for running/pausing/stopping", () => {
      expect(isMachineRunning("running")).toBe(true);
      expect(isMachineRunning("pausing")).toBe(true);
      expect(isMachineRunning("stopping")).toBe(true);
      expect(isMachineRunning("paused")).toBe(false);
      expect(isMachineRunning("awaitingToolChange")).toBe(false);
      expect(isMachineRunning("idle")).toBe(false);
      expect(isMachineRunning("done")).toBe(false);
      expect(isMachineRunning("error")).toBe(false);
    });

    it("machineElapsedMs: parked returns banked, running adds the in-flight interval, clamps ≥0", () => {
      expect(machineElapsedMs(5000, null, 9_999)).toBe(5000);
      expect(machineElapsedMs(5000, 1_000, 4_000)).toBe(8000);
      expect(machineElapsedMs(0, 2_000, 1_000)).toBe(0);
    });

    it("initialDrillRunState parks the clock", () => {
      expect(initialDrillRunState.machineActiveMs).toBe(0);
      expect(initialDrillRunState.activeSince).toBeNull();
    });

    it("start: runs the clock from runStartedAt", () => {
      vi.setSystemTime(1_000_000);
      const started = drillRunReducer(initialDrillRunState, { type: "start", holesTotal: 5 });
      expect(started.machineActiveMs).toBe(0);
      expect(started.activeSince).toBe(1_000_000);
    });

    it("running → tool change banks the interval and parks the clock", () => {
      vi.setSystemTime(1_000_000);
      const started = drillRunReducer(initialDrillRunState, { type: "start", holesTotal: 5 });
      vi.setSystemTime(1_010_000); // +10s of cutting
      const tc = drillRunReducer(started, { type: "toolchange", toolName: "T", diameterMm: 0.8 });
      expect(tc.phase).toBe("awaitingToolChange");
      expect(tc.machineActiveMs).toBe(10_000);
      expect(tc.activeSince).toBeNull();
    });

    it("the tool-change gap is excluded — clock resumes on progress without crediting the wait", () => {
      vi.setSystemTime(1_000_000);
      const started = drillRunReducer(initialDrillRunState, { type: "start", holesTotal: 5 });
      vi.setSystemTime(1_010_000); // +10s cutting
      const tc = drillRunReducer(started, { type: "toolchange", toolName: "T", diameterMm: 0.8 });
      vi.setSystemTime(1_040_000); // +30s operator swap — NOT machine time
      const resumed = drillRunReducer(tc, { type: "progress", holesCompleted: 1, holeIndex: 1 });
      expect(resumed.phase).toBe("running");
      expect(resumed.machineActiveMs).toBe(10_000); // gap not credited
      expect(resumed.activeSince).toBe(1_040_000);
      // machine elapsed 5s later = 10s banked + 5s in-flight, the 30s gap excluded
      expect(machineElapsedMs(resumed.machineActiveMs, resumed.activeSince, 1_045_000)).toBe(15_000);
    });

    it("manual pause freezes the clock too (state{paused} banks, state{running} resumes)", () => {
      vi.setSystemTime(1_000_000);
      const started = drillRunReducer(initialDrillRunState, { type: "start", holesTotal: 5 });
      vi.setSystemTime(1_008_000); // +8s cutting
      const paused = drillRunReducer(started, { type: "state", phase: "paused" });
      expect(paused.machineActiveMs).toBe(8_000);
      expect(paused.activeSince).toBeNull();
      vi.setSystemTime(1_050_000); // +42s parked
      const running = drillRunReducer(paused, { type: "state", phase: "running" });
      expect(running.machineActiveMs).toBe(8_000); // pause not credited
      expect(running.activeSince).toBe(1_050_000);
    });

    it("pausing keeps the clock running (still cutting the current hole)", () => {
      vi.setSystemTime(1_000_000);
      const started = drillRunReducer(initialDrillRunState, { type: "start", holesTotal: 5 });
      const pausing = drillRunReducer(started, { type: "state", phase: "pausing" });
      expect(pausing.machineActiveMs).toBe(0);
      expect(pausing.activeSince).toBe(1_000_000); // unchanged — clock still running
    });

    it("done banks the final interval and freezes elapsed", () => {
      vi.setSystemTime(1_000_000);
      const started = drillRunReducer(initialDrillRunState, { type: "start", holesTotal: 5 });
      vi.setSystemTime(1_025_000); // +25s
      const done = drillRunReducer(started, { type: "done" });
      expect(done.phase).toBe("done");
      expect(done.machineActiveMs).toBe(25_000);
      expect(done.activeSince).toBeNull();
      // frozen: reading later still yields 25s
      expect(machineElapsedMs(done.machineActiveMs, done.activeSince, 9_999_999)).toBe(25_000);
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

  it("zunbound re-opens the touch-off flow (zBound back to false)", () => {
    const bound = drillRunReducer(initialDrillRunState, { type: "zbound" });
    expect(bound.zBound).toBe(true);
    expect(drillRunReducer(bound, { type: "zunbound" }).zBound).toBe(false);
  });
});

describe("drillRunReducer — probeChecked (once-per-session circuit test)", () => {
  it("starts unchecked", () => {
    expect(initialDrillRunState.probeChecked).toBe(false);
    const started = drillRunReducer(initialDrillRunState, { type: "start", holesTotal: 5 });
    expect(started.probeChecked).toBe(false);
  });

  it("probechecked sets probeChecked true", () => {
    const s = drillRunReducer(initialDrillRunState, { type: "probechecked" });
    expect(s.probeChecked).toBe(true);
  });

  it("persists across a tool change (verified once per session)", () => {
    const checked = drillRunReducer(initialDrillRunState, { type: "probechecked" });
    const tc = drillRunReducer(checked, { type: "toolchange", toolName: "0.8mm", diameterMm: 0.8 });
    expect(tc.probeChecked).toBe(true);
    // ...while zBound (the per-bit gate) does reset on the same tool change.
    expect(tc.zBound).toBe(false);
  });

  it("reset and a fresh start clear probeChecked", () => {
    const checked = drillRunReducer(initialDrillRunState, { type: "probechecked" });
    expect(drillRunReducer(checked, { type: "reset" }).probeChecked).toBe(false);
    expect(drillRunReducer(checked, { type: "start", holesTotal: 5 }).probeChecked).toBe(false);
  });
});

describe("drillRunReducer — lastManualZMm (previous manual touch-off mark)", () => {
  it("starts null", () => {
    expect(initialDrillRunState.lastManualZMm).toBeNull();
    const started = drillRunReducer(initialDrillRunState, { type: "start", holesTotal: 5 });
    expect(started.lastManualZMm).toBeNull();
  });

  it("manualz stores the machine Z", () => {
    const s = drillRunReducer(initialDrillRunState, { type: "manualz", zMm: -37.2 });
    expect(s.lastManualZMm).toBe(-37.2);
  });

  it("persists across a tool change (mark is about the previous bit)", () => {
    const marked = drillRunReducer(initialDrillRunState, { type: "manualz", zMm: -37.2 });
    const tc = drillRunReducer(marked, { type: "toolchange", toolName: "0.8mm", diameterMm: 0.8 });
    expect(tc.lastManualZMm).toBe(-37.2);
  });

  it("reset and a fresh start clear it", () => {
    const marked = drillRunReducer(initialDrillRunState, { type: "manualz", zMm: -37.2 });
    expect(drillRunReducer(marked, { type: "reset" }).lastManualZMm).toBeNull();
    expect(drillRunReducer(marked, { type: "start", holesTotal: 5 }).lastManualZMm).toBeNull();
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

import { describe, expect, it } from "vitest";
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

  // 7. reset returns initial state
  it("reset: returns initialDrillRunState regardless of current state", () => {
    const messy: DrillRunState = {
      phase: "error",
      holesCompleted: 7,
      holesTotal: 10,
      currentHoleIndex: 3,
      toolChange: { toolName: "Сверло 1.2", diameterMm: 1.2 },
      error: "something went wrong",
    };
    const next = drillRunReducer(messy, { type: "reset" });
    expect(next).toEqual(initialDrillRunState);
  });

  // 8. reducer does not mutate the input state object
  it("does not mutate the input state", () => {
    const original: DrillRunState = {
      ...initialDrillRunState,
      phase: "running",
      holesTotal: 5,
      holesCompleted: 2,
      currentHoleIndex: 1,
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

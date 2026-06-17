import { describe, it, expect, beforeEach } from "vitest";
import { useDrillRunStore, DRILL_RUN_INITIAL } from "./drillRunStore";

const reset = () => useDrillRunStore.setState(DRILL_RUN_INITIAL);

describe("drillRunStore", () => {
  beforeEach(reset);

  it("applyStatus(active) seeds phase and marks active", () => {
    useDrillRunStore.getState().applyStatus({ active: true, phase: "running" });
    const s = useDrillRunStore.getState();
    expect(s.active).toBe(true);
    expect(s.phase).toBe("running");
  });

  it("applyStatus(inactive) resets", () => {
    useDrillRunStore.getState().applyProgress({ holesCompleted: 5, holesTotal: 84, holeIndex: 5 });
    useDrillRunStore.getState().applyStatus({ active: false, phase: "idle" });
    expect(useDrillRunStore.getState().active).toBe(false);
    expect(useDrillRunStore.getState().holesCompleted).toBe(0);
  });

  it("applyState sets an active phase", () => {
    useDrillRunStore.getState().applyState("paused");
    const s = useDrillRunStore.getState();
    expect(s.active).toBe(true);
    expect(s.phase).toBe("paused");
  });

  it("applyState with a terminal phase resets", () => {
    useDrillRunStore.getState().applyState("running");
    useDrillRunStore.getState().applyState("done");
    expect(useDrillRunStore.getState().active).toBe(false);
    expect(useDrillRunStore.getState().phase).toBe("idle");
  });

  it("applyProgress updates counts and marks active", () => {
    useDrillRunStore.getState().applyProgress({ holesCompleted: 52, holesTotal: 84, holeIndex: 52 });
    const s = useDrillRunStore.getState();
    expect(s.holesCompleted).toBe(52);
    expect(s.holesTotal).toBe(84);
    expect(s.holeIndex).toBe(52);
    expect(s.active).toBe(true);
  });

  it("applyToolChange stores the current tool", () => {
    useDrillRunStore.getState().applyToolChange({ toolName: "T2", diameterMm: 3 });
    const s = useDrillRunStore.getState();
    expect(s.toolName).toBe("T2");
    expect(s.diameterMm).toBe(3);
  });

  it("reset clears everything", () => {
    useDrillRunStore.getState().applyProgress({ holesCompleted: 5, holesTotal: 84, holeIndex: 5 });
    useDrillRunStore.getState().reset();
    expect(useDrillRunStore.getState()).toMatchObject(DRILL_RUN_INITIAL);
  });
});

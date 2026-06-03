import { describe, it, expect, beforeEach } from "vitest";
import { useShell } from "@/shellStore";
import type { Manifest } from "@/lib/api";

// Reset the singleton store before each test for isolation.
const initial = useShell.getState();
beforeEach(() => useShell.setState(initial, true));

const manifest = (n: number) => ({ schema_version: n }) as unknown as Manifest;

describe("view", () => {
  it("setView switches the view and goHome returns home", () => {
    useShell.getState().setView("project");
    expect(useShell.getState().view).toBe("project");
    useShell.getState().setView("settings");
    expect(useShell.getState().view).toBe("settings");
    useShell.getState().goHome();
    expect(useShell.getState().view).toBe("home");
  });
});

describe("artifact progress map", () => {
  it("reports a fraction per design and overwrites in place", () => {
    useShell.getState().reportArtifactProgress("d1", 0.5);
    useShell.getState().reportArtifactProgress("d2", 1);
    expect(useShell.getState().artifactProgress).toEqual({ d1: 0.5, d2: 1 });
    useShell.getState().reportArtifactProgress("d1", 0.9);
    expect(useShell.getState().artifactProgress).toEqual({ d1: 0.9, d2: 1 });
  });

  it("prunes entries whose design is no longer live", () => {
    useShell.setState({ artifactProgress: { a: 0.1, b: 0.2, c: 0.3 } });
    useShell.getState().pruneArtifactProgress(["a", "c"]);
    expect(useShell.getState().artifactProgress).toEqual({ a: 0.1, c: 0.3 });
  });

  it("clears one design, leaves the rest, and ignores unknown ids", () => {
    useShell.setState({ artifactProgress: { a: 0.1, b: 0.2 } });
    useShell.getState().clearArtifactProgress("a");
    expect(useShell.getState().artifactProgress).toEqual({ b: 0.2 });
    useShell.getState().clearArtifactProgress("zzz");
    expect(useShell.getState().artifactProgress).toEqual({ b: 0.2 });
  });
});

describe("undo/redo bookkeeping", () => {
  it("canUndo and canRedo reflect their stacks", () => {
    expect(useShell.getState().canUndo()).toBe(false);
    expect(useShell.getState().canRedo()).toBe(false);
    useShell.setState({ undoStack: [manifest(0)], redoStack: [manifest(0)] });
    expect(useShell.getState().canUndo()).toBe(true);
    expect(useShell.getState().canRedo()).toBe(true);
  });

  it("_recordUndo pushes the snapshot and clears the redo stack", () => {
    useShell.setState({ undoStack: [], redoStack: [manifest(0)] });
    const snap = manifest(5);
    useShell.getState()._recordUndo(snap);
    expect(useShell.getState().undoStack).toHaveLength(1);
    expect(useShell.getState().undoStack[0]).toBe(snap);
    expect(useShell.getState().redoStack).toEqual([]);
  });

  it("caps the undo stack at 100 snapshots, dropping the oldest", () => {
    const many = Array.from({ length: 100 }, (_, i) => manifest(i));
    useShell.setState({ undoStack: many, redoStack: [] });
    useShell.getState()._recordUndo(manifest(999));
    const stack = useShell.getState().undoStack;
    expect(stack).toHaveLength(100);
    expect((stack[stack.length - 1] as { schema_version: number }).schema_version).toBe(999);
    expect((stack[0] as { schema_version: number }).schema_version).toBe(1);
  });
});

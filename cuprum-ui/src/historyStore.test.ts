import { describe, it, expect, beforeEach } from "vitest";
import { useHistory } from "@/historyStore";
import { type Manifest } from "@/lib/api";

// Reset the singleton store before each test for isolation.
const initial = useHistory.getState();
beforeEach(() => {
  useHistory.setState(initial, true);
});

const manifest = (n: number) => ({ schema_version: n }) as unknown as Manifest;

describe("undo/redo bookkeeping", () => {
  it("canUndo and canRedo reflect their stacks", () => {
    expect(useHistory.getState().canUndo()).toBe(false);
    expect(useHistory.getState().canRedo()).toBe(false);
    useHistory.setState({ undoStack: [manifest(0)], redoStack: [manifest(0)] });
    expect(useHistory.getState().canUndo()).toBe(true);
    expect(useHistory.getState().canRedo()).toBe(true);
  });

  it("recordUndo pushes the snapshot and clears the redo stack", () => {
    useHistory.setState({ undoStack: [], redoStack: [manifest(0)] });
    const snap = manifest(5);
    useHistory.getState().recordUndo(snap);
    expect(useHistory.getState().undoStack).toHaveLength(1);
    expect(useHistory.getState().undoStack[0]).toBe(snap);
    expect(useHistory.getState().redoStack).toEqual([]);
  });

  it("caps the undo stack at 100 snapshots, dropping the oldest", () => {
    const many = Array.from({ length: 100 }, (_, i) => manifest(i));
    useHistory.setState({ undoStack: many, redoStack: [] });
    useHistory.getState().recordUndo(manifest(999));
    const stack = useHistory.getState().undoStack;
    expect(stack).toHaveLength(100);
    expect((stack[stack.length - 1] as { schema_version: number }).schema_version).toBe(999);
    expect((stack[0] as { schema_version: number }).schema_version).toBe(1);
  });
});

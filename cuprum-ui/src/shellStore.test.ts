import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useShell } from "@/shellStore";
import { api, type AddedDesign, type Manifest, type ProjectDesign } from "@/lib/api";

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

describe("addDesignsFromPaths concurrency", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps a concurrent manifest mutation and records the live manifest to undo", async () => {
    const base: Manifest = {
      schema_version: 1,
      name: "p",
      description: "",
      designs: [],
      exposure: null,
      layer_colors: {},
      stackup: null,
      panel: null,
    };
    useShell.setState({
      currentPath: "/tmp/p.cuprum",
      workingDir: "/tmp/wd",
      currentManifest: base,
      undoStack: [],
      redoStack: [],
    });
    const design = { id: "d1", source_name: "a.zip", gerbers: [] } as unknown as ProjectDesign;
    let resolveAdd!: (v: AddedDesign) => void;
    vi.spyOn(api, "addDesignFromZip").mockImplementation(
      () => new Promise<AddedDesign>((res) => { resolveAdd = res; }),
    );
    vi.spyOn(api, "writeWorkingManifest").mockResolvedValue(undefined as never);
    vi.spyOn(api, "saveProject").mockResolvedValue(undefined as never);

    const importing = useShell.getState().addDesignsFromPaths(["a.zip"]);
    // A concurrent mutation lands while the zip import is still in flight.
    const mutated: Manifest = { ...base, description: "concurrent edit" };
    useShell.setState({ currentManifest: mutated });
    resolveAdd({ design, traceSession: null } as unknown as AddedDesign);
    await importing;

    const result = useShell.getState().currentManifest;
    expect(result?.designs.map((d) => d.id)).toEqual(["d1"]);
    // The concurrent mutation must survive the import commit…
    expect(result?.description).toBe("concurrent edit");
    // …and undo must restore the state just before the import (with the mutation).
    const undoTop = useShell.getState().undoStack.at(-1);
    expect(undoTop).toBe(mutated);
  });
});

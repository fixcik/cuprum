import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useShell } from "@/shellStore";
import { useNavigation } from "@/navigationStore";
import { useArtifacts } from "@/artifactsStore";
import { useHistory } from "@/historyStore";
import { api, type AddedDesign, type Manifest, type ProjectDesign } from "@/lib/api";

// Reset the singleton stores before each test for isolation.
const initial = useShell.getState();
const initialNavigation = useNavigation.getState();
const initialArtifacts = useArtifacts.getState();
const initialHistory = useHistory.getState();
beforeEach(() => {
  useShell.setState(initial, true);
  useNavigation.setState(initialNavigation, true);
  useArtifacts.setState(initialArtifacts, true);
  useHistory.setState(initialHistory, true);
});

describe("view", () => {
  it("setView switches the view and goHome returns home", () => {
    useNavigation.getState().setView("project");
    expect(useNavigation.getState().view).toBe("project");
    useNavigation.getState().setView("settings");
    expect(useNavigation.getState().view).toBe("settings");
    useNavigation.getState().goHome();
    expect(useNavigation.getState().view).toBe("home");
  });
});

describe("artifact progress map", () => {
  it("reports a fraction per design and overwrites in place", () => {
    useArtifacts.getState().reportArtifactProgress("d1", 0.5);
    useArtifacts.getState().reportArtifactProgress("d2", 1);
    expect(useArtifacts.getState().artifactProgress).toEqual({ d1: 0.5, d2: 1 });
    useArtifacts.getState().reportArtifactProgress("d1", 0.9);
    expect(useArtifacts.getState().artifactProgress).toEqual({ d1: 0.9, d2: 1 });
  });

  it("prunes entries whose design is no longer live", () => {
    useArtifacts.setState({ artifactProgress: { a: 0.1, b: 0.2, c: 0.3 } });
    useArtifacts.getState().pruneArtifactProgress(["a", "c"]);
    expect(useArtifacts.getState().artifactProgress).toEqual({ a: 0.1, c: 0.3 });
  });

  it("clears one design, leaves the rest, and ignores unknown ids", () => {
    useArtifacts.setState({ artifactProgress: { a: 0.1, b: 0.2 } });
    useArtifacts.getState().clearArtifactProgress("a");
    expect(useArtifacts.getState().artifactProgress).toEqual({ b: 0.2 });
    useArtifacts.getState().clearArtifactProgress("zzz");
    expect(useArtifacts.getState().artifactProgress).toEqual({ b: 0.2 });
  });

  it("reset clears trace tokens, progress, and import counters", () => {
    useArtifacts.setState({
      artifactProgress: { a: 0.5 },
      traceSessions: { a: 7 },
      importingCount: 2,
    });
    useArtifacts.getState().reset();
    expect(useArtifacts.getState().artifactProgress).toEqual({});
    expect(useArtifacts.getState().traceSessions).toEqual({});
    expect(useArtifacts.getState().importingCount).toBe(0);
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
    });
    useHistory.setState({ undoStack: [], redoStack: [] });
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
    const undoTop = useHistory.getState().undoStack.at(-1);
    expect(undoTop).toBe(mutated);
  });
});

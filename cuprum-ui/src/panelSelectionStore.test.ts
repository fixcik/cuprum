import { describe, it, expect, beforeEach } from "vitest";
import { usePanelSelection } from "@/panelSelectionStore";

describe("panelSelectionStore", () => {
  beforeEach(() => usePanelSelection.getState().clear());

  it("sets, toggles and clears selection", () => {
    const s = usePanelSelection.getState();
    s.set(["a", "b"]);
    expect([...usePanelSelection.getState().selected].sort()).toEqual(["a", "b"]);
    s.toggle("a");
    expect([...usePanelSelection.getState().selected]).toEqual(["b"]);
    s.toggle("c");
    expect([...usePanelSelection.getState().selected].sort()).toEqual(["b", "c"]);
    s.clear();
    expect(usePanelSelection.getState().selected.size).toBe(0);
  });

  it("retains only ids still present (prune)", () => {
    usePanelSelection.getState().set(["a", "b", "c"]);
    usePanelSelection.getState().retain(new Set(["b"]));
    expect([...usePanelSelection.getState().selected]).toEqual(["b"]);
  });
});

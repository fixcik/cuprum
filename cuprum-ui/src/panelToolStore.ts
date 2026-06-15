import { create } from "zustand";
import type { PanelTool } from "@/components/panel/PanelToolPalette";

/** Active modal tool of the panel editor. Lifted out of PanelBlankCanvas into a
 *  store so the rail, the keyboard shortcuts (which live in PanelEditor) and the
 *  upcoming ToolOptionsBar all read and drive the same value without prop drilling.
 *  Tool-specific options (hole diameter, snap, …) will join this store later. */
interface PanelToolState {
  tool: PanelTool;
  setTool: (t: PanelTool) => void;
}

export const usePanelTool = create<PanelToolState>((set) => ({
  tool: "select",
  setTool: (tool) => set((s) => (s.tool === tool ? s : { tool })),
}));

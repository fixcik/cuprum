import { create } from "zustand";
import { DEFAULT_TOOLING_DIAMETER_MM } from "@/lib/panel";
import type { PanelTool } from "@/components/panel/PanelToolPalette";

/** Active modal tool of the panel editor plus per-tool options. Lifted out of
 *  PanelBlankCanvas into a store so the rail, the keyboard shortcuts (which live in
 *  PanelEditor) and the ToolOptionsBar all read and drive the same values without
 *  prop drilling. Options are kept in mm (the model unit); the UI converts at the
 *  edge via useUnitFormat. */
interface PanelToolState {
  tool: PanelTool;
  setTool: (t: PanelTool) => void;
  /** Diameter (mm) used when placing a single tooling hole by click. */
  holeDiameterMm: number;
  setHoleDiameterMm: (mm: number) => void;
  /** Whether drawing/resizing a keep-out zone snaps to the 1 mm grid (Alt still
   *  overrides this momentarily). */
  keepOutSnap: boolean;
  setKeepOutSnap: (v: boolean) => void;
}

export const usePanelTool = create<PanelToolState>((set) => ({
  tool: "select",
  setTool: (tool) => set((s) => (s.tool === tool ? s : { tool })),
  holeDiameterMm: DEFAULT_TOOLING_DIAMETER_MM,
  setHoleDiameterMm: (holeDiameterMm) => set({ holeDiameterMm }),
  keepOutSnap: true,
  setKeepOutSnap: (keepOutSnap) => set({ keepOutSnap }),
}));

import { create } from "zustand";
import { api } from "@/lib/api";

/** The top-level views the shell can show. */
export type View = "home" | "project" | "equipment" | "settings";

interface NavigationStore {
  view: View;
  /** Last error surfaced on the Home screen (project open/list failures). */
  error: string | null;
  /** Transient notice surfaced on the Home screen (e.g. "recent removed"). */
  homeNotice: string | null;

  /** CSS px per mm for the host display; defaults to the 96dpi CSS reference. */
  pxPerMm: number;
  /** Private guard — true once the native value has been fetched. */
  _scaleLoaded: boolean;
  loadDisplayScale: () => Promise<void>;

  setView: (v: View) => void;
  goHome: () => void;
  setError: (error: string | null) => void;
  setHomeNotice: (notice: string | null) => void;
}

export const useNavigation = create<NavigationStore>((set, get) => ({
  view: "home",
  error: null,
  homeNotice: null,
  pxPerMm: 96 / 25.4,
  _scaleLoaded: false,

  loadDisplayScale: async () => {
    // Cache once per launch; the native value never changes mid-session.
    if (get()._scaleLoaded) return;
    try {
      const v = await api.displayPxPerMm();
      if (v && isFinite(v) && v > 0) set({ pxPerMm: v, _scaleLoaded: true });
      else set({ _scaleLoaded: true });
    } catch {
      set({ _scaleLoaded: true });
    }
  },

  setView: (v) => set({ view: v }),
  goHome: () => set({ view: "home" }),
  setError: (error) => set({ error }),
  setHomeNotice: (homeNotice) => set({ homeNotice }),
}));

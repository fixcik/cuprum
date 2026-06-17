import { create } from "zustand";

/** Phases from the Rust drill runner (`DrillRunState.phase`). */
const ACTIVE_PHASES = new Set([
  "running",
  "pausing",
  "paused",
  "stopping",
  "awaitingToolChange",
]);

export interface DrillRunLive {
  active: boolean;
  phase: string;
  holesCompleted: number;
  holesTotal: number;
  holeIndex: number | null;
  toolName: string | null;
  diameterMm: number | null;
}

export const DRILL_RUN_INITIAL: DrillRunLive = {
  active: false,
  phase: "idle",
  holesCompleted: 0,
  holesTotal: 0,
  holeIndex: null,
  toolName: null,
  diameterMm: null,
};

interface DrillRunStore extends DrillRunLive {
  /** Seed from `drill_run_status()` on mount (re-attach mid-run). */
  applyStatus: (s: { active: boolean; phase: string; toolName?: string; diameterMm?: number }) => void;
  /** `drill-run://state` — phase change. Terminal phases reset. */
  applyState: (phase: string) => void;
  /** `drill-run://progress` — hole counts. */
  applyProgress: (p: { holesCompleted: number; holesTotal: number; holeIndex: number }) => void;
  /** `drill-run://toolchange` — current tool. */
  applyToolChange: (p: { toolName: string; diameterMm: number }) => void;
  /** Run ended/idle — clear live state. */
  reset: () => void;
}

export const useDrillRunStore = create<DrillRunStore>((set) => ({
  ...DRILL_RUN_INITIAL,

  applyStatus: (s) => {
    if (!s.active || !ACTIVE_PHASES.has(s.phase)) {
      set(DRILL_RUN_INITIAL);
      return;
    }
    set({
      active: true,
      phase: s.phase,
      toolName: s.toolName ?? null,
      diameterMm: s.diameterMm ?? null,
    });
  },

  applyState: (phase) => {
    if (!ACTIVE_PHASES.has(phase)) {
      set(DRILL_RUN_INITIAL);
      return;
    }
    set({ active: true, phase });
  },

  applyProgress: (p) =>
    set({
      active: true,
      holesCompleted: p.holesCompleted,
      holesTotal: p.holesTotal,
      holeIndex: p.holeIndex,
    }),

  applyToolChange: (p) => set({ toolName: p.toolName, diameterMm: p.diameterMm }),

  reset: () => set(DRILL_RUN_INITIAL),
}));

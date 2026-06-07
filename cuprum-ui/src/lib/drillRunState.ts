export type DrillRunPhase =
  | "idle"
  | "running"
  | "pausing"
  | "paused"
  | "stopping"
  | "awaitingToolChange"
  | "done"
  | "error";

export interface DrillRunState {
  phase: DrillRunPhase;
  holesCompleted: number;
  holesTotal: number;
  currentHoleIndex: number | null;
  toolChange: { toolName: string; diameterMm: number } | null;
  /** Whether Z has been re-bound for the CURRENT bit (probe or manual touch-off).
   *  Resets when a tool change begins; gates "Продолжить"/"Начать". Frontend-only. */
  zBound: boolean;
  /** Monotonic counter incremented on every tool-change pause. Used only as a React
   *  remount key for the tool-change card so its local state (probe self-test, tab,
   *  busy, error) resets each pause — even on back-to-back tool changes. */
  toolChangeSeq: number;
  error: string | null;
  runStartedAt: number | null;
}

export type DrillRunEvent =
  | { type: "start"; holesTotal: number }
  | { type: "state"; phase: DrillRunPhase }
  | { type: "progress"; holesCompleted: number; holeIndex: number }
  | { type: "toolchange"; toolName: string; diameterMm: number }
  | { type: "error"; message: string }
  | { type: "done" }
  | { type: "reset" }
  | { type: "zbound" };

export const initialDrillRunState: DrillRunState = {
  phase: "idle",
  holesCompleted: 0,
  holesTotal: 0,
  currentHoleIndex: null,
  toolChange: null,
  zBound: false,
  toolChangeSeq: 0,
  error: null,
  runStartedAt: null,
};

export function drillRunReducer(
  s: DrillRunState,
  e: DrillRunEvent,
): DrillRunState {
  switch (e.type) {
    case "reset":
      return { ...initialDrillRunState, runStartedAt: null };

    case "start":
      return {
        ...initialDrillRunState,
        phase: "running",
        holesTotal: e.holesTotal,
        runStartedAt: Date.now(),
      };

    case "progress":
      return {
        ...s,
        holesCompleted: e.holesCompleted,
        currentHoleIndex: e.holeIndex,
        phase: s.phase === "awaitingToolChange" ? "running" : s.phase,
        toolChange: s.phase === "awaitingToolChange" ? null : s.toolChange,
      };

    case "toolchange":
      return {
        ...s,
        phase: "awaitingToolChange",
        toolChange: { toolName: e.toolName, diameterMm: e.diameterMm },
        zBound: false,
        toolChangeSeq: s.toolChangeSeq + 1,
      };

    case "zbound":
      return { ...s, zBound: true };

    case "state": {
      if (e.phase === "running") {
        return { ...s, phase: "running", toolChange: null };
      }
      if (e.phase === "done") {
        return { ...s, phase: "done", currentHoleIndex: null, toolChange: null };
      }
      return { ...s, phase: e.phase };
    }

    case "error":
      return { ...s, phase: "error", error: e.message };

    case "done":
      return { ...s, phase: "done", currentHoleIndex: null, toolChange: null };
  }
}

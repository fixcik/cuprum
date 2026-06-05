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
  error: string | null;
}

export type DrillRunEvent =
  | { type: "start"; holesTotal: number }
  | { type: "state"; phase: DrillRunPhase }
  | { type: "progress"; holesCompleted: number; holeIndex: number }
  | { type: "toolchange"; toolName: string; diameterMm: number }
  | { type: "error"; message: string }
  | { type: "done" }
  | { type: "reset" };

export const initialDrillRunState: DrillRunState = {
  phase: "idle",
  holesCompleted: 0,
  holesTotal: 0,
  currentHoleIndex: null,
  toolChange: null,
  error: null,
};

export function drillRunReducer(
  s: DrillRunState,
  e: DrillRunEvent,
): DrillRunState {
  switch (e.type) {
    case "reset":
      return initialDrillRunState;

    case "start":
      return {
        ...initialDrillRunState,
        phase: "running",
        holesTotal: e.holesTotal,
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
      };

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

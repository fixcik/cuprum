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
  /** Whether the probe circuit has been tested THIS session (operator touched the
   *  probe to the bit and the pin latched). Persists across tool changes/resume —
   *  the circuit is verified once per run, so later changes skip "step 1" and go
   *  straight to "set Z by probe". Reset only on a fresh start/reset. Frontend-only. */
  probeChecked: boolean;
  /** Machine Z (mm) of the last MANUAL touch-off confirm this session, or null if
   *  none yet. Drives the yellow "previous Z" mark on the manual Z bar — a hint to
   *  repeat the same height for a same-diameter bit. Persists across tool changes
   *  (the mark is about the PREVIOUS bit); reset only on a fresh start/reset.
   *  Frontend-only. */
  lastManualZMm: number | null;
  /** Monotonic counter incremented on every tool-change pause. Used only as a React
   *  remount key for the tool-change card so its card-local state (tab, busy, error)
   *  resets each pause — even on back-to-back tool changes. The session-level
   *  `probeChecked`/`zBound` flags live here in the reducer, not in the card. */
  toolChangeSeq: number;
  error: string | null;
  runStartedAt: number | null;
  /** "Machine clock" — accumulated MACHINE time in ms (movement + drilling only),
   *  excluding the operator-wait phases (`awaitingToolChange`, `paused`). `machineActiveMs`
   *  is the time banked before the current running interval; `activeSince` is the start
   *  of the current running interval, or null while the clock is stopped (parked / done).
   *  The displayed "прошло" is `machineActiveMs + (activeSince ? now − activeSince : 0)`,
   *  so it freezes during manual swaps/pauses and converges to the motion estimate. */
  machineActiveMs: number;
  activeSince: number | null;
}

/** Run phases during which the machine clock advances — the bit is actually moving or
 *  cutting. `pausing` still finishes the current hole (cutting) and `stopping` is the
 *  machine decelerating to a soft halt; both are machine time. Every other phase
 *  (`idle`/`paused`/`awaitingToolChange`/`done`/`error`) parks the clock — `paused` and
 *  `awaitingToolChange` are operator-wait, the rest terminal. */
const MACHINE_RUNNING_PHASES: ReadonlySet<DrillRunPhase> = new Set([
  "running",
  "pausing",
  "stopping",
]);

/** True while the machine clock should advance for the given phase (see
 *  `MACHINE_RUNNING_PHASES`). */
export function isMachineRunning(phase: DrillRunPhase): boolean {
  return MACHINE_RUNNING_PHASES.has(phase);
}

/** Machine elapsed time (ms) at `now`: banked active time plus the in-flight interval
 *  if the clock is currently running. Constant while the clock is parked (`activeSince`
 *  null), so a single read freezes the displayed timer through pauses / tool changes. */
export function machineElapsedMs(
  machineActiveMs: number,
  activeSince: number | null,
  now: number,
): number {
  return Math.max(0, machineActiveMs + (activeSince != null ? now - activeSince : 0));
}

export type DrillRunEvent =
  | { type: "start"; holesTotal: number }
  | { type: "state"; phase: DrillRunPhase }
  | { type: "progress"; holesCompleted: number; holeIndex: number }
  | { type: "toolchange"; toolName: string; diameterMm: number }
  | { type: "error"; message: string }
  | { type: "done" }
  | { type: "reset" }
  | { type: "zbound" }
  | { type: "probechecked" }
  | { type: "manualz"; zMm: number };

export const initialDrillRunState: DrillRunState = {
  phase: "idle",
  holesCompleted: 0,
  holesTotal: 0,
  currentHoleIndex: null,
  toolChange: null,
  zBound: false,
  probeChecked: false,
  lastManualZMm: null,
  toolChangeSeq: 0,
  error: null,
  runStartedAt: null,
  machineActiveMs: 0,
  activeSince: null,
};

/** Update the machine clock across a phase transition. `prev`/`next` are the states
 *  before/after the core reducer ran. When the clock stops (active → parked) the
 *  in-flight interval is banked into `machineActiveMs`; when it resumes (parked →
 *  active) a fresh `activeSince` is stamped. Phase-preserving events carry the clock
 *  fields through unchanged (via the core reducer's spread). `start`/`reset` reset the
 *  clock explicitly (`start` runs the clock from `runStartedAt`). */
function applyMachineClock(
  prev: DrillRunState,
  next: DrillRunState,
  e: DrillRunEvent,
): DrillRunState {
  if (e.type === "reset") {
    return { ...next, machineActiveMs: 0, activeSince: null };
  }
  if (e.type === "start") {
    // The machine starts running immediately — clock runs from runStartedAt (reuse
    // that timestamp rather than reading the clock twice).
    return { ...next, machineActiveMs: 0, activeSince: next.runStartedAt };
  }
  const wasRunning = isMachineRunning(prev.phase);
  const isRunning = isMachineRunning(next.phase);
  if (wasRunning === isRunning) return next;
  const now = Date.now();
  if (isRunning) {
    return { ...next, activeSince: now };
  }
  const banked = prev.activeSince != null ? now - prev.activeSince : 0;
  return { ...next, machineActiveMs: prev.machineActiveMs + banked, activeSince: null };
}

export function drillRunReducer(
  s: DrillRunState,
  e: DrillRunEvent,
): DrillRunState {
  return applyMachineClock(s, drillRunReducerCore(s, e), e);
}

function drillRunReducerCore(
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

    case "probechecked":
      return { ...s, probeChecked: true };

    case "manualz":
      return { ...s, lastManualZMm: e.zMm };

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

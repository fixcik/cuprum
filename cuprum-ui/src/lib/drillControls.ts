import type { DrillRunPhase } from "@/lib/drillRunState";

/** Which run-control buttons are actionable for a given drill-run phase. Pure —
 *  unit-tested. The emergency stop is intentionally NOT modelled here: it is ALWAYS
 *  active (safety affordance) and must never be gated by run state. */
export interface DrillControlsEnabled {
  /** Pause is meaningful only while the bit is actually moving/cutting (`running`).
   *  In `paused` the same button becomes "Продолжить" (resume), so it stays enabled
   *  there too — both halves of the toggle act on a live run. */
  pause: boolean;
  /** Stop (graceful) interrupts the WHOLE run, so it's enabled while a run is active —
   *  including `awaitingToolChange`, where the machine is physically idle but the run
   *  isn't done. `stopping` swaps the button for a banner + "Отменить стоп", so it's
   *  not gated here; `idle`/`pausing`/`done`/`error` have nothing to stop. */
  stop: boolean;
}

const PAUSE_PHASES: ReadonlySet<DrillRunPhase> = new Set<DrillRunPhase>(["running", "paused"]);
const STOP_PHASES: ReadonlySet<DrillRunPhase> = new Set<DrillRunPhase>([
  "running",
  "paused",
  "awaitingToolChange",
]);

export function drillControlsEnabled(phase: DrillRunPhase): DrillControlsEnabled {
  return { pause: PAUSE_PHASES.has(phase), stop: STOP_PHASES.has(phase) };
}

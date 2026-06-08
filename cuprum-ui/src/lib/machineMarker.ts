import type { DrillRunPhase } from "@/lib/drillRunState";
import type { DrillHolePhase } from "@/lib/drillPhaseProgress";
import type { DatumCorner } from "@/lib/datum";

/** Convert a machine WORK position into panel-space mm (origin = top-left, Y down
 *  — the frame holes and axes are drawn in). Exact inverse of `machinePoint` for
 *  the active datum: machineX = x − (right?W:0), machineY = (bottom?H:0) − y, so
 *  x = machineX + (right?W:0), y = (bottom?H:0) − machineY. Default datum
 *  (bottom-left) → (x, H − machineY). */
export function workPosToPanel(
  workXMm: number,
  workYMm: number,
  panelHeightMm: number,
  datum: DatumCorner = "bottom-left",
  panelWidthMm = 0,
): { xMm: number; yMm: number } {
  const right = datum === "bottom-right" || datum === "top-right";
  const bottom = datum === "bottom-left" || datum === "bottom-right";
  return {
    xMm: workXMm + (right ? panelWidthMm : 0),
    yMm: (bottom ? panelHeightMm : 0) - workYMm,
  };
}

/** Run phases during which the live marker is shown. The machine is still moving
 *  (or about to settle) in every non-terminal run phase — including the transient
 *  `pausing`/`stopping` (it is finishing the current hole and lifting) and the held
 *  `paused`/`awaitingToolChange` (Idle on GRBL, but logically mid-run). We gate on
 *  the run phase, not GRBL state, so the marker stays put through all of them; it is
 *  hidden only on the terminal `idle`/`done`/`error`. Single source of truth for the
 *  marker's active-phase set — both `shouldShowMarker` and `drillMarkerStatus` use it. */
const ACTIVE_PHASES: ReadonlySet<DrillRunPhase> = new Set([
  "running",
  "pausing",
  "paused",
  "stopping",
  "awaitingToolChange",
]);

/** Phases in which the bit is NOT cutting — the ring/label read as held (grey). The
 *  machine is parked (`paused`), holding for a manual swap (`awaitingToolChange`), or
 *  decelerating to a stop (`stopping`). `running`/`pausing` are cutting (in `pausing`
 *  the machine is still finishing the current hole), so they show the live cycle. */
const IDLE_PHASES: ReadonlySet<DrillRunPhase> = new Set([
  "paused",
  "awaitingToolChange",
  "stopping",
]);

/** True while the run is in a non-terminal phase (any of `ACTIVE_PHASES`): the
 *  machine is still moving or held mid-run. Single source of truth for "is the run
 *  live" — drives the marker visibility and the run header's elapsed timer (which
 *  must keep ticking through pauses / tool changes, not just while cutting). */
export function isActiveRunPhase(phase: DrillRunPhase): boolean {
  return ACTIVE_PHASES.has(phase);
}

/** Marker is visible only during an active run AND while a fresh position is
 *  available (poller still reporting). `hasFreshPosition` is false when no
 *  `machine://status` has arrived recently (e.g. unplugged mid-run). */
export function shouldShowMarker(
  phase: DrillRunPhase,
  hasFreshPosition: boolean,
): boolean {
  return hasFreshPosition && ACTIVE_PHASES.has(phase);
}

/** What the live marker should show for a given run phase. Single source of truth
 *  for the marker's visibility, idle (not-cutting) state, and label key — consumed by
 *  the drill editor (label + idle ring) and the canvas (marker phase colour), so the
 *  two never drift apart.
 *
 *  `idle` ⇒ the bit is held / not cutting (grey ring, no sweep). `labelKey` is a full
 *  i18n key into the `drill` namespace (resolved by the caller's `t`), or null when
 *  the marker is hidden (terminal phases):
 *   - `awaitingToolChange` → `runHeader.zBind` on the first change (binding Z for bit
 *     #1, no previous bit to swap) else `runHeader.toolChange`.
 *   - `paused`             → `runHeader.paused`.
 *   - `stopping`           → `runHeader.stopping` (soft stop in progress).
 *   - `running`/`pausing`  → the live micro-phase of the hole cycle (`phase.<cyclePhase>`:
 *     traverse / descent / drilling / retract); `pausing` is still cutting.
 *   - `idle`/`done`/`error`→ no label (marker hidden).
 *
 *  @param phase           current run phase.
 *  @param cyclePhase      live hole-cycle micro-phase (for running/pausing labels).
 *  @param firstToolChange first tool change of the run (work-Z not bound yet).
 */
export function drillMarkerStatus(
  phase: DrillRunPhase,
  cyclePhase: DrillHolePhase,
  firstToolChange: boolean,
): { visible: boolean; idle: boolean; labelKey: string | null } {
  const visible = ACTIVE_PHASES.has(phase);
  const idle = IDLE_PHASES.has(phase);
  let labelKey: string | null;
  switch (phase) {
    case "awaitingToolChange":
      labelKey = firstToolChange ? "runHeader.zBind" : "runHeader.toolChange";
      break;
    case "paused":
      labelKey = "runHeader.paused";
      break;
    case "stopping":
      labelKey = "runHeader.stopping";
      break;
    case "running":
    case "pausing":
      labelKey = `phase.${cyclePhase}`;
      break;
    default:
      // idle / done / error — marker hidden, no label.
      labelKey = null;
  }
  return { visible, idle, labelKey };
}

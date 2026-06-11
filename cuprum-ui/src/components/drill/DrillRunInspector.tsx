import { useTranslation } from "react-i18next";
import { Check, Loader2, OctagonX, Pause, Play, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { DrillRunHeader } from "@/components/drill/DrillRunHeader";
import { DrillToolChangeCard } from "@/components/drill/DrillToolChangeCard";
import { DrillFinishCard } from "@/components/drill/DrillFinishCard";
import { DrillFeedSlider } from "@/components/drill/DrillFeedSlider";
import { activeGroupForHole } from "@/lib/drillRoute";
import { machineElapsedMs } from "@/lib/drillRunState";
import { drillControlsEnabled } from "@/lib/drillControls";
import { groupColor } from "@/components/drill/DrillMapCanvas";
import type { UseDrillRun } from "@/hooks/useDrillRun";
import type { DrillRoute } from "@/lib/drillRoute";
import type { DatumCorner } from "@/lib/datum";

export interface DrillRunInspectorProps {
  run: UseDrillRun;
  route: DrillRoute;
  datum: DatumCorner;
  panelWidthMm: number;
  panelHeightMm: number;
  totalEstimateSec: number;
  /** Per-group motion estimate (s) from the Rust plan; feeds the header's "until next
   *  tool change" readout. */
  groupMotionSecs: number[];
  /** Deepest plunge depth (mm) = substrate thickness + breakthrough; feeds the
   *  tool-change card's Z-headroom guard. */
  plungeDepthMm: number;
  feedOverridePct: number;
  onFeedChange: (pct: number) => void;
  onRunDone: () => void;
  hasProbe: boolean;
  probe: {
    maxDistMm: number;
    feedMmMin: number;
    offsetMm: number;
    safeZMm: number;
    toolChangeZMm: number;
    firstMaxDistMm: number;
  };
}

/** RUN-mode inspector: progress header, tool-change/finish cards, feed slider, and
 *  pause/resume/stop footer controls. Replaces the PLAN cards while a run is active. */
export function DrillRunInspector({
  run,
  route,
  datum,
  panelWidthMm,
  panelHeightMm,
  totalEstimateSec,
  groupMotionSecs,
  plungeDepthMm,
  feedOverridePct,
  onFeedChange,
  onRunDone,
  hasProbe,
  probe,
}: DrillRunInspectorProps) {
  const { t } = useTranslation("drill");
  const { state } = run;
  const { phase } = state;

  // Which run-control buttons are actionable for this phase. Pause only while the bit
  // is moving (running/paused-resume); Stop while a run is active (incl. the operator
  // wait of a tool change) — but NOT the first tool change, which is the pre-start Z
  // bind before the run has moved. The emergency stop is NOT gated — always active.
  const controls = drillControlsEnabled(phase, state.toolChangeSeq === 1);

  // Final/elapsed reflects MACHINE time only (movement + drilling); operator-wait
  // intervals (tool changes / pauses) are excluded via the machine clock.
  const elapsedSec = Math.floor(
    machineElapsedMs(state.machineActiveMs, state.activeSince, Date.now()) / 1000,
  );

  // The bit being installed drills the UPCOMING group — the one holding the next
  // hole to drill (run-index === holesCompleted). `currentHoleIndex` still points at
  // the just-finished hole during a tool-change pause, so it would name the previous
  // (completed) group; `holesCompleted` names the next one (and group 0 at the start).
  const nextGroup = activeGroupForHole(route, state.holesCompleted);
  const nextColor = groupColor(nextGroup?.gi ?? 0);

  const showFeedSlider =
    phase === "running" || phase === "paused" || phase === "awaitingToolChange";

  return (
    <div className="flex flex-col flex-1 overflow-y-auto">
      {/* Progress ring + status + hole counter */}
      <DrillRunHeader
        phase={phase}
        holesCompleted={state.holesCompleted}
        holesTotal={state.holesTotal}
        currentHoleIndex={state.currentHoleIndex}
        runStartedAt={state.runStartedAt}
        machineActiveMs={state.machineActiveMs}
        activeSince={state.activeSince}
        firstToolChange={state.toolChangeSeq === 1}
        route={route}
        datum={datum}
        panelWidthMm={panelWidthMm}
        panelHeightMm={panelHeightMm}
        totalEstimateSec={totalEstimateSec}
        groupMotionSecs={groupMotionSecs}
      />

      {/* Tool-change card */}
      {phase === "awaitingToolChange" && state.toolChange && (
        <div className="pt-3">
          <DrillToolChangeCard
            key={state.toolChangeSeq}
            diameterMm={state.toolChange.diameterMm}
            nextColor={nextColor}
            holesAhead={nextGroup?.group.orderedHoles.length ?? 0}
            hasProbe={hasProbe}
            firstToolChange={state.toolChangeSeq === 1}
            probe={probe}
            zBound={state.zBound}
            plungeDepthMm={plungeDepthMm}
            probeChecked={state.probeChecked}
            lastManualZMm={state.lastManualZMm}
            onZBound={run.markZBound}
            onZUnbind={run.markZUnbound}
            onProbeChecked={run.markProbeChecked}
            onManualZ={run.markManualZ}
            onConfirm={run.confirmToolChange}
          />
        </div>
      )}

      {/* Finish card — only in done phase */}
      {phase === "done" && (
        <div className="pt-3">
          <DrillFinishCard holesTotal={state.holesTotal} elapsedSec={elapsedSec} />
        </div>
      )}

      {/* Feed override slider */}
      {showFeedSlider && (
        <div className="px-4 py-3 border-t border-border">
          <DrillFeedSlider value={feedOverridePct} onChange={onFeedChange} disabled={false} />
        </div>
      )}

      {/* Spacer pushes footer to bottom */}
      <div className="flex-1" />

      {/* Sticky footer */}
      <div className="sticky bottom-0 mt-auto border-t border-border bg-panel px-3 py-3">
        {phase === "done" ? (
          /* Finish: single dominant primary */
          <button
            type="button"
            onClick={onRunDone}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-2.5 text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            <Check className="size-4" />
            {t("run.done")}
          </button>
        ) : (
          <div className="flex flex-col gap-2">
            {phase === "stopping" ? (
              /* Soft-stop requested — finishing the current hole. The operator can
               * still cancel while the bit is doing the current hole; cancel returns
               * the run to "running" without restarting (#515). */
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-[12px] font-medium text-warning">
                  <Loader2 className="size-4 shrink-0 animate-spin" />
                  {t("run.stopRequested")}
                </div>
                <button
                  type="button"
                  onClick={run.cancelStop}
                  title={t("run.cancelStopTitle")}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-card py-2.5 text-[12px] font-medium text-foreground transition-colors hover:bg-foreground/5"
                >
                  <X className="size-4" />
                  {t("run.cancelStop")}
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {/* Pause / Resume — disabled while a tool change or a pause is settling */}
                <button
                  type="button"
                  disabled={!controls.pause}
                  onClick={controls.pause ? (phase === "paused" ? run.resume : run.pause) : undefined}
                  className={cn(
                    "flex items-center justify-center gap-1.5 rounded-lg border border-border bg-card py-2.5 text-[12px] font-medium transition-colors",
                    controls.pause
                      ? "text-foreground hover:bg-foreground/5"
                      : "pointer-events-none text-muted-foreground/40",
                  )}
                >
                  {phase === "paused" ? (
                    <>
                      <Play className="size-4" />
                      {t("run.resume")}
                    </>
                  ) : phase === "pausing" ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      {t("run.pausing")}
                    </>
                  ) : (
                    <>
                      <Pause className="size-4" />
                      {t("run.pause")}
                    </>
                  )}
                </button>

                {/* Stop — outline red, two-line (graceful: finishes the current hole) */}
                <button
                  type="button"
                  disabled={!controls.stop}
                  onClick={run.stop}
                  title={t("run.stopTitle")}
                  className="flex flex-col items-center justify-center gap-0.5 rounded-lg border border-[hsl(0_60%_45%)]/40 bg-[hsl(0_60%_45%)]/10 py-2 text-[hsl(0_70%_65%)] transition-colors hover:bg-[hsl(0_60%_45%)]/20 disabled:pointer-events-none disabled:opacity-40"
                >
                  <span className="flex items-center gap-1.5 text-[12px] font-medium">
                    <Square className="size-3.5" />
                    {t("run.stop")}
                  </span>
                  <span className="text-[10px] opacity-70">{t("run.stopCaption")}</span>
                </button>
              </div>
            )}

            {/* Emergency stop — dominant solid red, full width */}
            <button
              type="button"
              onClick={run.estop}
              title={t("run.estopTitle")}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-red-700 bg-red-600 py-2.5 text-[13px] font-semibold text-white shadow-md transition-colors hover:bg-red-700 active:bg-red-800"
            >
              <OctagonX className="size-4" />
              {t("run.estopFull")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

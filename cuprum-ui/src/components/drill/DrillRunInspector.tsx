import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { DrillRunHeader } from "@/components/drill/DrillRunHeader";
import { DrillToolChangeCard } from "@/components/drill/DrillToolChangeCard";
import { DrillFinishCard } from "@/components/drill/DrillFinishCard";
import { DrillFeedSlider } from "@/components/drill/DrillFeedSlider";
import { activeGroupForHole } from "@/lib/drillRoute";
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
  feedOverridePct: number;
  grblFeedPct: number | undefined;
  onFeedChange: (pct: number) => void;
  onRunDone: () => void;
  hasProbe: boolean;
  probe: {
    maxDistMm: number;
    feedMmMin: number;
    offsetMm: number;
    safeZMm: number;
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
  feedOverridePct,
  grblFeedPct,
  onFeedChange,
  onRunDone,
  hasProbe,
  probe,
}: DrillRunInspectorProps) {
  const { t } = useTranslation("drill");
  const { state } = run;
  const { phase } = state;

  const elapsedSec = state.runStartedAt
    ? Math.floor((Date.now() - state.runStartedAt) / 1000)
    : 0;

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
        firstToolChange={state.toolChangeSeq === 1}
        route={route}
        datum={datum}
        panelWidthMm={panelWidthMm}
        panelHeightMm={panelHeightMm}
        totalEstimateSec={totalEstimateSec}
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
            probeChecked={state.probeChecked}
            lastManualZMm={state.lastManualZMm}
            onZBound={run.markZBound}
            onProbeChecked={run.markProbeChecked}
            onManualZ={run.markManualZ}
            onConfirm={run.confirmToolChange}
          />
        </div>
      )}

      {/* Finish card — only in done phase */}
      {phase === "done" && (
        <div className="pt-3">
          <DrillFinishCard
            holesTotal={state.holesTotal}
            elapsedSec={elapsedSec}
            onDone={onRunDone}
          />
        </div>
      )}

      {/* Feed override slider */}
      {showFeedSlider && (
        <div className="px-4 py-3 border-t border-border">
          <DrillFeedSlider
            value={feedOverridePct}
            grblPct={grblFeedPct}
            onChange={onFeedChange}
            disabled={false}
          />
        </div>
      )}

      {/* Spacer pushes footer to bottom */}
      <div className="flex-1" />

      {/* Sticky footer: pause/resume/stop controls (hidden on done) */}
      {phase !== "done" && (
        <div className="sticky bottom-0 mt-auto border-t border-border bg-panel p-3 flex flex-wrap gap-2">
          {/* Pause: visible while running */}
          {phase === "running" && (
            <Button size="sm" variant="secondary" onClick={run.pause} className="flex-1">
              {t("run.pause")}
            </Button>
          )}

          {/* Resume: visible while paused */}
          {phase === "paused" && (
            <Button size="sm" variant="secondary" onClick={run.resume} className="flex-1">
              {t("run.resume")}
            </Button>
          )}

          {/* Pausing spinner */}
          {phase === "pausing" && (
            <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground flex-1">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("run.pausing")}
            </span>
          )}

          {/* Stopping spinner */}
          {phase === "stopping" && (
            <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground flex-1">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("run.stopping")}
            </span>
          )}

          {/* Stop: visible while running, paused, or awaiting tool change */}
          {(phase === "running" || phase === "paused" || phase === "awaitingToolChange") && (
            <Button
              size="sm"
              variant="destructive"
              onClick={run.stop}
              title={t("run.stopTitle")}
            >
              {t("run.stop")}
            </Button>
          )}

          {/* Emergency stop: always visible while active */}
          <Button
            size="sm"
            className="border border-red-700 bg-red-600 font-semibold text-white shadow-md hover:bg-red-700 active:bg-red-800"
            onClick={run.estop}
            title={t("run.estopTitle")}
          >
            {t("run.estop")}
          </Button>
        </div>
      )}
    </div>
  );
}

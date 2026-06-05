import { useTranslation } from "react-i18next";
import { AlertTriangle, Loader2, WrenchIcon } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { DrillStep } from "@/lib/drillGcode";
import type { UseDrillRun } from "@/hooks/useDrillRun";

export interface DrillRunPanelProps {
  steps: DrillStep[];
  run: UseDrillRun;
}

/** Live-run control panel: connection gate, start/pause/resume/stop, progress,
 *  tool-change prompt, and error banner. Rendered in the drill window sidebar. */
export function DrillRunPanel({ steps, run }: DrillRunPanelProps) {
  const { t } = useTranslation("drill");
  const { state, connected, start, pause, resume, stop, estop, confirmToolChange } = run;
  const { phase } = state;

  const hasHoles = steps.some((s) => s.kind === "hole");
  const canStart = connected && (phase === "idle" || phase === "done" || phase === "error") && hasHoles;
  const isActive =
    phase === "running" ||
    phase === "pausing" ||
    phase === "paused" ||
    phase === "stopping" ||
    phase === "awaitingToolChange";

  return (
    <div className="flex flex-col gap-3 border-b border-border p-4 text-sm">
      {/* Connection gate hint */}
      {!connected && (
        <p className="text-[12px] text-muted-foreground">{t("run.notConnected")}</p>
      )}

      {/* Start / Pause / Resume / Stop row */}
      <div className="flex flex-wrap gap-2">
        {/* Start: visible when not active */}
        {!isActive && (
          <Button
            size="sm"
            disabled={!canStart}
            onClick={() => void start(steps)}
          >
            {t("run.start")}
          </Button>
        )}

        {/* Pausing spinner: shown while waiting for the bit to reach safe Z */}
        {phase === "pausing" && (
          <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("run.pausing")}
          </span>
        )}

        {/* Stopping spinner: shown while waiting for the current hole to finish */}
        {phase === "stopping" && (
          <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("run.stopping")}
          </span>
        )}

        {/* Pause: visible while running */}
        {phase === "running" && (
          <Button size="sm" variant="secondary" onClick={pause}>
            {t("run.pause")}
          </Button>
        )}

        {/* Resume: visible while paused */}
        {phase === "paused" && (
          <Button size="sm" variant="secondary" onClick={resume}>
            {t("run.resume")}
          </Button>
        )}

        {/* Stop (graceful): visible while running, paused, or awaiting tool change; hidden during pausing/stopping */}
        {(phase === "running" || phase === "paused" || phase === "awaitingToolChange") && (
          <Button
            size="sm"
            variant="destructive"
            onClick={stop}
            title={t("run.stopTitle")}
          >
            {t("run.stop")}
          </Button>
        )}

        {/* Emergency stop: always visible when active (including pausing/stopping) */}
        {isActive && (
          <Button
            size="sm"
            className="border border-red-700 bg-red-600 font-semibold text-white shadow-md hover:bg-red-700 active:bg-red-800"
            onClick={estop}
            title={t("run.estopTitle")}
          >
            {t("run.estop")}
          </Button>
        )}
      </div>

      {/* Progress counter */}
      {(phase === "running" || phase === "pausing" || phase === "paused" || phase === "stopping" || phase === "awaitingToolChange" || phase === "done") && (
        <p className="tabular-nums text-[12px] text-muted-foreground">
          {t("run.progress", { done: state.holesCompleted, total: state.holesTotal })}
        </p>
      )}

      {/* Tool-change prompt */}
      {phase === "awaitingToolChange" && state.toolChange && (
        <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
          <div className="flex items-center gap-1.5 font-medium text-amber-300">
            <WrenchIcon className="h-4 w-4 shrink-0" />
            <span>{t("run.toolChangeTitle")}</span>
          </div>
          <p className="text-[12px] text-amber-200">
            {t("run.toolChangePrompt", {
              diameter: state.toolChange.diameterMm,
              name: state.toolChange.toolName,
            })}
          </p>
          <Button size="sm" onClick={confirmToolChange}>
            {t("run.continue")}
          </Button>
        </div>
      )}

      {/* Setup hints (work zero + manual spindle), shown when not mid-run. */}
      {!isActive && (
        <div className="flex flex-col gap-1 border-t border-border pt-2 text-[11px] leading-relaxed text-muted-foreground">
          <p>{t("run.zeroHint")}</p>
          <p>{t("run.spindleHint")}</p>
        </div>
      )}

      {/* Error banner */}
      {phase === "error" && (
        <div className="flex flex-col gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2">
          <div className="flex items-start gap-1.5 text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="font-medium">{state.error}</span>
          </div>
          <p className="text-[12px] text-muted-foreground">{t("run.errorHint")}</p>
        </div>
      )}
    </div>
  );
}

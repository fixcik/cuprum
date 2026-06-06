import { useTranslation } from "react-i18next";
import { ListChecks } from "lucide-react";
import type { DrillClass } from "@/lib/api";
import type { PanelDrillPlan } from "@/lib/panelDrill";
import type { DrillRoute } from "@/lib/drillRoute";
import type { DrillStep } from "@/lib/drillGcode";
import type { DrillPass } from "@/lib/drillPasses";
import type { UseDrillRun } from "@/hooks/useDrillRun";
import { DrillPassStepper } from "@/components/drill/DrillPassStepper";
import { DrillRunPanel } from "@/components/drill/DrillRunPanel";
import { DrillSummary } from "@/components/drill/DrillSummary";

export interface DrillPlanInspectorProps {
  plan: PanelDrillPlan;
  route: DrillRoute;
  counts: Record<DrillClass, number>;
  activePassId: DrillPass["id"];
  onPassChange: (id: DrillPass["id"]) => void;
  run: UseDrillRun;
  /** Steps for the DrillRunPanel (from the emitted program). */
  programSteps: DrillStep[];
  onStart: () => void;
  /** Set/clear the class override for a diameter (forwarded to DrillSummary). */
  onSetClass: (diameterMm: number, klass: DrillClass | null) => void;
}

/** Right-panel inspector for the drill operation.
 *  Header + process stepper + run panel + summary (temporary: will be split into cards later). */
export function DrillPlanInspector({
  plan,
  route,
  counts,
  activePassId,
  onPassChange,
  run,
  programSteps,
  onStart,
  onSetClass,
}: DrillPlanInspectorProps) {
  const { t } = useTranslation("drill");

  // A run is "active" while any of these phases is live — block pass switching.
  const isRunActive =
    run.state.phase === "running" ||
    run.state.phase === "pausing" ||
    run.state.phase === "paused" ||
    run.state.phase === "stopping" ||
    run.state.phase === "awaitingToolChange";

  return (
    <aside className="flex h-full w-[368px] shrink-0 flex-col overflow-y-auto border-l border-border bg-panel">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <ListChecks className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 text-sm font-semibold text-foreground">{t("window.title")}</span>
        {/* Compact holes + tools badge */}
        <span className="text-xs tabular-nums text-muted-foreground">
          {t("summary.holes", { count: route.totalHoles })}
          {" · "}
          {t("summary.tools", { count: route.toolCount })}
        </span>
      </div>

      {/* Process stepper */}
      <DrillPassStepper
        activePassId={activePassId}
        counts={counts}
        disabled={isRunActive}
        onPassChange={onPassChange}
      />

      {/* Divider */}
      <div className="h-px bg-border" />

      {/* Run panel (temporary — will become its own card in a later task) */}
      <DrillRunPanel steps={programSteps} run={run} onStart={onStart} />

      {/* Summary (temporary — will become its own card in a later task) */}
      <DrillSummary plan={plan} route={route} onSetClass={onSetClass} />
    </aside>
  );
}

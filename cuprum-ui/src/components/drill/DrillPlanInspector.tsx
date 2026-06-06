import { useTranslation } from "react-i18next";
import { ListChecks } from "lucide-react";
import type { DrillClass } from "@/lib/api";
import type { PanelDrillPlan } from "@/lib/panelDrill";
import type { DrillRoute } from "@/lib/drillRoute";
import type { DrillStep } from "@/lib/drillGcode";
import type { DrillPass } from "@/lib/drillPasses";
import type { UseDrillRun } from "@/hooks/useDrillRun";
import type { DatumCorner } from "@/lib/datum";
import type { Tool } from "@/lib/toolLibrary";
import type { CncProfile } from "@/lib/cncProfile";
import { DrillPassStepper } from "@/components/drill/DrillPassStepper";
import { DrillRunPanel } from "@/components/drill/DrillRunPanel";
import { DrillSummary } from "@/components/drill/DrillSummary";
import { DrillHoleCard } from "@/components/drill/DrillHoleCard";
import { DrillPreflightSummary } from "@/components/drill/DrillPreflightSummary";

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
  /** Currently selected hole key (`${gi}-${hi}`); null = none. */
  selectedHoleId: string | null;
  /** Called when the user clears the hole selection from the card. */
  onClearHole: () => void;
  /** Which panel corner is the machine (0,0). */
  datum: DatumCorner;
  panelWidthMm: number;
  panelHeightMm: number;
  /** Tool library (for preflight time estimate). */
  tools: Tool[];
  /** CNC profile (for preflight time estimate). */
  cncProfile: CncProfile;
  /** Substrate thickness in mm (for preflight time estimate). */
  substrateThicknessMm: number;
}

/** Right-panel inspector for the drill operation.
 *  Header + process stepper + selected-hole card + preflight summary + run panel + summary. */
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
  selectedHoleId,
  onClearHole,
  datum,
  panelWidthMm,
  panelHeightMm,
  tools,
  cncProfile,
  substrateThicknessMm,
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

      {/* Selected-hole card (Task 2) — only visible when a hole is selected */}
      {selectedHoleId && (
        <div className="pt-3">
          <DrillHoleCard
            selectedHoleId={selectedHoleId}
            route={route}
            datum={datum}
            panelWidthMm={panelWidthMm}
            panelHeightMm={panelHeightMm}
            onClear={onClearHole}
          />
        </div>
      )}

      {/* Preflight 2×2 summary (Task 4) */}
      <div className={selectedHoleId ? "" : "pt-3"}>
        <DrillPreflightSummary
          route={route}
          tools={tools}
          cncProfile={cncProfile}
          substrateThicknessMm={substrateThicknessMm}
        />
      </div>

      {/* Divider */}
      <div className="h-px bg-border" />

      {/* Run panel (temporary — will become its own card in a later task) */}
      <DrillRunPanel steps={programSteps} run={run} onStart={onStart} />

      {/* Summary (temporary — will become its own card in a later task) */}
      <DrillSummary plan={plan} route={route} onSetClass={onSetClass} />
    </aside>
  );
}

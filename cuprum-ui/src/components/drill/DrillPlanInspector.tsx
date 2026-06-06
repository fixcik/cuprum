import { useTranslation } from "react-i18next";
import { ListChecks } from "lucide-react";
import type { DrillClass, MachineStateName } from "@/lib/api";
import type { PanelDrillPlan } from "@/lib/panelDrill";
import type { DrillRoute } from "@/lib/drillRoute";
import type { DrillStep } from "@/lib/drillGcode";
import type { DrillPass } from "@/lib/drillPasses";
import type { UseDrillRun } from "@/hooks/useDrillRun";
import type { DatumCorner } from "@/lib/datum";
import type { Tool } from "@/lib/toolLibrary";
import type { CncProfile } from "@/lib/cncProfile";
import type { ZGateResult } from "@/lib/zGate";
import { DrillPassStepper } from "@/components/drill/DrillPassStepper";
import { DrillRunPanel } from "@/components/drill/DrillRunPanel";
import { DrillToolsOrder } from "@/components/drill/DrillToolsOrder";
import { DrillWarnings } from "@/components/drill/DrillWarnings";
import { DrillHoleCard } from "@/components/drill/DrillHoleCard";
import { DrillPreflightSummary } from "@/components/drill/DrillPreflightSummary";
import { ZTouchOffCard } from "@/components/drill/ZTouchOffCard";

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
  /** Set/clear the class override for a diameter (forwarded to DrillToolsOrder). */
  onSetClass: (diameterMm: number, klass: DrillClass | null) => void;
  /** Override the drill bit (toolId) for a diameter key (forwarded to DrillToolsOrder). */
  onSetBitOverride: (diameterKey: string, toolId: string) => void;
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
  /** MPos Z captured at touch-off (null = not yet done). */
  workZeroMachineZ: number | null;
  /** Called when operator presses "Bind" on the Z touch-off card. */
  onTouchOff: () => void;
  /** Called when operator resets the captured Z. */
  onClearTouchOff: () => void;
  /** Pre-computed gate result (for exposing to the start button in a later task). */
  zGate: ZGateResult;
  /** Machine connection state (forwarded to ZTouchOffCard). */
  machineConnected: boolean;
  machineState: MachineStateName;
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
  onSetBitOverride,
  selectedHoleId,
  onClearHole,
  datum,
  panelWidthMm,
  panelHeightMm,
  tools,
  cncProfile,
  substrateThicknessMm,
  workZeroMachineZ,
  onTouchOff,
  onClearTouchOff,
  zGate: _zGate,
  machineConnected,
  machineState,
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

      {/* Z touch-off card (Task 3) */}
      <ZTouchOffCard
        connected={machineConnected}
        machineState={machineState}
        workZeroMachineZ={workZeroMachineZ}
        safeZMm={cncProfile.safeZMm}
        jogStepsMm={cncProfile.jogStepsMm}
        jogFeedMmMin={cncProfile.jogFeedMmMin}
        onTouchOff={onTouchOff}
        onClear={onClearTouchOff}
      />

      {/* Divider */}
      <div className="h-px bg-border" />

      {/* Run panel (temporary — will become its own card in a later task) */}
      <DrillRunPanel steps={programSteps} run={run} onStart={onStart} />

      {/* Tools order list with class + bit override */}
      <DrillToolsOrder
        route={route}
        tools={tools}
        onSetClass={onSetClass}
        onSetBitOverride={onSetBitOverride}
      />

      {/* Warnings: unmatched diameters, keepout-skipped, registration-in-keepout */}
      <DrillWarnings plan={plan} />
    </aside>
  );
}

import { useTranslation } from "react-i18next";
import { AlertTriangle, ListChecks } from "lucide-react";
import type { DrillClass } from "@/lib/api";
import type { PanelDrillPlan } from "@/lib/panelDrill";
import type { DrillRoute } from "@/lib/drillRoute";
import type { DrillPass } from "@/lib/drillPasses";
import type { UseDrillRun } from "@/hooks/useDrillRun";
import type { DatumCorner } from "@/lib/datum";
import type { Tool } from "@/lib/toolLibrary";
import type { CncProfile } from "@/lib/cncProfile";
import type { ZGateResult } from "@/lib/zGate";
import { Button } from "@/components/ui/Button";
import { DrillPassStepper } from "@/components/drill/DrillPassStepper";
import { DrillRunInspector } from "@/components/drill/DrillRunInspector";
import { DrillToolsOrder } from "@/components/drill/DrillToolsOrder";
import { DrillWarnings } from "@/components/drill/DrillWarnings";
import { DrillHoleCard } from "@/components/drill/DrillHoleCard";
import { DrillPreflightSummary } from "@/components/drill/DrillPreflightSummary";
import { WorkZeroCard } from "@/components/drill/WorkZeroCard";

export interface DrillPlanInspectorProps {
  plan: PanelDrillPlan;
  route: DrillRoute;
  counts: Record<DrillClass, number>;
  activePassId: DrillPass["id"];
  onPassChange: (id: DrillPass["id"]) => void;
  run: UseDrillRun;
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
  /** Called when the user changes the datum corner (now lives in inspector). */
  onDatumChange: (d: DatumCorner) => void;
  panelWidthMm: number;
  panelHeightMm: number;
  /** Tool library (for preflight time estimate). */
  tools: Tool[];
  /** CNC profile (for preflight time estimate). */
  cncProfile: CncProfile;
  /** Substrate thickness in mm (for preflight time estimate). */
  substrateThicknessMm: number;
  /** MPos Z captured at bind (null = not yet bound). Drives the Z gate. */
  workZeroMachineZ: number | null;
  /** Called when operator presses "Set zero here" on the work-zero card. */
  onBind: () => void;
  /** Called when operator resets the captured work zero. */
  onClear: () => void;
  /** Machine travel limits (mm) forwarded to WorkZeroCard for jog clamping. */
  maxXMm: number;
  maxYMm: number;
  maxZMm: number;
  /** Last work-zero bind error from GRBL (null = none). Shown as a banner. */
  zeroError: string | null;
  /** Pre-computed gate result for the start button. */
  zGate: ZGateResult;
  /** Whether the machine is connected (for footer start gate). */
  connected: boolean;
  /** Whether the spindle is software-controllable (false = 3018 manual dial). */
  spindleControllable: boolean;
  /** Whether the current pass has any holes to drill. */
  hasHoles: boolean;
  /** Feed override % sent to the machine (100 = nominal). */
  feedOverridePct: number;
  /** Live feed override % reported by GRBL. */
  grblFeedPct: number | undefined;
  /** Called when the operator moves the feed slider. */
  onFeedChange: (pct: number) => void;
  /** Called when the current run pass is completed. */
  onPassDone: () => void;
  /** Total estimated run time in seconds (for the run header). */
  totalEstimateSec: number;
  /** Pass ids already completed this session (rendered as checks in the stepper). */
  passDone: Set<DrillPass["id"]>;
}

/** Right-panel inspector for the drill operation.
 *  Header + process stepper + selected-hole card + preflight summary +
 *  datum grid + Z touch-off + run panel (only when active) + tools order +
 *  warnings + sticky start footer. */
export function DrillPlanInspector({
  plan,
  route,
  counts,
  activePassId,
  onPassChange,
  run,
  onStart,
  onSetClass,
  onSetBitOverride,
  selectedHoleId,
  onClearHole,
  datum,
  onDatumChange,
  panelWidthMm,
  panelHeightMm,
  tools,
  cncProfile,
  substrateThicknessMm,
  workZeroMachineZ,
  onBind,
  onClear,
  maxXMm,
  maxYMm,
  maxZMm,
  zeroError,
  zGate,
  connected,
  spindleControllable,
  hasHoles,
  feedOverridePct,
  grblFeedPct,
  onFeedChange,
  onPassDone,
  totalEstimateSec,
  passDone,
}: DrillPlanInspectorProps) {
  const { t } = useTranslation("drill");

  // mode: "run" when a run is live (any non-idle, non-error phase); "plan" otherwise.
  const mode =
    run.state.phase !== "idle" && run.state.phase !== "error" ? "run" : "plan";

  // Whether pass switching and plan editing are blocked.
  const isRunActive = mode === "run";

  // Gate: the footer start button is disabled when any of these conditions hold.
  const startDisabled =
    !connected || !hasHoles || zGate.valid === false || isRunActive;

  // Hint shown below the start button when a gate condition blocks the run.
  let startHint: string | null = null;
  if (!connected) {
    startHint = t("run.notConnected");
  } else if (!hasHoles) {
    startHint = t("run.noHolesForPass");
  } else if (zGate.valid === false) {
    if (zGate.reason === "not-zeroed") {
      startHint = t("workzero.notZeroedHint");
    } else {
      startHint = t("workzero.tooHigh");
    }
  }

  // Datum corner layout: 2×2 grid (top row: top-left / top-right; bottom row: bottom-left / bottom-right).
  const datumGrid: [DatumCorner, DatumCorner][] = [
    ["top-left", "top-right"],
    ["bottom-left", "bottom-right"],
  ];

  return (
    <aside className="flex h-full w-[368px] shrink-0 flex-col overflow-hidden border-l border-border bg-panel">
      {/* Header — always visible in both modes */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3 shrink-0">
        <ListChecks className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 text-sm font-semibold text-foreground">{t("window.title")}</span>
        {/* Compact holes + tools badge */}
        <span className="text-xs tabular-nums text-muted-foreground">
          {t("summary.holes", { count: route.totalHoles })}
          {" · "}
          {t("summary.tools", { count: route.toolCount })}
        </span>
      </div>

      {/* Run-error banner (PLAN mode): surfaces why the last run stopped. */}
      {run.state.phase === "error" && run.state.error && (
        <div className="flex items-start gap-2 border-b border-rose-500/40 bg-rose-500/10 px-4 py-2 text-[11px] text-rose-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="flex-1">
            <div>{run.state.error}</div>
            <div className="text-rose-300/70">{t("run.errorHint")}</div>
          </div>
          <button
            type="button"
            aria-label={t("hole.clear")}
            onClick={() => run.reset()}
            className="shrink-0 text-rose-300/70 hover:text-rose-200"
          >
            ✕
          </button>
        </div>
      )}

      {mode === "run" ? (
        /* ── RUN mode ── */
        <DrillRunInspector
          run={run}
          route={route}
          datum={datum}
          panelWidthMm={panelWidthMm}
          panelHeightMm={panelHeightMm}
          totalEstimateSec={totalEstimateSec}
          feedOverridePct={feedOverridePct}
          grblFeedPct={grblFeedPct}
          onFeedChange={onFeedChange}
          onPassDone={onPassDone}
        />
      ) : (
        /* ── PLAN mode ── */
        <>
          {/* Process stepper */}
          <DrillPassStepper
            activePassId={activePassId}
            counts={counts}
            disabled={isRunActive}
            onPassChange={onPassChange}
            donePassIds={passDone}
          />

          {/* Divider */}
          <div className="h-px bg-border" />

          {/* Scrollable plan content */}
          <div className="flex flex-col flex-1 overflow-y-auto">
            {/* Selected-hole card — only visible when a hole is selected */}
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

            {/* Preflight 2×2 summary */}
            <div className={selectedHoleId ? "" : "pt-3"}>
              <DrillPreflightSummary
                route={route}
                tools={tools}
                cncProfile={cncProfile}
                substrateThicknessMm={substrateThicknessMm}
              />
            </div>

            {/* Datum corner — 2×2 grid */}
            <div className="border-t border-border px-4 py-3">
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t("datum.label")}
              </p>
              <div className="grid grid-cols-2 gap-1.5">
                {datumGrid.map((row) =>
                  row.map((corner) => (
                    <button
                      key={corner}
                      type="button"
                      onClick={() => onDatumChange(corner)}
                      className={
                        "rounded-md border px-2 py-1.5 text-[12px] transition-colors cursor-pointer " +
                        (datum === corner
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border text-muted-foreground hover:border-slate-500 hover:text-foreground")
                      }
                    >
                      {t(`datum.${corner}`)}
                    </button>
                  )),
                )}
              </div>
            </div>

            {/* Unified XYZ work-zero card */}
            <WorkZeroCard
              workZeroMachineZ={workZeroMachineZ}
              safeZMm={cncProfile.safeZMm}
              maxXMm={maxXMm}
              maxYMm={maxYMm}
              maxZMm={maxZMm}
              onBind={onBind}
              onClear={onClear}
            />

            {/* Work-zero bind error from GRBL (command rejected → zero NOT set). */}
            {zeroError && (
              <div className="mx-4 mb-3 flex items-start gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-300">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{t("zero.bindRejected", { error: zeroError })}</span>
              </div>
            )}

            {/* Divider */}
            <div className="h-px bg-border" />

            {/* Tools order list with class + bit override */}
            <DrillToolsOrder
              route={route}
              tools={tools}
              onSetClass={onSetClass}
              onSetBitOverride={onSetBitOverride}
            />

            {/* Warnings: unmatched diameters, keepout-skipped, registration-in-keepout */}
            <DrillWarnings plan={plan} />

            {/* Spacer to push footer to bottom when content is short */}
            <div className="flex-1" />
          </div>

          {/* Sticky footer: spindle note + start button */}
          <div className="sticky bottom-0 mt-auto border-t border-border bg-panel p-3 flex flex-col gap-2 shrink-0">
            {/* Manual spindle note for 3018 (spindleControllable=false) */}
            {!spindleControllable && (
              <p className="text-[11px] italic text-muted-foreground">
                {t("run.spindleHint")}
              </p>
            )}

            {/* Start button */}
            <Button
              size="sm"
              disabled={startDisabled}
              onClick={onStart}
              className="w-full"
            >
              {t("run.start")} · {t(`pass.${activePassId}`)}
            </Button>

            {/* Gate hint below the button */}
            {startHint && (
              <div className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                <p className="text-[11px] text-amber-400">{startHint}</p>
              </div>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ListChecks } from "lucide-react";
import type { PanelDrillPlan } from "@/lib/panelDrill";
import type { DrillClass } from "@/lib/api";
import type { DrillRoute } from "@/lib/drillRoute";
import type { UseDrillRun } from "@/hooks/useDrillRun";
import type { DatumCorner } from "@/lib/datum";
import type { Tool } from "@/lib/toolLibrary";
import type { CncProfile } from "@/lib/cncProfile";
import type { ZGateResult } from "@/lib/zGate";
import type { XYGateResult } from "@/lib/xyGate";
import { Button } from "@/components/ui/Button";
import { DrillSelectionControls } from "@/components/drill/DrillSelectionControls";
import { DrillRunInspector } from "@/components/drill/DrillRunInspector";
import { DrillToolsOrder } from "@/components/drill/DrillToolsOrder";
import { DrillWarnings } from "@/components/drill/DrillWarnings";
import { DrillHoleCard } from "@/components/drill/DrillHoleCard";
import { DrillPreflightSummary } from "@/components/drill/DrillPreflightSummary";
import { WorkZeroStatusCard } from "@/components/drill/WorkZeroStatusCard";
import { DrillZeroInspector } from "@/components/drill/DrillZeroInspector";
import { formatXYViolations } from "@/lib/xyGate";
import { useUnitFormat } from "@/i18n/useUnitFormat";

export interface DrillPlanInspectorProps {
  /** The full (unfiltered) drill plan — passed to DrillSelectionControls for id-based presets. */
  fullPlan: PanelDrillPlan;
  /** The current sub-plan (selected holes only, with overrides applied). Used for tool list + warnings. */
  plan: PanelDrillPlan;
  route: DrillRoute;
  counts: Record<DrillClass, number>;
  /** Currently selected hole ids (stable). */
  selectedHoleIds: Set<string>;
  /** Called when the user changes the selection. */
  onSelectedHoleIdsChange: (s: Set<string>) => void;
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
  /** Bind the work zero. Returns true on success so the zero mode can close. */
  onBind: () => boolean | Promise<boolean>;
  /** Called when operator resets the captured work zero. */
  onClear: () => void;
  /** Machine travel limits (mm) forwarded to WorkZeroCard for jog clamping. */
  maxXMm: number;
  maxYMm: number;
  maxZMm: number;
  /** Last work-zero bind error from GRBL (null = none). Shown as a banner. */
  zeroError: string | null;
  /** Pre-computed Z gate result for the start button. */
  zGate: ZGateResult;
  /** Pre-computed XY gate result (hole bbox vs machine envelope) for the start button. */
  xyGate: XYGateResult;
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
  /** Called when the current run is completed. */
  onRunDone: () => void;
  /** Total estimated run time in seconds (for the run header). */
  totalEstimateSec: number;
}

/** Right-panel inspector for the drill operation.
 *  Header + process stepper + selected-hole card + preflight summary +
 *  datum grid + Z touch-off + run panel (only when active) + tools order +
 *  warnings + sticky start footer. */
export function DrillPlanInspector({
  fullPlan,
  plan,
  route,
  counts,
  selectedHoleIds,
  onSelectedHoleIdsChange,
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
  xyGate,
  connected,
  spindleControllable,
  hasHoles,
  feedOverridePct,
  grblFeedPct,
  onFeedChange,
  onRunDone,
  totalEstimateSec,
}: DrillPlanInspectorProps) {
  const { t } = useTranslation("drill");
  const { fmtLen } = useUnitFormat();

  // mode: "run" when a run is live (any non-idle, non-error phase); "plan" otherwise.
  const mode =
    run.state.phase !== "idle" && run.state.phase !== "error" ? "run" : "plan";

  // Whether pass switching and plan editing are blocked.
  const isRunActive = mode === "run";

  // Inspector sub-mode within "plan": the plan list ⇄ the zero-binding controls.
  // The canvas does not change when switching — only the right sidebar swaps.
  const [panelMode, setPanelMode] = useState<"plan" | "zero">("plan");
  // A run takes over the inspector; collapse back to the plan list so we don't
  // return into the zero mode after the run ends.
  useEffect(() => {
    if (isRunActive) setPanelMode("plan");
  }, [isRunActive]);

  const workZeroSet = workZeroMachineZ !== null;
  // Returning to the plan after a bind is driven explicitly by the zero mode's
  // bind button (await onBind → onBack), so it also fires on a re-bind when the
  // zero was already set (no false→true transition to observe).

  // Gate: the footer start button is disabled when any of these conditions hold.
  const startDisabled =
    !connected || !hasHoles || zGate.valid === false || xyGate.valid === false || isRunActive;

  // Hint shown below the start button when a gate condition blocks the run.
  // Z gate (touch-off) takes priority over the XY gate: the operator binds zero
  // first, and a missing bind closes both — show the bind hint, not an XY overrun.
  let startHint: string | null = null;
  if (!connected) {
    startHint = t("run.notConnected");
  } else if (!hasHoles) {
    startHint = t("run.noHolesSelected");
  } else if (zGate.valid === false) {
    if (zGate.reason === "not-zeroed") {
      startHint = t("workzero.notZeroedHint");
    } else {
      startHint = t("workzero.tooHigh");
    }
  } else if (xyGate.valid === false) {
    // "out-of-bounds" → overrun detail; "not-zeroed" → fall back to the bind hint
    // (today this coincides with the zGate not-zeroed case above, but stay robust
    // if Z/XY binding ever splits).
    startHint =
      xyGate.reason === "out-of-bounds"
        ? t("workzero.xyOutOfBounds", { detail: formatXYViolations(xyGate.violations, fmtLen) })
        : t("workzero.notZeroedHint");
  }

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
          onRunDone={onRunDone}
          hasProbe={cncProfile.hasProbe}
          probe={{
            maxDistMm: cncProfile.probeMaxDistMm,
            feedMmMin: cncProfile.probeFeedMmMin,
            offsetMm: cncProfile.probePlateOffsetMm,
            safeZMm: cncProfile.safeZMm,
          }}
        />
      ) : panelMode === "zero" ? (
        /* ── ZERO-BINDING mode ── */
        <DrillZeroInspector
          datum={datum}
          onDatumChange={onDatumChange}
          onBack={() => setPanelMode("plan")}
          isSet={workZeroSet}
          plan={plan}
          panelWidthMm={panelWidthMm}
          panelHeightMm={panelHeightMm}
          workZeroMachineZ={workZeroMachineZ}
          safeZMm={cncProfile.safeZMm}
          maxXMm={maxXMm}
          maxYMm={maxYMm}
          maxZMm={maxZMm}
          xyGate={xyGate}
          onBind={onBind}
          onClear={onClear}
          zeroError={zeroError}
        />
      ) : (
        /* ── PLAN mode ── */
        <>
          {/* Class selection presets + per-class chips */}
          <DrillSelectionControls
            plan={fullPlan}
            counts={counts}
            selectedHoleIds={selectedHoleIds}
            onChange={onSelectedHoleIdsChange}
            disabled={isRunActive}
          />

          {/* Divider */}
          <div className="h-px bg-border" />

          {/* Scrollable plan content */}
          <div className="flex flex-col flex-1 overflow-y-auto">
            {/* Inspected-hole card — only visible when a hole is inspected */}
            {selectedHoleId && (
              <div className="pt-3">
                <DrillHoleCard
                  selectedHoleId={selectedHoleId}
                  plan={fullPlan}
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

            {/* Work zero — compact status card-button (opens the zero-binding mode) */}
            <div className="border-t border-border">
              <WorkZeroStatusCard
                isSet={workZeroSet}
                datum={datum}
                xyGate={xyGate}
                onOpen={() => {
                  onClearHole();
                  setPanelMode("zero");
                }}
              />
            </div>

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
              {t("run.start")} · {t("summary.holes", { count: route.totalHoles })}
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

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ListChecks } from "lucide-react";
import { AlarmActions } from "@/components/machine/AlarmActions";
import { LimitRecoveryNotice } from "@/components/machine/LimitRecoveryNotice";
import type { PanelDrillPlan } from "@/lib/panelDrill";
import type { AlignmentPoint, DrillClass, DrillEstimate, ToolingHole } from "@/lib/api";
import type { DrillRoute } from "@/lib/drillRoute";
import type { UseDrillRun } from "@/hooks/useDrillRun";
import type { DatumCorner } from "@/lib/datum";
import type { Tool } from "@/lib/toolLibrary";
import type { CncProfile } from "@/lib/cncProfile";
import type { XYGateResult } from "@/lib/xyGate";
import type { ZGateResult } from "@/lib/zGate";
import { Button } from "@/components/ui/Button";
import { DrillSelectionControls } from "@/components/drill/DrillSelectionControls";
import { DrillRunInspector } from "@/components/drill/DrillRunInspector";
import { DrillToolsOrder } from "@/components/drill/DrillToolsOrder";
import { DrillWarnings } from "@/components/drill/DrillWarnings";
import { DrillHoleCard } from "@/components/drill/DrillHoleCard";
import { DrillPreflightSummary } from "@/components/drill/DrillPreflightSummary";
import { WorkZeroStatusCard } from "@/components/drill/WorkZeroStatusCard";
import { ConnBar } from "@/components/machine/ConnBar";
import { DrillZeroInspector } from "@/components/drill/DrillZeroInspector";
import { WorkZeroPointsWizard } from "@/components/drill/WorkZeroPointsWizard";
import { api } from "@/lib/api";
import { formatXYViolations } from "@/lib/xyGate";
import { formatZReasons } from "@/lib/zGate";
import { useUnitFormat } from "@/i18n/useUnitFormat";
import { effectiveAlignmentPoints, isProbeable } from "@/lib/alignmentPoints";
import { cardState, methodAvailability } from "@/lib/workZeroMethods";
import { useWorkZeroMethod } from "@/workZeroMethodStore";
import { WorkZeroMethodPicker } from "@/components/drill/WorkZeroMethodPicker";

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
  /** Tool library (for the tools-order list). */
  tools: Tool[];
  /** CNC profile (probe params for run mode). */
  cncProfile: CncProfile;
  /** Backend-computed motion-time estimate (for the preflight summary). Null
   *  while the plan is still being computed. */
  estimate: DrillEstimate | null;
  /** Whether the XY work zero has been bound. Drives the gate + zero-mode badge. */
  workZeroSet: boolean;
  /** Bind the work zero. Returns true on success so the zero mode can close. */
  onBind: () => boolean | Promise<boolean>;
  /** Called when operator resets the captured work zero. */
  onClear: () => void;
  /** Record a zero programmed by the points-wizard solve (fiducial_solve sets
   *  G54 itself); forwards the solved machine origin to useDrillGates. */
  onZeroSolved: (workOrigin: { x: number; y: number }) => void;
  /** Machine travel limits (mm) forwarded to DrillZeroInspector for jog clamping. */
  maxXMm: number;
  maxYMm: number;
  maxZMm: number;
  /** Last work-zero bind error from GRBL (null = none). Shown as a banner. */
  zeroError: string | null;
  /** Pre-computed XY gate result (hole bbox vs machine envelope) for the start button. */
  xyGate: XYGateResult;
  /** Pre-computed Z gate result (depth / tool-change retract vs Z travel). */
  zGate: ZGateResult;
  /** Whether the machine is connected (for footer start gate). */
  connected: boolean;
  /** Whether the spindle is software-controllable (false = 3018 manual dial). */
  spindleControllable: boolean;
  /** Whether the current pass has any holes to drill. */
  hasHoles: boolean;
  /** Feed override % sent to the machine (100 = nominal). */
  feedOverridePct: number;
  /** Called when the operator moves the feed slider. */
  onFeedChange: (pct: number) => void;
  /** Called when the current run is completed. */
  onRunDone: () => void;
  /** Total estimated run time in seconds (for the run header). */
  totalEstimateSec: number;
  /** Per-group motion estimate (s) from the Rust plan; feeds the run header's "until
   *  next tool change" readout. */
  groupMotionSecs: number[];
  /** Per-group feed-limited (G1 plunge) seconds — scaled by feed override in the header. */
  groupFeedSecs: number[];
  /** Deepest plunge depth (mm) = substrate thickness + breakthrough; feeds the
   *  tool-change card's Z-headroom guard. */
  plungeDepthMm: number;
  /** All panel tooling holes — used by the fiducial registration panel. */
  toolingHoles: ToolingHole[];
  /** User-placed panel alignment points — drive method 2/3 availability facts. */
  alignmentPoints: AlignmentPoint[];
}

/** Right-panel inspector for the drill operation.
 *  Header + process stepper + selected-hole card + preflight summary +
 *  datum grid + XY touch-off + run panel (only when active) + tools order +
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
  estimate,
  workZeroSet,
  onBind,
  onClear,
  onZeroSolved,
  maxXMm,
  maxYMm,
  maxZMm,
  zeroError,
  xyGate,
  zGate,
  connected,
  spindleControllable,
  hasHoles,
  feedOverridePct,
  onFeedChange,
  onRunDone,
  totalEstimateSec,
  groupFeedSecs,
  groupMotionSecs,
  plungeDepthMm,
  toolingHoles,
  alignmentPoints,
}: DrillPlanInspectorProps) {
  const { t } = useTranslation("drill");
  const { fmtLen } = useUnitFormat();

  // mode: "run" when a run is live (any non-idle, non-error phase); "plan" otherwise.
  const mode =
    run.state.phase !== "idle" && run.state.phase !== "error" ? "run" : "plan";

  // Whether pass switching and plan editing are blocked.
  const isRunActive = mode === "run";

  // Inspector sub-mode within "plan": the plan list ⇄ the registration-method
  // picker ⇄ the zero-binding controls (method 1) ⇄ the points wizard (method 2).
  // The canvas does not change when switching — only the right sidebar swaps.
  const [panelMode, setPanelMode] = useState<"plan" | "method" | "zero" | "wizard2">("plan");
  // A run takes over the inspector; collapse back to the plan list so we don't
  // return into the zero mode after the run ends.
  useEffect(() => {
    if (isRunActive) setPanelMode("plan");
  }, [isRunActive]);

  // Method metadata of the current bind (session-scoped). The machine-side
  // "zero is bound" fact is owned by useDrillGates; keep the annotation in sync —
  // any invalidation (homing, disconnect, manual clear) also drops the method.
  const workZeroBinding = useWorkZeroMethod((s) => s.workZero);
  const setWorkZeroBinding = useWorkZeroMethod((s) => s.setWorkZero);
  const clearWorkZeroBinding = useWorkZeroMethod((s) => s.clearWorkZero);
  useEffect(() => {
    if (!workZeroSet) clearWorkZeroBinding();
  }, [workZeroSet, clearWorkZeroBinding]);

  // Effective alignment points (auto fiducials + user points) → method 2/3 facts.
  const alignPoints = useMemo(
    () => effectiveAlignmentPoints(toolingHoles, alignmentPoints),
    [toolingHoles, alignmentPoints],
  );
  const probeableCount = useMemo(() => alignPoints.filter((p) => isProbeable(p.point)).length, [alignPoints]);

  // Method availability for the picker screen. probeReady is hard false in this
  // phase — the 3D-touch-probe equipment config (and its wizard) land next.
  const availability = methodAvailability({
    connected,
    probeReady: false,
    probeableCount,
  });

  // Presentation state of the work-zero status card.
  const zeroCardState = cardState({
    connected,
    workZeroSet,
    binding: workZeroBinding,
    xyOverrun: xyGate.valid === false && xyGate.reason === "out-of-bounds",
  });

  // Gate: the footer start button is disabled when any of these conditions hold.
  const startDisabled =
    !connected || !hasHoles || xyGate.valid === false || zGate.valid === false || isRunActive;

  // Hint shown below the start button when a gate condition blocks the run.
  // While disconnected, the footer shows <ConnBar> instead of a text hint — this
  // guard short-circuits the chain so downstream hints ("bind XY", "no holes")
  // don't pile on with guidance the operator can't act on until connected.
  let startHint: string | null = null;
  if (!connected) {
    startHint = null;
  } else if (!hasHoles) {
    startHint = t("run.noHolesSelected");
  } else if (xyGate.valid === false) {
    startHint =
      xyGate.reason === "out-of-bounds"
        ? t("workzero.xyOutOfBounds", { detail: formatXYViolations(xyGate.violations, fmtLen) })
        : t("zeroMethod.startHint");
  } else if (zGate.valid === false) {
    startHint = t("workzero.zDoesNotFit", {
      detail: formatZReasons(zGate.reasons, (r) => t(`workzero.zReason.${r}`)),
    });
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
          {/* Unlocking clears the alarm; also dismiss this banner (gated on the
              run's own error phase, which $X alone won't change). */}
          <AlarmActions onUnlock={() => run.reset()} />
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

      {/* Stuck limit-switch recovery — plain `$X` (above) can't pull off an engaged
          switch with hard limits on, and `$H` then can't home. Self-gating: renders
          only when a limit pin is active. Same flow as manual control, surfaced here
          so an alarm during drilling isn't a dead end in this window. */}
      <div className="px-4 py-2 [&:empty]:hidden">
        <LimitRecoveryNotice />
      </div>

      {mode === "run" ? (
        /* ── RUN mode ── */
        <DrillRunInspector
          run={run}
          route={route}
          datum={datum}
          panelWidthMm={panelWidthMm}
          panelHeightMm={panelHeightMm}
          totalEstimateSec={totalEstimateSec}
          groupMotionSecs={groupMotionSecs}
          groupFeedSecs={groupFeedSecs}
          plungeDepthMm={plungeDepthMm}
          feedOverridePct={feedOverridePct}
          onFeedChange={onFeedChange}
          onRunDone={onRunDone}
          hasProbe={cncProfile.hasProbe}
          probe={{
            maxDistMm: cncProfile.probeMaxDistMm,
            feedMmMin: cncProfile.probeFeedMmMin,
            offsetMm: cncProfile.probePlateOffsetMm,
            safeZMm: cncProfile.safeZMm,
            toolChangeZMm: cncProfile.toolChangeZMm,
            // First tool has no work-Z datum to rapid toward — the probe seeks the
            // surface across the full Z travel from the current (post-homing) Z.
            firstMaxDistMm: cncProfile.workEnvelopeMm.z,
          }}
        />
      ) : panelMode === "method" ? (
        /* ── METHOD-SELECTION mode ── */
        <WorkZeroMethodPicker
          onBack={() => setPanelMode("plan")}
          onPickMethod={(m) => {
            // The picker never calls this for unavailable methods; method 3
            // (probe wizard) stays unavailable until its phase ships.
            if (m === 1) setPanelMode("zero");
            else if (m === 2) setPanelMode("wizard2");
          }}
          availability={availability}
          pointCount={alignPoints.length}
          probeableCount={probeableCount}
        />
      ) : panelMode === "zero" ? (
        /* ── ZERO-BINDING mode (method 1 · corner datum) ── */
        <DrillZeroInspector
          datum={datum}
          onDatumChange={onDatumChange}
          onBack={() => setPanelMode("method")}
          onDone={() => {
            setWorkZeroBinding({ method: 1, rmsMm: null, angleDeg: null });
            // A corner bind replaces any earlier points registration — drop the
            // backend's residual rotation so drill_plan doesn't keep applying it.
            void api.fiducial.reset();
            setPanelMode("plan");
          }}
          workZeroSet={workZeroSet}
          plan={plan}
          panelWidthMm={panelWidthMm}
          panelHeightMm={panelHeightMm}
          maxXMm={maxXMm}
          maxYMm={maxYMm}
          maxZMm={maxZMm}
          xyGate={xyGate}
          onBind={onBind}
          onClear={onClear}
          zeroError={zeroError}
        />
      ) : panelMode === "wizard2" ? (
        /* ── POINTS WIZARD mode (method 2 · manual capture) ── */
        <WorkZeroPointsWizard
          points={alignPoints}
          datum={datum}
          panelWidthMm={panelWidthMm}
          panelHeightMm={panelHeightMm}
          maxXMm={maxXMm}
          maxYMm={maxYMm}
          maxZMm={maxZMm}
          plan={plan}
          onCancel={() => setPanelMode("method")}
          onApplied={({ rmsMm, angleDeg, workOrigin }) => {
            // The solve already programmed G54 on the controller; record the
            // solved origin in the gates, annotate the binding, back to plan.
            onZeroSolved(workOrigin);
            setWorkZeroBinding({ method: 2, rmsMm, angleDeg });
            setPanelMode("plan");
          }}
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

            {/* Preflight 2×2 summary — shown once the backend estimate is ready */}
            {estimate && (
              <div className={selectedHoleId ? "" : "pt-3"}>
                <DrillPreflightSummary route={route} estimate={estimate} />
              </div>
            )}

            {/* Work zero — compact status card-button (opens the method picker). */}
            <div className="border-t border-border">
              <WorkZeroStatusCard
                state={zeroCardState}
                onOpen={() => {
                  onClearHole();
                  setPanelMode("method");
                }}
                onReset={() => {
                  onClear();
                  clearWorkZeroBinding();
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

            {/* Inline machine connect — gate the run right here instead of sending
                the operator to Equipment → Control. Always shown: pick the CNC
                profile + connect while disconnected; once connected it collapses to
                a slim "● name · port · Disconnect" status row, so the operator can
                see what's connected and switch machines by disconnecting first. */}
            <ConnBar compact machinePicker connectedSummary skipReattach />

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

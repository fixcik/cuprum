import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { type DrillClass, DEFAULT_FR4_THICKNESS_MM } from "@/lib/api";
import { useDrillScreenData } from "@/hooks/useDrillScreenData";
import { useDrillPlan } from "@/hooks/useDrillPlan";
import { useDrillRun } from "@/hooks/useDrillRun";
import { emitDrillProgram, DEFAULT_BREAKTHROUGH_MM } from "@/lib/drillGcode";
import { planDrillRoute } from "@/lib/drillRoute";
import { datumCornerPanelPoint } from "@/lib/datum";
import { filterPlanByClasses, classCounts, passToClasses, DRILL_CLASSES, DRILL_PASSES } from "@/lib/drillPasses";
import type { DrillPass } from "@/lib/drillPasses";
import { estimateDrill } from "@/lib/drillEstimate";
import { DrillMapCanvas } from "@/components/drill/DrillMapCanvas";
import { DrillPlanInspector } from "@/components/drill/DrillPlanInspector";
import { DrillCanvasTopBar } from "@/components/drill/DrillCanvasTopBar";
import { useMachinePosition } from "@/hooks/useMachinePosition";
import { useDrillPhaseProgress } from "@/hooks/useDrillPhaseProgress";
import { shouldShowMarker } from "@/lib/machineMarker";
import { useSettings } from "@/settingsStore";
import { useShell } from "@/shellStore";
import { useMachine } from "@/machineStore";
import { api } from "@/lib/api";
import { canMove } from "@/lib/machineControls";
import { checkZGate } from "@/lib/zGate";

/** Drill operation editor — sourceable inline (no IPC).
 *  Builds the drill snapshot directly from stores via useDrillScreenData,
 *  then renders the hole map, pass selector, summary, and run panel. */
export function DrillOperationEditor() {
  const { t } = useTranslation("drill");

  const snap = useDrillScreenData();

  // useDrillPlan now returns only the full plan (no route — route is computed here
  // after filtering by the selected class set).
  const { plan, loading } = useDrillPlan(snap);

  // Ephemeral bit overrides: diameterKey (String(Math.round(d*1000))) → toolId.
  // These patch the filteredPlan so both route and program use the override.
  const [bitOverrides, setBitOverrides] = useState<Map<string, string>>(new Map());

  const panel = snap?.manifest?.panel ?? null;
  const hasProject = !!(snap?.workingDir && snap.manifest);

  // Shop settings for the G-code context come from the snapshot (pushed live by
  // the main window), so profile/tool edits apply without restarting this window.
  const cncProfile = snap?.cncProfile ?? null;
  const tools = snap?.tools ?? [];
  const substrateThicknessMm =
    snap?.manifest?.stackup?.substrate_thickness_mm ?? DEFAULT_FR4_THICKNESS_MM;

  // Datum corner: drill-screen-owned setting (persisted in settings).
  const drillDatumCorner = useSettings((s) => s.drillDatumCorner);
  const setDrillDatumCorner = useSettings((s) => s.setDrillDatumCorner);

  // Build keep-out zones from the panel manifest (panel-space coords).
  const zones = useMemo(
    () =>
      (snap?.manifest?.panel?.keep_out_zones ?? []).map((z) => ({
        x: z.x_mm,
        y: z.y_mm,
        w: z.width_mm,
        h: z.height_mm,
      })),
    [snap?.manifest?.panel?.keep_out_zones],
  );

  // Drill-window-owned active pass; selected class set is derived from it.
  const [activePassId, setActivePassId] = useState<DrillPass["id"]>("alignment");
  const selected = useMemo(() => passToClasses(activePassId), [activePassId]);

  // Visibility (which classes are shown on the canvas). Independent of run-selection.
  const [visibleClasses, setVisibleClasses] = useState<Set<DrillClass>>(new Set(DRILL_CLASSES));
  // Canvas view toggles.
  const [showPath, setShowPath] = useState(true);
  const [showDiameters, setShowDiameters] = useState(false);

  // Selected hole on the drill canvas (key = `${gi}-${hi}`); null = none.
  const [selectedHoleId, setSelectedHoleId] = useState<string | null>(null);

  // Z touch-off: MPos Z captured at the copper surface (null = not yet touched off).
  const [workZeroMachineZ, setWorkZeroMachineZ] = useState<number | null>(null);

  // Work X-Y zero bound at the datum corner this session (ephemeral). The run's
  // G-code is in work coords (origin = datum corner), so this must be set or the
  // run lands off the panel.
  const [workZeroXYSet, setWorkZeroXYSet] = useState(false);

  // Last work-zero bind error from GRBL (e.g. the command was rejected). Shown to
  // the operator; while set it means the corresponding zero was NOT applied.
  const [zeroError, setZeroError] = useState<string | null>(null);

  // Feed override % sent via UI (100 = nominal). Applied by sending GRBL real-time commands.
  const [feedOverridePct, setFeedOverridePct] = useState(100);

  // Completed pass ids for this session (used by the stepper checkmarks).
  const [passDone, setPassDone] = useState<Set<DrillPass["id"]>>(new Set());
  // Monotonic token to cancel a superseded feed-override step sequence.
  const feedSeqRef = useRef(0);

  // Machine connection state for touch-off guards.
  const machineConnected = useMachine((s) => s.connected);
  const machineState = useMachine((s) => s.status.state);
  const machineHomed = useMachine((s) => s.homed);
  // Live feed override % reported by GRBL (overrides[0]), may be undefined until first status.
  const grblFeedPct = useMachine((s) => s.status.overrides?.[0]);

  // A homing cycle (or alarm/disconnect that voids `homed`) invalidates BOTH the Z
  // touch-off and the X-Y zero: the captured machine references no longer map to
  // the panel. Force a re-bind so the start gate can't pass on a stale reference.
  useEffect(() => {
    if (!machineHomed || machineState === "home") {
      setWorkZeroMachineZ(null);
      setWorkZeroXYSet(false);
    }
  }, [machineHomed, machineState]);

  // Set the Z work zero (G54) at the copper surface, waiting for GRBL to accept it.
  // Only on a confirmed `ok` do we capture MPos Z and pass the gate — a rejected
  // command leaves Z un-zeroed (gate stays closed) instead of crashing the run in
  // a stale coordinate system. Captures MPos AFTER the ack.
  const handleTouchOff = useCallback(async () => {
    const { status, connected } = useMachine.getState();
    if (!canMove(status.state, connected)) return;
    try {
      await api.machine.setZero(false, false, true); // G10 L20 P1 Z0, awaits ok
      setZeroError(null);
      setWorkZeroMachineZ(useMachine.getState().status.mpos[2]);
    } catch (e) {
      setWorkZeroMachineZ(null);
      setZeroError(`Z: ${String(e)}`);
    }
  }, []);

  const handleClearTouchOff = useCallback(() => {
    setWorkZeroMachineZ(null);
  }, []);

  // Bind the work X-Y zero (G54) at the current position (the datum corner),
  // waiting for GRBL to accept it. Only a confirmed `ok` marks X-Y bound; a
  // rejected command leaves it unset so the start gate stays closed.
  const handleBindXY = useCallback(async () => {
    const { status, connected } = useMachine.getState();
    if (!canMove(status.state, connected)) return;
    try {
      await api.machine.setZero(true, true, false); // G10 L20 P1 X0 Y0, awaits ok
      setZeroError(null);
      setWorkZeroXYSet(true);
    } catch (e) {
      setWorkZeroXYSet(false);
      setZeroError(`X-Y: ${String(e)}`);
    }
  }, []);

  const handleClearXY = useCallback(() => {
    setWorkZeroXYSet(false);
  }, []);

  const zGate = checkZGate(workZeroMachineZ, cncProfile?.safeZMm ?? 5);

  // Counts per class over the full (unfiltered) plan; null until plan is ready.
  const counts = useMemo(() => (plan ? classCounts(plan) : null), [plan]);

  // Filter the plan to the selected classes, then derive route + program from it.
  const filteredPlan = useMemo(
    () => (plan ? filterPlanByClasses(plan, selected) : null),
    [plan, selected],
  );

  // Apply bit overrides: patch toolId on each group whose diameterKey has an override.
  const filteredPlanWithOverrides = useMemo(() => {
    if (!filteredPlan) return null;
    if (bitOverrides.size === 0) return filteredPlan;
    const groups = filteredPlan.groups.map((g) => {
      const key = String(Math.round(g.diameterMm * 1000));
      const overrideToolId = bitOverrides.get(key);
      return overrideToolId ? { ...g, toolId: overrideToolId } : g;
    });
    // Recompute unmatched diameters from the patched groups so an applied override
    // clears its "no matching bit" warning.
    const unmatchedDiametersMm = groups
      .filter((g) => !g.toolId)
      .map((g) => g.diameterMm)
      .sort((a, b) => a - b);
    return { ...filteredPlan, groups, unmatchedDiametersMm };
  }, [filteredPlan, bitOverrides]);

  // Route computed from the filtered plan (with overrides); null while plan/panel unavailable.
  const route = useMemo(() => {
    if (!filteredPlanWithOverrides || !panel) return null;
    const start = datumCornerPanelPoint(drillDatumCorner, panel.width_mm, panel.height_mm);
    return planDrillRoute(filteredPlanWithOverrides, start, zones);
  }, [filteredPlanWithOverrides, panel, drillDatumCorner, zones]);

  // The selected-hole key (`${gi}-${hi}`) indexes the current route; clear it when
  // the route changes (pass switch, override, datum) so the hole card can't show a
  // different hole at the same index.
  useEffect(() => {
    setSelectedHoleId(null);
  }, [route]);

  // Build the drill program (G-code + steps) from the filtered plan. `startMachineXY`
  // (omitted for the preview) makes the first traverse avoid keep-out zones from the
  // bit's real position at run start.
  const buildProgram = useCallback(
    (startMachineXY?: { x: number; y: number }) => {
      if (!filteredPlanWithOverrides || !panel || !cncProfile) return null;
      return emitDrillProgram(filteredPlanWithOverrides, {
        panelHeightMm: panel.height_mm,
        panelWidthMm: panel.width_mm,
        datumCorner: drillDatumCorner,
        profile: cncProfile,
        tools,
        substrateThicknessMm,
        keepOutZones: zones,
        startMachineXY,
      });
    },
    [filteredPlanWithOverrides, panel, cncProfile, tools, substrateThicknessMm, zones, drillDatumCorner],
  );

  // Total estimated run time for the current pass route (passed to RunHeader for ETA).
  const totalEstimateSec = useMemo(() => {
    if (!route || !cncProfile) return 0;
    return estimateDrill(route, tools, cncProfile, substrateThicknessMm).timeSec;
  }, [route, tools, cncProfile, substrateThicknessMm]);

  // Live-run hook.
  const run = useDrillRun();
  const machineWork = useMachinePosition();

  // Start the run from a program whose first traverse avoids keep-out zones from
  // the bit's ACTUAL position (it may not be parked at work zero). Falls back to
  // (0,0) when the position is unknown.
  const handleStart = useCallback(() => {
    const exec = buildProgram(machineWork ? { x: machineWork.x, y: machineWork.y } : undefined);
    if (exec) void run.start(exec.steps);
  }, [buildProgram, machineWork, run]);
  const showMarker = shouldShowMarker(run.state.phase, machineWork !== null);

  // Apply a feed override % by resetting to 100 then nudging in ±10/±1 steps.
  // A sequence token cancels an in-flight series if the slider is released again,
  // so two rapid changes can't interleave into a wrong final GRBL state.
  const handleFeedChange = useCallback(async (targetPct: number) => {
    setFeedOverridePct(targetPct);
    const seq = ++feedSeqRef.current;
    const step = async (action: "100" | "+10" | "-10" | "+1" | "-1") => {
      await api.machine.override("feed", action);
      return feedSeqRef.current === seq; // false → superseded
    };
    if (!(await step("100"))) return;
    let diff = targetPct - 100;
    while (diff >= 10) { if (!(await step("+10"))) return; diff -= 10; }
    while (diff <= -10) { if (!(await step("-10"))) return; diff += 10; }
    while (diff >= 1) { if (!(await step("+1"))) return; diff -= 1; }
    while (diff <= -1) { if (!(await step("-1"))) return; diff += 1; }
  }, []);

  // Called when the operator finishes a pass: mark it done, reset Z touch-off,
  // advance pass, and return the run to idle (so the inspector leaves RUN mode).
  const handlePassDone = useCallback(() => {
    setPassDone((prev) => new Set([...prev, activePassId]));
    setWorkZeroMachineZ(null);
    setWorkZeroXYSet(false);
    // Advance to the next pass in DRILL_PASSES order that has not been completed yet.
    const nextPass = DRILL_PASSES.find(
      (p) => p.id !== activePassId && !passDone.has(p.id),
    );
    if (nextPass) setActivePassId(nextPass.id);
    run.reset();
  }, [activePassId, passDone, run]);

  // Three-phase progress ring (descent / drilling / retract) for the
  // currently-drilling hole.
  const targetDepthMm = substrateThicknessMm + DEFAULT_BREAKTHROUGH_MM;
  const currentHolePhase = useDrillPhaseProgress({
    active: run.state.phase === "running" && run.state.currentHoleIndex !== null,
    currentHoleIndex: run.state.currentHoleIndex,
    zMm: machineWork?.z ?? null,
    depthMm: targetDepthMm,
    safeZMm: cncProfile?.safeZMm ?? 5,
  });

  // hasAnyHoles: whether the FULL plan has any holes (independent of selection).
  // Used to gate the "no holes" empty-screen (not the "nothing selected" case).
  const hasAnyHoles = !!(plan && plan.totalHoles > 0);

  // Empty state: no project open yet, or the full plan finished computing with no holes at all.
  // Gate "no holes" on plan !== null so the first render after a snapshot (before the effect
  // flips loading) doesn't flash the message. The "nothing selected" case is NOT a full-screen
  // empty state — it keeps the normal layout (canvas shows dimmed holes + selector).
  if (!hasProject || (plan !== null && !loading && !hasAnyHoles)) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[#0a0c10] text-slate-500 text-sm">
        {loading ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : (
          <span>{!hasProject ? t("empty.noProject") : t("empty.noHoles")}</span>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-[#0a0c10]">
      {/* Loading spinner overlay */}
      {loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#0a0c10]/70">
          <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
        </div>
      )}

      {/* Top toolbar: visibility chips + view toggles (datum moved to inspector) */}
      <DrillCanvasTopBar
        counts={counts ?? { registration: 0, pth: 0, npth: 0, mechanical: 0 }}
        visibleClasses={visibleClasses}
        onVisibleClassesChange={setVisibleClasses}
        showPath={showPath}
        onShowPathChange={setShowPath}
        showDiameters={showDiameters}
        onShowDiametersChange={setShowDiameters}
      />

      {/* Main layout: canvas hero + inspector sidebar */}
      <div className="flex flex-1 overflow-hidden">
        {/* Drill map (takes all remaining space); renders even when selection is empty
            so unselected holes appear dimmed and the user knows what was excluded. */}
        <div className="relative flex-1 overflow-hidden">
          {plan && filteredPlan && route && panel && (
            <DrillMapCanvas
              widthMm={panel.width_mm}
              heightMm={panel.height_mm}
              plan={plan}
              route={route}
              selectedClasses={selected}
              visibleClasses={visibleClasses}
              showPath={showPath}
              showDiameters={showDiameters}
              zones={zones}
              datum={drillDatumCorner}
              progress={{
                holesCompleted: run.state.holesCompleted,
                currentHoleIndex: run.state.currentHoleIndex,
              }}
              machineWork={showMarker ? machineWork : null}
              currentHolePhase={currentHolePhase}
              selectedHoleId={selectedHoleId}
              onSelectHole={setSelectedHoleId}
            />
          )}
        </div>

        {/* Inspector sidebar; always shown once plan is available */}
        {filteredPlanWithOverrides && route && counts && panel && cncProfile && (
          <DrillPlanInspector
            plan={filteredPlanWithOverrides}
            route={route}
            counts={counts}
            activePassId={activePassId}
            onPassChange={setActivePassId}
            run={run}
            onStart={handleStart}
            onSetClass={(dMm, klass) =>
              void useShell.getState().setDrillClassOverride(String(Math.round(dMm * 1000)), klass)
            }
            onSetBitOverride={(diameterKey, toolId) =>
              setBitOverrides((m) => new Map(m).set(diameterKey, toolId))
            }
            selectedHoleId={selectedHoleId}
            onClearHole={() => setSelectedHoleId(null)}
            datum={drillDatumCorner}
            onDatumChange={setDrillDatumCorner}
            panelWidthMm={panel.width_mm}
            panelHeightMm={panel.height_mm}
            tools={tools}
            cncProfile={cncProfile}
            substrateThicknessMm={substrateThicknessMm}
            workZeroMachineZ={workZeroMachineZ}
            onTouchOff={handleTouchOff}
            onClearTouchOff={handleClearTouchOff}
            workZeroXYSet={workZeroXYSet}
            onBindXY={handleBindXY}
            onClearXY={handleClearXY}
            zeroError={zeroError}
            zGate={zGate}
            machineConnected={machineConnected}
            machineState={machineState}
            connected={machineConnected}
            spindleControllable={cncProfile.spindleControllable ?? false}
            hasHoles={route.totalHoles > 0}
            feedOverridePct={feedOverridePct}
            grblFeedPct={grblFeedPct}
            onFeedChange={handleFeedChange}
            onPassDone={handlePassDone}
            totalEstimateSec={totalEstimateSec}
            passDone={passDone}
          />
        )}
      </div>
    </div>
  );
}

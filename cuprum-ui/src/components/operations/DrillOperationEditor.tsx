import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { DEFAULT_FR4_THICKNESS_MM, type DrillSnapshot } from "@/lib/api";
import { useDrillPlan } from "@/hooks/useDrillPlan";
import { useDrillRun } from "@/hooks/useDrillRun";
import { emitDrillProgram, DEFAULT_BREAKTHROUGH_MM } from "@/lib/drillGcode";
import { planDrillRoute, classAtRunIndex } from "@/lib/drillRoute";
import { DRILL_CLASS_COLOR } from "@/lib/drillClassColor";
import { datumCornerPanelPoint } from "@/lib/datum";
import { classCounts, DEFAULT_SELECTED_CLASSES } from "@/lib/drillPasses";
import {
  holesForClasses,
  subPlanForSelection,
  holeIdsInRunOrder,
} from "@/lib/drillSelection";
import { estimateDrill } from "@/lib/drillEstimate";
import { DrillMapCanvas } from "@/components/drill/DrillMapCanvas";
import { DrillPlanInspector } from "@/components/drill/DrillPlanInspector";
import { DrillCanvasTopBar } from "@/components/drill/DrillCanvasTopBar";
import { useMachinePosition } from "@/hooks/useMachinePosition";
import { useDrillPhaseProgress } from "@/hooks/useDrillPhaseProgress";
import { shouldShowMarker } from "@/lib/machineMarker";
import { useSettings } from "@/settingsStore";
import { useMachine } from "@/machineStore";
import { api } from "@/lib/api";
import { canMove } from "@/lib/machineControls";
import { type XYGateResult, checkXYGate, planWorkExtent } from "@/lib/xyGate";
import { type ZGateResult, checkZGate } from "@/lib/zGate";

/** Phases in which a run is live; a transition out of this set into done/error/idle
 *  is the run's terminal event (used to journal the outcome). */
const ACTIVE_RUN_PHASES = new Set(["running", "pausing", "paused", "stopping", "awaitingToolChange"]);

/** Drill operation editor. Renders the hole map, pass selector, summary, and run
 *  panel from a pushed `DrillSnapshot` (the editor lives in the separate drill
 *  window, so project data arrives via IPC, not the store). Machine state comes
 *  from the window's follower store; project mutations go back as IPC intents. */
export function DrillOperationEditor({ snapshot }: { snapshot: DrillSnapshot }) {
  const { t } = useTranslation("drill");

  const snap = snapshot;

  // useDrillPlan returns the full plan (no route — route is computed here
  // after filtering by the selected hole id set).
  const { plan, loading } = useDrillPlan(snap);

  // Ephemeral bit overrides: diameterKey (String(Math.round(d*1000))) → toolId.
  const [bitOverrides, setBitOverrides] = useState<Map<string, string>>(new Map());

  const panel = snap?.manifest?.panel ?? null;
  const hasProject = !!(snap?.workingDir && snap.manifest);

  const cncProfile = snap?.cncProfile ?? null;
  const tools = snap?.tools ?? [];
  const substrateThicknessMm =
    snap?.manifest?.stackup?.substrate_thickness_mm ?? DEFAULT_FR4_THICKNESS_MM;

  // Datum corner: drill-screen-owned setting (persisted in settings).
  const drillDatumCorner = useSettings((s) => s.drillDatumCorner);
  const setDrillDatumCorner = useSettings((s) => s.setDrillDatumCorner);

  // Keep-out zones from the panel manifest (panel-space coords).
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

  // Stable hole id selection — persists across runs (the board hasn't moved).
  const [selectedHoleIds, setSelectedHoleIds] = useState<Set<string>>(new Set());

  // Drilled holes tracking (session-scoped; cleared when plan changes).
  const [drilledHoleIds, setDrilledHoleIds] = useState<Set<string>>(new Set());

  // Seed the selection with the alignment preset once the plan is ready; reset on plan change.
  useEffect(() => {
    if (plan) setSelectedHoleIds(holesForClasses(plan, DEFAULT_SELECTED_CLASSES()));
    else setSelectedHoleIds(new Set());
    setDrilledHoleIds(new Set());
  }, [plan]);

  // Canvas view toggles.
  const [showPath, setShowPath] = useState(true);
  const [showDiameters, setShowDiameters] = useState(false);

  // Inspected hole: the last-clicked hole's stable id (for the detail card).
  const [inspectedHoleId, setInspectedHoleId] = useState<string | null>(null);

  // MPos X/Y captured at bind — the work-coordinate offset, used by the
  // XY gate to check the hole bbox against the machine envelope (null = not bound).
  const [workZeroMachineXY, setWorkZeroMachineXY] = useState<{ x: number; y: number } | null>(null);

  const [zeroError, setZeroError] = useState<string | null>(null);
  const bindingRef = useRef(false);

  // Feed override % sent via UI (100 = nominal).
  const [feedOverridePct, setFeedOverridePct] = useState(100);
  const feedSeqRef = useRef(0);

  const machineConnected = useMachine((s) => s.connected);
  const machineState = useMachine((s) => s.status.state);
  const machineHomed = useMachine((s) => s.homed);
  const grblFeedPct = useMachine((s) => s.status.overrides?.[0]);

  // Homing/disconnect voids the work zero — force re-bind.
  useEffect(() => {
    if (!machineHomed || machineState === "home") {
      setWorkZeroMachineXY(null);
    }
  }, [machineHomed, machineState]);

  // Returns true when the zero was bound (so the caller can leave the zero mode).
  const handleBindZero = useCallback(async (): Promise<boolean> => {
    const { status, connected } = useMachine.getState();
    if (!canMove(status.state, connected) || bindingRef.current) return false;
    bindingRef.current = true;
    try {
      await api.machine.setZero(true, true, false);
      setZeroError(null);
      const mpos = useMachine.getState().status.mpos;
      setWorkZeroMachineXY({ x: mpos[0], y: mpos[1] });
      return true;
    } catch (e) {
      setWorkZeroMachineXY(null);
      setZeroError(String(e));
      return false;
    } finally {
      bindingRef.current = false;
    }
  }, []);

  const handleClearZero = useCallback(() => {
    setWorkZeroMachineXY(null);
  }, []);

  // Counts per class over the full (unfiltered) plan; null until plan is ready.
  const counts = useMemo(() => (plan ? classCounts(plan) : null), [plan]);

  // Build the sub-plan from the id selection (pure — only selected holes retained).
  const subPlan = useMemo(
    () => (plan ? subPlanForSelection(plan, selectedHoleIds) : null),
    [plan, selectedHoleIds],
  );

  // Apply bit overrides: patch toolId on each group whose diameterKey has an override.
  const subPlanWithOverrides = useMemo(() => {
    if (!subPlan) return null;
    if (bitOverrides.size === 0) return subPlan;
    const groups = subPlan.groups.map((g) => {
      const key = String(Math.round(g.diameterMm * 1000));
      const overrideToolId = bitOverrides.get(key);
      return overrideToolId ? { ...g, toolId: overrideToolId } : g;
    });
    const unmatchedDiametersMm = groups
      .filter((g) => !g.toolId)
      .map((g) => g.diameterMm)
      .sort((a, b) => a - b);
    return { ...subPlan, groups, unmatchedDiametersMm };
  }, [subPlan, bitOverrides]);

  // Route computed from the sub-plan (with overrides); null while plan/panel unavailable.
  const route = useMemo(() => {
    if (!subPlanWithOverrides || !panel) return null;
    const start = datumCornerPanelPoint(drillDatumCorner, panel.width_mm, panel.height_mm);
    return planDrillRoute(subPlanWithOverrides, start, zones);
  }, [subPlanWithOverrides, panel, drillDatumCorner, zones]);

  // Clear inspected hole when the route changes (datum/override/selection switch).
  useEffect(() => {
    setInspectedHoleId(null);
  }, [route]);

  // Machine-frame bbox of the holes that will actually run (selected sub-plan),
  // for the XY gate. Recomputes on selection/datum/panel change.
  const workExtent = useMemo(() => {
    if (!subPlanWithOverrides || !panel) return null;
    return planWorkExtent(subPlanWithOverrides, drillDatumCorner, panel.width_mm, panel.height_mm);
  }, [subPlanWithOverrides, panel, drillDatumCorner]);

  // XY gate: at the bound work zero, does the whole hole bbox fit inside the
  // machine travel? Blocks the run (and shows a banner) when it would overrun.
  // Without a CNC profile the travel is unknown — skip the gate (defaults valid)
  // rather than gating against a degenerate 0-travel envelope. The inspector that
  // surfaces the gate only renders once a profile is present anyway.
  const xyGate: XYGateResult = cncProfile
    ? checkXYGate(workZeroMachineXY, workExtent, cncProfile.workEnvelopeMm.x, cncProfile.workEnvelopeMm.y)
    : { valid: true };

  // Z feasibility: depth / tool-change retract / their span must fit the Z travel.
  // (Z work-zero is bound per tool during the run, so this gates on travel size,
  // not on a known zero.)
  const zGate: ZGateResult = cncProfile
    ? checkZGate({
        safeZMm: cncProfile.safeZMm,
        toolChangeZMm: cncProfile.toolChangeZMm,
        depthMm: substrateThicknessMm + DEFAULT_BREAKTHROUGH_MM,
        envZMm: cncProfile.workEnvelopeMm.z,
      })
    : { valid: true };

  const buildProgram = useCallback(
    (startMachineXY?: { x: number; y: number }) => {
      if (!subPlanWithOverrides || !panel || !cncProfile) return null;
      return emitDrillProgram(subPlanWithOverrides, {
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
    [subPlanWithOverrides, panel, cncProfile, tools, substrateThicknessMm, zones, drillDatumCorner],
  );

  const totalEstimateSec = useMemo(() => {
    if (!route || !cncProfile) return 0;
    return estimateDrill(route, tools, cncProfile, substrateThicknessMm).timeSec;
  }, [route, tools, cncProfile, substrateThicknessMm]);

  const run = useDrillRun();
  const machineWork = useMachinePosition();

  // run_uid of the in-flight journalled run (null when none is being logged, e.g.
  // unsaved project). Set on start, cleared when the terminal outcome is written.
  const runUidRef = useRef<string | null>(null);

  const handleStart = useCallback(() => {
    const exec = buildProgram(machineWork ? { x: machineWork.x, y: machineWork.y } : undefined);
    if (!exec) return;
    void run.start(exec.steps);
    // Best-effort journal write — never blocks or aborts the real run. Skipped for
    // an unsaved project (no stable path to key history on).
    const projectPath = snap.currentPath;
    if (projectPath) {
      const uid = crypto.randomUUID();
      runUidRef.current = uid;
      const holesTotal = exec.steps.filter((s) => s.kind === "hole").length;
      const params = {
        selectedHoleIds: [...selectedHoleIds],
        bitOverrides: Object.fromEntries(bitOverrides),
        datum: drillDatumCorner,
        feedOverridePct,
        workZeroMachineXY,
        estimateSec: totalEstimateSec,
      };
      void api.operationLog
        .start({ runUid: uid, projectPath, opType: "drill", progressTotal: holesTotal, paramsJson: JSON.stringify(params) })
        .catch(() => {});
    }
  }, [
    buildProgram,
    machineWork,
    run,
    snap.currentPath,
    selectedHoleIds,
    bitOverrides,
    drillDatumCorner,
    feedOverridePct,
    workZeroMachineXY,
    totalEstimateSec,
  ]);
  const showMarker = shouldShowMarker(run.state.phase, machineWork !== null);

  // Journal the run outcome on the active→terminal transition (best-effort). The
  // backend has no distinct "stopped" event — both graceful stop and estop end at
  // "idle" — so idle-after-active maps to "stopped".
  const prevPhaseRef = useRef(run.state.phase);
  useEffect(() => {
    const prev = prevPhaseRef.current;
    const cur = run.state.phase;
    prevPhaseRef.current = cur;
    const uid = runUidRef.current;
    if (!uid) return;
    if (ACTIVE_RUN_PHASES.has(prev) && !ACTIVE_RUN_PHASES.has(cur)) {
      runUidRef.current = null;
      const outcome = cur === "done" ? "completed" : cur === "error" ? "error" : "stopped";
      void api.operationLog.finish(uid, outcome, run.state.holesCompleted).catch(() => {});
    }
  }, [run.state.phase, run.state.holesCompleted]);

  // Mark holes drilled as the run reports progress (route order → stable ids).
  // Robust to partial stops: only the holes actually completed get marked.
  useEffect(() => {
    if (!route || run.state.holesCompleted <= 0) return;
    const ids = holeIdsInRunOrder(route).slice(0, run.state.holesCompleted);
    setDrilledHoleIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) if (id) next.add(id);
      return next;
    });
  }, [run.state.holesCompleted, route]);

  // Current running hole as a stable id (for canvas highlight).
  const currentHoleId = useMemo(() => {
    if (!route || run.state.currentHoleIndex == null) return null;
    return holeIdsInRunOrder(route)[run.state.currentHoleIndex] ?? null;
  }, [route, run.state.currentHoleIndex]);

  const handleFeedChange = useCallback(async (targetPct: number) => {
    setFeedOverridePct(targetPct);
    const seq = ++feedSeqRef.current;
    const step = async (action: "100" | "+10" | "-10" | "+1" | "-1") => {
      await api.machine.override("feed", action);
      return feedSeqRef.current === seq;
    };
    if (!(await step("100"))) return;
    let diff = targetPct - 100;
    while (diff >= 10) { if (!(await step("+10"))) return; diff -= 10; }
    while (diff <= -10) { if (!(await step("-10"))) return; diff += 10; }
    while (diff >= 1) { if (!(await step("+1"))) return; diff -= 1; }
    while (diff <= -1) { if (!(await step("-1"))) return; diff += 1; }
  }, []);

  // Run finished: keep work zero (board hasn't moved), reset only the run machine.
  const handleRunDone = useCallback(() => {
    run.reset();
  }, [run]);

  const targetDepthMm = substrateThicknessMm + DEFAULT_BREAKTHROUGH_MM;
  const currentHolePhase = useDrillPhaseProgress({
    active: run.state.phase === "running" && run.state.currentHoleIndex !== null,
    currentHoleIndex: run.state.currentHoleIndex,
    zMm: machineWork?.z ?? null,
    depthMm: targetDepthMm,
    safeZMm: cncProfile?.safeZMm ?? 5,
  });

  // Active bit colour (by drill class) for the current hole's drilling-phase arc.
  const currentBitColor = useMemo(() => {
    if (!route || run.state.currentHoleIndex == null) return undefined;
    const cls = classAtRunIndex(route, run.state.currentHoleIndex);
    return cls ? DRILL_CLASS_COLOR[cls] : undefined;
  }, [route, run.state.currentHoleIndex]);

  // Idle = the machine is holding (paused or awaiting a tool change), not cutting.
  // Transient phases (pausing/stopping) don't show the marker at all (gated by
  // ACTIVE_PHASES in shouldShowMarker), so they need no idle handling here.
  const runIdle =
    run.state.phase === "paused" || run.state.phase === "awaitingToolChange";

  // Localized phase label for the marker pill (only during an active run).
  const currentPhaseLabel = useMemo(() => {
    if (
      run.state.phase === "idle" ||
      run.state.phase === "done" ||
      run.state.phase === "error"
    )
      return undefined;
    const key = runIdle ? "idle" : currentHolePhase.phase;
    return t(`phase.${key}`);
  }, [run.state.phase, runIdle, currentHolePhase.phase, t]);

  const hasAnyHoles = !!(plan && plan.totalHoles > 0);

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
    <div className="relative flex h-full w-full bg-[#0a0c10]">
      {/* Loading spinner overlay */}
      {loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#0a0c10]/70">
          <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
        </div>
      )}

      {/* Canvas column: toolbar (over the canvas only) + drill map */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top toolbar: view toggles + selection hint */}
        <DrillCanvasTopBar
          showPath={showPath}
          onShowPathChange={setShowPath}
          showDiameters={showDiameters}
          onShowDiametersChange={setShowDiameters}
        />

        {/* Drill map — renders all holes; unselected appear dimmed */}
        <div className="relative flex-1 overflow-hidden">
          {plan && subPlan && route && panel && (
            <DrillMapCanvas
              widthMm={panel.width_mm}
              heightMm={panel.height_mm}
              plan={plan}
              route={route}
              selectedHoleIds={selectedHoleIds}
              drilledHoleIds={drilledHoleIds}
              currentHoleId={currentHoleId}
              showPath={showPath}
              showDiameters={showDiameters}
              zones={zones}
              datum={drillDatumCorner}
              machineWork={showMarker ? machineWork : null}
              currentHolePhase={currentHolePhase}
              currentBitColor={currentBitColor}
              runIdle={runIdle}
              currentPhaseLabel={currentPhaseLabel}
              inspectedHoleId={inspectedHoleId}
              onToggleHole={(id) =>
                setSelectedHoleIds((s) => {
                  const n = new Set(s);
                  n.has(id) ? n.delete(id) : n.add(id);
                  return n;
                })
              }
              onInspectHole={setInspectedHoleId}
            />
          )}
        </div>
      </div>

      {/* Inspector sidebar; always shown once plan is available, full height */}
      {subPlanWithOverrides && route && counts && panel && cncProfile && plan && (
          <DrillPlanInspector
            fullPlan={plan}
            plan={subPlanWithOverrides}
            route={route}
            counts={counts}
            selectedHoleIds={selectedHoleIds}
            onSelectedHoleIdsChange={setSelectedHoleIds}
            run={run}
            onStart={handleStart}
            onSetClass={(dMm, klass) =>
              // Project mutation — relayed to the main window (the single writer),
              // which applies it and re-pushes the snapshot.
              void api.emitDrillSetClassOverride(String(Math.round(dMm * 1000)), klass)
            }
            onSetBitOverride={(diameterKey, toolId) =>
              setBitOverrides((m) => new Map(m).set(diameterKey, toolId))
            }
            selectedHoleId={inspectedHoleId}
            onClearHole={() => setInspectedHoleId(null)}
            datum={drillDatumCorner}
            onDatumChange={setDrillDatumCorner}
            panelWidthMm={panel.width_mm}
            panelHeightMm={panel.height_mm}
            tools={tools}
            cncProfile={cncProfile}
            substrateThicknessMm={substrateThicknessMm}
            workZeroSet={workZeroMachineXY !== null}
            onBind={handleBindZero}
            onClear={handleClearZero}
            maxXMm={cncProfile.workEnvelopeMm.x}
            maxYMm={cncProfile.workEnvelopeMm.y}
            maxZMm={cncProfile.workEnvelopeMm.z}
            zeroError={zeroError}
            xyGate={xyGate}
            zGate={zGate}
            connected={machineConnected}
            spindleControllable={cncProfile.spindleControllable ?? false}
            hasHoles={selectedHoleIds.size > 0}
            feedOverridePct={feedOverridePct}
            grblFeedPct={grblFeedPct}
            onFeedChange={handleFeedChange}
            onRunDone={handleRunDone}
            totalEstimateSec={totalEstimateSec}
          />
      )}
    </div>
  );
}

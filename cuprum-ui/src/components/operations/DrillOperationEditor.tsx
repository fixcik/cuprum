import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import {
  DEFAULT_FR4_THICKNESS_MM,
  ZERO_KINEMATICS,
  type DrillSnapshot,
  type DrillPlanInput,
  type DrillPlanResult,
} from "@/lib/api";
import { useDrillPlan } from "@/hooks/useDrillPlan";
import { useDrillRun } from "@/hooks/useDrillRun";
import { classAtRunIndex } from "@/lib/drillRoute";
import { DRILL_CLASS_COLOR } from "@/lib/drillClassColor";
import { DEFAULT_BREAKTHROUGH_MM } from "@/lib/drillBreakthrough";
import { classCounts, DEFAULT_SELECTED_CLASSES, DRILL_CLASSES } from "@/lib/drillPasses";
import {
  holesForClasses,
  subPlanForSelection,
  holeIdsInRunOrder,
} from "@/lib/drillSelection";
import { DrillMapCanvas } from "@/components/drill/DrillMapCanvas";
import { DrillPlanInspector } from "@/components/drill/DrillPlanInspector";
import { DrillCanvasTopBar } from "@/components/drill/DrillCanvasTopBar";
import { useMachinePosition } from "@/hooks/useMachinePosition";
import { useDrillPhaseProgress } from "@/hooks/useDrillPhaseProgress";
import { shouldShowMarker, drillMarkerStatus } from "@/lib/machineMarker";
import { useSettings } from "@/settingsStore";
import { useWorkZeroMethod } from "@/workZeroMethodStore";
import { useMachine } from "@/machineStore";
import { api } from "@/lib/api";
import { useDrillGates } from "@/hooks/useDrillGates";

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

  // Last run's config for this saved project, used to prefill on open (null = none).
  const [lastDrillParams, setLastDrillParams] = useState<{
    selectedHoleIds?: string[];
    bitOverrides?: Record<string, string>;
    feedOverridePct?: number;
  } | null>(null);
  const prefillAppliedRef = useRef(false);
  // Set when an explicit "repeat run" prefill arrives — the default last-params fetch
  // then must not clobber it if it resolves later (it raced the user's repeat click).
  const repeatPrefillRef = useRef(false);

  // The work-zero method metadata (RMS/angle chip) is solved against one panel's
  // alignment points; a project switch with the drill window open keeps the
  // physical G54 offset but invalidates that metadata — drop it so the status
  // card doesn't claim a registration that was never measured for this board.
  const workZeroProjectRef = useRef(snap.currentPath);
  useEffect(() => {
    if (workZeroProjectRef.current === snap.currentPath) return;
    workZeroProjectRef.current = snap.currentPath;
    useWorkZeroMethod.getState().clearWorkZero();
  }, [snap.currentPath]);

  // Fetch the most recent drill run's params once per project (saved path only).
  useEffect(() => {
    prefillAppliedRef.current = false;
    repeatPrefillRef.current = false;
    setLastDrillParams(null);
    const path = snap.currentPath;
    if (!path) return;
    let active = true;
    void api.operationLog
      .lastParams(path, "drill")
      .then((json) => {
        // Skip if an explicit repeat already supplied params — don't overwrite it.
        if (!active || !json || repeatPrefillRef.current) return;
        try {
          setLastDrillParams(JSON.parse(json));
        } catch {
          /* malformed params — ignore, fall back to defaults */
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [snap.currentPath]);

  // "Repeat run": the main window pushes a past run's params to prefill from. Feed it
  // through the same prefill path (reset the once-per-project guard so the seed effect
  // re-applies it, filtered to the current plan).
  useEffect(() => {
    // StrictMode-safe listener lifecycle (same as useBridgeListeners): unlisten
    // synchronously when already resolved, or immediately upon a late resolve.
    let active = true;
    let unlisten: UnlistenFn | null = null;
    void api
      .onDrillPrefill((json) => {
        if (!active) return;
        try {
          const parsed = JSON.parse(json);
          repeatPrefillRef.current = true;
          setLastDrillParams(parsed);
          prefillAppliedRef.current = false;
        } catch {
          /* malformed — ignore */
        }
      })
      .then((un) => {
        if (active) unlisten = un;
        else un();
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  // Seed the selection once the plan is ready: prefer the last run's config (filtered
  // to holes that still exist on the panel), applied once per project; otherwise the
  // default alignment preset. Reset drilled-tracking on every plan change.
  useEffect(() => {
    if (!plan) {
      setSelectedHoleIds(new Set());
      setDrilledHoleIds(new Set());
      return;
    }
    if (lastDrillParams && !prefillAppliedRef.current) {
      prefillAppliedRef.current = true;
      const planIds = holesForClasses(plan, new Set(DRILL_CLASSES));
      const restored = new Set(
        (lastDrillParams.selectedHoleIds ?? []).filter((id) => planIds.has(id)),
      );
      // If the panel changed so much that nothing matches, fall back to the preset.
      setSelectedHoleIds(restored.size ? restored : holesForClasses(plan, DEFAULT_SELECTED_CLASSES()));
      if (lastDrillParams.bitOverrides) {
        setBitOverrides(new Map(Object.entries(lastDrillParams.bitOverrides)));
      }
      if (typeof lastDrillParams.feedOverridePct === "number") {
        setFeedOverridePct(lastDrillParams.feedOverridePct);
      }
    } else {
      setSelectedHoleIds(holesForClasses(plan, DEFAULT_SELECTED_CLASSES()));
    }
    setDrilledHoleIds(new Set());
  }, [plan, lastDrillParams]);

  // Canvas view toggles.
  const [showPath, setShowPath] = useState(true);
  const [showDiameters, setShowDiameters] = useState(false);

  // Inspected hole: the last-clicked hole's stable id (for the detail card).
  const [inspectedHoleId, setInspectedHoleId] = useState<string | null>(null);

  // Feed override % sent via UI (100 = nominal).
  const [feedOverridePct, setFeedOverridePct] = useState(100);
  const feedSeqRef = useRef(0);

  const machineConnected = useMachine((s) => s.connected);

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

  // Assemble the backend `drill_plan` input from the editor state. The Rust core
  // owns routing, G-code emission and the (kinematics-aware) time estimate; the
  // frontend only marshals the plan + shop settings. `kinematics` is a zeroed
  // placeholder — the backend overwrites it with its cached GRBL limits.
  // `startMachineXY` is omitted for the preview/estimate plan and supplied only at
  // run start (so the first traverse routes from the real bit position).
  const buildPlanInput = useCallback(
    (startMachineXY?: { x: number; y: number }): DrillPlanInput | null => {
      if (!subPlanWithOverrides || !panel || !cncProfile) return null;
      return {
        plan: { groups: subPlanWithOverrides.groups },
        datum: drillDatumCorner,
        panelWidthMm: panel.width_mm,
        panelHeightMm: panel.height_mm,
        tools: tools.map((t) => ({
          id: t.id,
          diameterMm: t.diameterMm,
          name: t.name,
          recommendedRpm: t.recommendedRpm,
          recommendedPlungeMmMin: t.recommendedPlungeMmMin,
        })),
        cnc: {
          safeZMm: cncProfile.safeZMm,
          toolChangeZMm: cncProfile.toolChangeZMm,
          spindleControllable: cncProfile.spindleControllable,
          spindleMaxRpm: cncProfile.spindleMaxRpm,
          prependGcode: cncProfile.prependGcode,
          appendGcode: cncProfile.appendGcode,
        },
        kinematics: ZERO_KINEMATICS,
        substrateThicknessMm,
        keepOutZones: zones,
        startMachineXY,
      };
    },
    [subPlanWithOverrides, panel, cncProfile, tools, substrateThicknessMm, zones, drillDatumCorner],
  );

  // Plan result (route + program + estimate) computed in the Rust core. Recomputed
  // whenever the plan input changes; the preview/estimate plan omits startMachineXY.
  const [planResult, setPlanResult] = useState<DrillPlanResult | null>(null);
  // Stringify the preview input so the effect only re-fires on a real change (the
  // memoized object identity flips on every render that touches its deps).
  const previewInput = useMemo(() => buildPlanInput(), [buildPlanInput]);
  const previewInputKey = previewInput ? JSON.stringify(previewInput) : null;
  useEffect(() => {
    if (!previewInput) {
      setPlanResult(null);
      return;
    }
    // Anti-race: a stale resolution (input changed mid-flight) is dropped — only
    // the latest in-flight request is allowed to write the result.
    let cancelled = false;
    void api.drill
      .plan(previewInput)
      .then((res) => {
        if (!cancelled) setPlanResult(res);
      })
      .catch(() => {
        if (!cancelled) setPlanResult(null);
      });
    return () => {
      cancelled = true;
    };
    // previewInputKey captures the meaningful input change; previewInput is the
    // value sent (stable for a given key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewInputKey]);

  const route = planResult?.route ?? null;
  const totalEstimateSec = planResult ? Math.round(planResult.estimate.motionSec) : 0;
  // Per-group motion buckets for the "until next tool change" readout (empty until planned).
  const groupMotionSecs = planResult?.estimate.groupMotionSecs ?? [];
  // Feed-limited share per group — lets the header rescale the estimate to the live feed.
  const groupFeedSecs = planResult?.estimate.groupFeedSecs ?? [];
  // The tool-change count rides along on `estimate` (shown by the preflight summary).
  const estimate = planResult?.estimate ?? null;

  // Clear inspected hole when the route changes (datum/override/selection switch).
  useEffect(() => {
    setInspectedHoleId(null);
  }, [route]);

  // Work-zero binding + XY/Z preflight gates (bind/clear actions, homing
  // invalidation, and the derived gate verdicts) live in a dedicated hook.
  const {
    workZeroMachineXY,
    workZeroSet,
    zeroError,
    handleBindZero,
    handleClearZero,
    registerSolvedZero,
    xyGate,
    zGate,
  } = useDrillGates({
    subPlan: subPlanWithOverrides,
    panel: panel ? { width_mm: panel.width_mm, height_mm: panel.height_mm } : null,
    envelopeMm: cncProfile?.workEnvelopeMm ?? null,
    safeZMm: cncProfile?.safeZMm ?? 0,
    toolChangeZMm: cncProfile?.toolChangeZMm ?? 0,
    substrateThicknessMm,
    datum: drillDatumCorner,
  });

  const run = useDrillRun();
  const machineWork = useMachinePosition();

  // run_uid of the journalled run, set only once the machine actually starts
  // cutting (see pendingRunRef); cleared when the terminal outcome is written.
  const runUidRef = useRef<string | null>(null);
  // A launched-but-not-yet-journalled run. The journal row is written only once
  // the machine actually starts drilling (first cut), NOT on "Начать" — so a run
  // abandoned at the first Z touch-off (operator sets Z, then exits) never leaves
  // a phantom "Идёт" row in history. Holds the params captured at launch.
  const pendingRunRef = useRef<{
    uid: string;
    projectPath: string;
    progressTotal: number;
    paramsJson: string;
  } | null>(null);
  // Whether the pending run's start was already journalled (flush guard).
  const loggedStartRef = useRef(false);
  // Whether a tool-change pause has occurred this run. Re-entering `running` after
  // a tool change means the operator finished the first Z touch-off and cutting
  // has begun — that (or the first completed hole) is "the machine actually started".
  const sawToolChangeRef = useRef(false);

  const handleStart = useCallback(async () => {
    // Re-plan with the real machine work position so the FIRST traverse routes
    // around clamps from where the bit actually is (the preview plan omits it).
    const input = buildPlanInput(machineWork ? { x: machineWork.x, y: machineWork.y } : undefined);
    if (!input) return;
    let exec: DrillPlanResult;
    try {
      exec = await api.drill.plan(input);
    } catch {
      return;
    }
    const steps = exec.program.steps;
    void run.start(steps);
    // Stash the run for the journal, but DON'T write it yet — the row is created
    // only when the machine actually starts cutting (see the flush effect below),
    // so abandoning the run at the first Z touch-off leaves no phantom history
    // entry. Skipped for an unsaved project (no stable path to key history on).
    runUidRef.current = null;
    loggedStartRef.current = false;
    sawToolChangeRef.current = false;
    pendingRunRef.current = null;
    const projectPath = snap.currentPath;
    if (projectPath) {
      const holesTotal = steps.filter((s) => s.kind === "hole").length;
      const params = {
        selectedHoleIds: [...selectedHoleIds],
        bitOverrides: Object.fromEntries(bitOverrides),
        datum: drillDatumCorner,
        feedOverridePct,
        workZeroMachineXY,
        estimateSec: Math.round(exec.estimate.motionSec),
        // Distinct tools (bit groups) — for the history summary.
        toolCount: subPlanWithOverrides?.groups.length ?? 0,
      };
      pendingRunRef.current = {
        uid: crypto.randomUUID(),
        projectPath,
        progressTotal: holesTotal,
        paramsJson: JSON.stringify(params),
      };
    }
  }, [
    buildPlanInput,
    machineWork,
    run,
    snap.currentPath,
    selectedHoleIds,
    bitOverrides,
    drillDatumCorner,
    feedOverridePct,
    workZeroMachineXY,
    subPlanWithOverrides,
  ]);
  const showMarker = shouldShowMarker(run.state.phase, machineWork !== null);

  // Write the journal row on the FIRST cut, not on "Начать": only once the
  // machine has actually started drilling — re-entered `running` after the first
  // tool-change pause (operator finished the Z touch-off), or completed a hole.
  // Until then the run is "abandonable" with no trace (the whole point of the fix).
  useEffect(() => {
    const pending = pendingRunRef.current;
    if (!pending || loggedStartRef.current) return;
    if (run.state.phase === "awaitingToolChange") sawToolChangeRef.current = true;
    const cutting =
      run.state.holesCompleted > 0 ||
      (run.state.phase === "running" && sawToolChangeRef.current);
    if (!cutting) return;
    loggedStartRef.current = true;
    runUidRef.current = pending.uid;
    void api.operationLog
      .start({
        runUid: pending.uid,
        projectPath: pending.projectPath,
        opType: "drill",
        progressTotal: pending.progressTotal,
        paramsJson: pending.paramsJson,
      })
      .catch(() => {});
  }, [run.state.phase, run.state.holesCompleted]);

  // Journal the run outcome on the active→terminal transition (best-effort). The
  // backend has no distinct "stopped" event — both graceful stop and estop end at
  // "idle" — so idle-after-active maps to "stopped". Only fires for a run that was
  // actually journalled (runUidRef set by the flush effect above).
  const prevPhaseRef = useRef(run.state.phase);
  useEffect(() => {
    const prev = prevPhaseRef.current;
    const cur = run.state.phase;
    prevPhaseRef.current = cur;
    const uid = runUidRef.current;
    if (ACTIVE_RUN_PHASES.has(prev) && !ACTIVE_RUN_PHASES.has(cur)) {
      // Run reached a terminal state: drop the pending stash either way so a
      // never-cut run (no row written) can't get logged by a later phase blip.
      pendingRunRef.current = null;
      if (!uid) return;
      runUidRef.current = null;
      const outcome = cur === "done" ? "completed" : cur === "error" ? "error" : "stopped";
      // A completed run drilled every selected hole; use the total so a late
      // final `progress` event racing `done` can't undercount the journal.
      const done = outcome === "completed" ? run.state.holesTotal : run.state.holesCompleted;
      void api.operationLog.finish(uid, outcome, done).catch(() => {});
    }
  }, [run.state.phase, run.state.holesCompleted, run.state.holesTotal]);

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
    // The bit is still cutting the current hole while `pausing` (the soft-pause only
    // takes effect after the in-flight hole completes), so track the micro-phase in
    // both `running` and `pausing` — otherwise it would snap back to `traverse`.
    active:
      (run.state.phase === "running" || run.state.phase === "pausing") &&
      run.state.currentHoleIndex !== null,
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

  // Single source of truth for the marker's idle (not-cutting) state and label key
  // across every run phase (see drillMarkerStatus). First tool change = no previous
  // bit to swap, just binding Z for bit #1 (same predicate the run header uses).
  const markerStatus = drillMarkerStatus(
    run.state.phase,
    currentHolePhase.phase,
    run.state.toolChangeSeq === 1,
  );
  const runIdle = markerStatus.idle;

  // Localized phase label for the marker pill (null on terminal phases → no row).
  const currentPhaseLabel = useMemo(
    () => (markerStatus.labelKey ? t(markerStatus.labelKey) : undefined),
    [markerStatus.labelKey, t],
  );

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
            estimate={estimate}
            workZeroSet={workZeroSet}
            onBind={handleBindZero}
            onClear={handleClearZero}
            onZeroSolved={registerSolvedZero}
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
            onFeedChange={handleFeedChange}
            onRunDone={handleRunDone}
            totalEstimateSec={totalEstimateSec}
            groupMotionSecs={groupMotionSecs}
            groupFeedSecs={groupFeedSecs}
            plungeDepthMm={targetDepthMm}
            toolingHoles={panel.tooling_holes ?? []}
            alignmentPoints={panel.alignment_points ?? []}
          />
      )}
    </div>
  );
}

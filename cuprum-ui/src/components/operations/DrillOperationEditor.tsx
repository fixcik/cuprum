import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { type DrillClass, DEFAULT_FR4_THICKNESS_MM } from "@/lib/api";
import { useDrillScreenData } from "@/hooks/useDrillScreenData";
import { useDrillPlan } from "@/hooks/useDrillPlan";
import { useDrillRun } from "@/hooks/useDrillRun";
import { emitDrillProgram, DEFAULT_BREAKTHROUGH_MM } from "@/lib/drillGcode";
import { planDrillRoute } from "@/lib/drillRoute";
import { datumCornerPanelPoint } from "@/lib/datum";
import { filterPlanByClasses, classCounts, DEFAULT_SELECTED_CLASSES, DRILL_CLASSES } from "@/lib/drillPasses";
import { DrillMapCanvas } from "@/components/drill/DrillMapCanvas";
import { DrillSummary } from "@/components/drill/DrillSummary";
import { DrillRunPanel } from "@/components/drill/DrillRunPanel";
import { DrillPassSelector } from "@/components/drill/DrillPassSelector";
import { DrillCanvasTopBar } from "@/components/drill/DrillCanvasTopBar";
import { useMachinePosition } from "@/hooks/useMachinePosition";
import { useDrillProgressRing } from "@/hooks/useDrillProgressRing";
import { shouldShowMarker } from "@/lib/machineMarker";
import { useSettings } from "@/settingsStore";
import { useShell } from "@/shellStore";

/** Drill operation editor — sourceable inline (no IPC).
 *  Builds the drill snapshot directly from stores via useDrillScreenData,
 *  then renders the hole map, pass selector, summary, and run panel. */
export function DrillOperationEditor() {
  const { t } = useTranslation("drill");

  const snap = useDrillScreenData();

  // useDrillPlan now returns only the full plan (no route — route is computed here
  // after filtering by the selected class set).
  const { plan, loading } = useDrillPlan(snap);

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

  // Drill-window-owned, ephemeral selection. Default: the alignment pass.
  const [selected, setSelected] = useState<Set<DrillClass>>(DEFAULT_SELECTED_CLASSES);

  // Visibility (which classes are shown on the canvas). Independent of run-selection.
  const [visibleClasses, setVisibleClasses] = useState<Set<DrillClass>>(new Set(DRILL_CLASSES));
  // Canvas view toggles.
  const [showPath, setShowPath] = useState(true);
  const [showDiameters, setShowDiameters] = useState(false);

  // Selected hole on the drill canvas (key = `${gi}-${hi}`); null = none.
  const [selectedHoleId, setSelectedHoleId] = useState<string | null>(null);

  // Counts per class over the full (unfiltered) plan; null until plan is ready.
  const counts = useMemo(() => (plan ? classCounts(plan) : null), [plan]);

  // Filter the plan to the selected classes, then derive route + program from it.
  const filteredPlan = useMemo(
    () => (plan ? filterPlanByClasses(plan, selected) : null),
    [plan, selected],
  );

  // Route computed from the filtered plan; null while plan/panel unavailable.
  const route = useMemo(() => {
    if (!filteredPlan || !panel) return null;
    const start = datumCornerPanelPoint(drillDatumCorner, panel.width_mm, panel.height_mm);
    return planDrillRoute(filteredPlan, start, zones);
  }, [filteredPlan, panel, drillDatumCorner, zones]);

  // Build the drill program (G-code + steps) from the filtered plan. `startMachineXY`
  // (omitted for the preview) makes the first traverse avoid keep-out zones from the
  // bit's real position at run start.
  const buildProgram = useCallback(
    (startMachineXY?: { x: number; y: number }) => {
      if (!filteredPlan || !panel || !cncProfile) return null;
      return emitDrillProgram(filteredPlan, {
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
    [filteredPlan, panel, cncProfile, tools, substrateThicknessMm, zones, drillDatumCorner],
  );

  // Preview program (steps for display + canvas); ordered from the datum corner.
  const program = useMemo(() => buildProgram(), [buildProgram]);

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

  // Depth-progress ring for the currently-drilling hole.
  const targetDepthMm = substrateThicknessMm + DEFAULT_BREAKTHROUGH_MM;
  const currentHoleProgress = useDrillProgressRing({
    active: run.state.phase === "running" && run.state.currentHoleIndex !== null,
    currentHoleIndex: run.state.currentHoleIndex,
    zMm: machineWork?.z ?? null,
    targetDepthMm,
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

      {/* Top toolbar: datum control + visibility chips + view toggles */}
      <DrillCanvasTopBar
        datum={drillDatumCorner}
        onDatumChange={setDrillDatumCorner}
        counts={counts ?? { registration: 0, pth: 0, npth: 0, mechanical: 0 }}
        visibleClasses={visibleClasses}
        onVisibleClassesChange={setVisibleClasses}
        showPath={showPath}
        onShowPathChange={setShowPath}
        showDiameters={showDiameters}
        onShowDiametersChange={setShowDiameters}
      />

      {/* Pass selector: preset buttons + per-class checkboxes with counts */}
      {counts && (
        <DrillPassSelector selected={selected} counts={counts} onChange={setSelected} />
      )}

      {/* Main layout: canvas hero + summary sidebar */}
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
              currentHoleProgress={currentHoleProgress}
              selectedHoleId={selectedHoleId}
              onSelectHole={setSelectedHoleId}
            />
          )}
        </div>

        {/* Summary sidebar; always shown once plan is available */}
        {filteredPlan && route && (
          <div className="w-72 shrink-0 border-l border-slate-800 overflow-y-auto">
            <DrillRunPanel steps={program?.steps ?? []} run={run} onStart={handleStart} />
            <DrillSummary
              plan={filteredPlan}
              route={route}
              onSetClass={(dMm, klass) =>
                void useShell.getState().setDrillClassOverride(String(Math.round(dMm * 1000)), klass)
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}

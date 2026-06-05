import { useEffect, useMemo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { api, type DrillSnapshot, DEFAULT_FR4_THICKNESS_MM } from "@/lib/api";
import { useSnapshotSubscription } from "@/hooks/useTauriListeners";
import { useDrillPlan } from "@/hooks/useDrillPlan";
import { useDrillRun } from "@/hooks/useDrillRun";
import { emitDrillProgram } from "@/lib/drillGcode";
import { DrillMapCanvas } from "@/components/drill/DrillMapCanvas";
import { DrillSummary } from "@/components/drill/DrillSummary";
import { DrillRunPanel } from "@/components/drill/DrillRunPanel";
import { useMachinePosition } from "@/hooks/useMachinePosition";
import { shouldShowMarker } from "@/lib/machineMarker";
import { useSettings } from "@/settingsStore";
import { DATUM_CORNERS } from "@/lib/datum";
import { SegmentedControl } from "@/components/ui/SegmentedControl";

/** Root of the separate drill-preview window (label "drill").
 *  Subscribes to project snapshots from the main window, builds the drill plan,
 *  and renders a 2D hole map + summary. */
export function DrillWindow() {
  const { t } = useTranslation("drill");

  const snap = useSnapshotSubscription<DrillSnapshot>(api.onDrillSnapshot, api.emitDrillReady);
  const { plan, route, loading } = useDrillPlan(snap);

  // Keep the window title localised.
  useEffect(() => {
    getCurrentWindow().setTitle(t("window.title")).catch(() => {});
  }, [t]);

  const panel = snap?.manifest?.panel ?? null;
  const hasProject = !!(snap?.workingDir && snap.manifest);
  const hasHoles = !!(plan && plan.totalHoles > 0 && route);

  // Shop settings for the G-code context come from the snapshot (pushed live by
  // the main window), so profile/tool edits apply without restarting this window.
  const cncProfile = snap?.cncProfile ?? null;
  const tools = snap?.tools ?? [];
  const substrateThicknessMm =
    snap?.manifest?.stackup?.substrate_thickness_mm ?? DEFAULT_FR4_THICKNESS_MM;

  // Datum corner: drill-window-owned setting.
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

  // Build the drill program (G-code + steps) from the plan whenever inputs change.
  const program = useMemo(() => {
    if (!plan || !panel || !cncProfile) return null;
    return emitDrillProgram(plan, {
      panelHeightMm: panel.height_mm,
      panelWidthMm: panel.width_mm,
      datumCorner: drillDatumCorner,
      profile: cncProfile,
      tools,
      substrateThicknessMm,
      keepOutZones: zones,
    });
  }, [plan, panel, cncProfile, tools, substrateThicknessMm, zones, drillDatumCorner]);

  // Live-run hook.
  const run = useDrillRun();
  const machineWork = useMachinePosition();
  const showMarker = shouldShowMarker(run.state.phase, machineWork !== null);

  // Empty state: no project open yet, or the plan finished computing with no holes.
  // Gate the "no holes" branch on `plan !== null` so the very first render after a
  // snapshot arrives (before the effect flips `loading`) doesn't flash the message.
  if (!hasProject || (plan !== null && !loading && !hasHoles)) {
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

      {/* Datum-corner selector bar */}
      <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-1.5">
        <span className="text-[11px] text-slate-500">{t("datum.label")}</span>
        <SegmentedControl
          options={DATUM_CORNERS.map((c) => ({ value: c, label: t(`datum.${c}`) }))}
          value={drillDatumCorner}
          onChange={setDrillDatumCorner}
        />
      </div>

      {/* Main layout: canvas hero + summary sidebar */}
      <div className="flex flex-1 overflow-hidden">
        {/* Drill map (takes all remaining space) */}
        <div className="relative flex-1 overflow-hidden">
          {plan && route && panel && (
            <DrillMapCanvas
              widthMm={panel.width_mm}
              heightMm={panel.height_mm}
              plan={plan}
              route={route}
              zones={zones}
              datum={drillDatumCorner}
              progress={{
                holesCompleted: run.state.holesCompleted,
                currentHoleIndex: run.state.currentHoleIndex,
              }}
              machineWork={showMarker ? machineWork : null}
            />
          )}
        </div>

        {/* Summary sidebar */}
        {plan && route && (
          <div className="w-72 shrink-0 border-l border-slate-800 overflow-y-auto">
            <DrillRunPanel steps={program?.steps ?? []} run={run} />
            <DrillSummary
              plan={plan}
              route={route}
              onSetClass={(dMm, klass) =>
                api.emitDrillSetClassOverride(String(Math.round(dMm * 1000)), klass)
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}

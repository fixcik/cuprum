import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { api, type DrillSnapshot } from "@/lib/api";
import { useSnapshotSubscription } from "@/hooks/useTauriListeners";
import { useDrillPlan } from "@/hooks/useDrillPlan";
import { DrillMapCanvas } from "@/components/drill/DrillMapCanvas";
import { DrillSummary } from "@/components/drill/DrillSummary";

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

  // Empty state: no project open yet, or plan is empty.
  if (!hasProject || (!loading && !hasHoles)) {
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
            />
          )}
        </div>

        {/* Summary sidebar */}
        {plan && route && (
          <div className="w-64 shrink-0 border-l border-slate-800 overflow-y-auto">
            <DrillSummary plan={plan} route={route} />
          </div>
        )}
      </div>
    </div>
  );
}

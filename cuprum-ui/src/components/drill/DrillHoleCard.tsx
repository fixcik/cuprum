import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { DrillRoute } from "@/lib/drillRoute";
import type { PanelDrillPlan } from "@/lib/panelDrill";
import type { DatumCorner } from "@/lib/datum";
import { machinePoint } from "@/lib/datum";
import { enumerateHoles } from "@/lib/drillSelection";
import { groupColor } from "@/components/drill/DrillMapCanvas";

export interface DrillHoleCardProps {
  /** Stable hole id (`gi:hi`); null = nothing selected. */
  selectedHoleId: string | null;
  /** Full plan — used to look up hole details by stable id. */
  plan: PanelDrillPlan;
  /** Route — used to look up the route-group colour index by stable id. */
  route: DrillRoute;
  datum: DatumCorner;
  panelWidthMm: number;
  panelHeightMm: number;
  onClear: () => void;
}

/** Card showing details of the currently inspected hole on the drill map.
 *  Resolves the stable id against the full plan; returns null if no hole is selected. */
export function DrillHoleCard({
  selectedHoleId,
  plan,
  route,
  datum,
  panelWidthMm,
  panelHeightMm,
  onClear,
}: DrillHoleCardProps) {
  const { t } = useTranslation("drill");

  if (!selectedHoleId) return null;

  // Find the enumerated hole by stable id.
  const eh = enumerateHoles(plan).find((e) => e.id === selectedHoleId);
  if (!eh) return null;

  const hole = eh.hole;

  // Derive the colour from the route-group index that contains this stable id,
  // falling back to the plan-group index if the hole is not in the current route
  // (unselected holes can still be inspected).
  let colorIdx = eh.gi;
  for (let gi = 0; gi < route.groups.length; gi++) {
    if (route.groups[gi].orderedHoles.some((h) => h.id === selectedHoleId)) {
      colorIdx = gi;
      break;
    }
  }
  const color = groupColor(colorIdx);

  const [mx, my] = machinePoint(hole.xMm, hole.yMm, datum, panelWidthMm, panelHeightMm);

  return (
    <div className="rounded-lg border border-border bg-card/30 p-3 mx-4 mb-3">
      {/* Header row: colour dot + class label + clear button */}
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
        <span className="flex-1 text-xs text-slate-300">
          {t(`class.${eh.class}`)}
        </span>
        <button
          type="button"
          className="rounded p-0.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          aria-label={t("hole.clear")}
          title={t("hole.clear")}
          onClick={onClear}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 3-column detail grid: diameter · X · Y */}
      <div className="mt-2 grid grid-cols-3 gap-2 text-xs tabular-nums">
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {t("hole.dia")}
          </span>
          <span className="text-slate-200">{eh.diameterMm.toFixed(2)} мм</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {t("hole.x")}
          </span>
          <span className="text-slate-200">{mx.toFixed(2)}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {t("hole.y")}
          </span>
          <span className="text-slate-200">{my.toFixed(2)}</span>
        </div>
      </div>
    </div>
  );
}

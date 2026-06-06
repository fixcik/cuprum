import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { DrillRoute } from "@/lib/drillRoute";
import type { DatumCorner } from "@/lib/datum";
import { machinePoint } from "@/lib/datum";
import { groupColor } from "@/components/drill/DrillMapCanvas";

export interface DrillHoleCardProps {
  /** Selected hole key `${gi}-${hi}` into route.groups; null = nothing selected. */
  selectedHoleId: string | null;
  route: DrillRoute;
  datum: DatumCorner;
  panelWidthMm: number;
  panelHeightMm: number;
  onClear: () => void;
}

/** Card showing details of the currently selected hole on the drill map.
 *  Returns null when no hole is selected or the key is out of range. */
export function DrillHoleCard({
  selectedHoleId,
  route,
  datum,
  panelWidthMm,
  panelHeightMm,
  onClear,
}: DrillHoleCardProps) {
  const { t } = useTranslation("drill");

  if (!selectedHoleId) return null;

  const parts = selectedHoleId.split("-");
  const gi = parseInt(parts[0], 10);
  const hi = parseInt(parts[1], 10);

  const g = route.groups[gi];
  if (!g) return null;

  const hole = g.orderedHoles[hi];
  if (!hole) return null;

  const color = groupColor(gi);
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
          {t(`class.${g.class}`)}
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
          <span className="text-slate-200">{g.diameterMm.toFixed(2)} мм</span>
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

import { useTranslation } from "react-i18next";
import { Spline, Tag } from "lucide-react";
import type { DrillClass } from "@/lib/api";
import { DRILL_CLASSES } from "@/lib/drillPasses";

/** Stable per-class colour dots — distinct from the group palette,
 *  chosen to be visually recognisable across all 4 classes. */
export const CLASS_COLORS: Record<DrillClass, string> = {
  registration: "#f59e0b", // amber — fiducial / alignment
  pth:          "#4f9cf9", // blue  — plated through-holes
  npth:         "#22c55e", // green — non-plated
  mechanical:   "#a855f7", // purple — routing / slots
};

export interface DrillCanvasTopBarProps {
  counts: Record<DrillClass, number>;
  visibleClasses: Set<DrillClass>;
  onVisibleClassesChange: (s: Set<DrillClass>) => void;
  showPath: boolean;
  onShowPathChange: (v: boolean) => void;
  showDiameters: boolean;
  onShowDiametersChange: (v: boolean) => void;
}

/** Top toolbar for the drill canvas: per-class visibility chips and view toggles
 *  for the traverse path and diameter labels. Datum control has moved to the inspector.
 *  Visibility (visibleClasses) is separate from run-selection (selectedClasses). */
export function DrillCanvasTopBar({
  counts,
  visibleClasses,
  onVisibleClassesChange,
  showPath,
  onShowPathChange,
  showDiameters,
  onShowDiametersChange,
}: DrillCanvasTopBarProps) {
  const { t } = useTranslation("drill");

  const toggleClass = (c: DrillClass) => {
    const next = new Set(visibleClasses);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    onVisibleClassesChange(next);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-3 py-1.5">

      {/* Visibility chips */}
      <span className="text-[11px] text-slate-500">{t("toolbar.show")}</span>
      {DRILL_CLASSES.map((c) => {
        const inSet = visibleClasses.has(c);
        return (
          <button
            key={c}
            type="button"
            onClick={() => toggleClass(c)}
            className={
              "rounded-md border px-2 py-1 text-[11px] flex items-center gap-1.5 transition-colors cursor-pointer " +
              (inSet
                ? "border-primary/40 bg-primary/10 text-slate-200"
                : "border-slate-700 text-slate-500 opacity-50")
            }
          >
            <span
              className="size-2.5 rounded-full shrink-0"
              style={{ backgroundColor: CLASS_COLORS[c] }}
            />
            {t(`class.${c}`)}
            <span className="tabular-nums text-slate-400">{counts[c]}</span>
          </button>
        );
      })}

      {/* Divider */}
      <div className="w-px h-5 bg-border" />

      {/* Path toggle */}
      <button
        type="button"
        onClick={() => onShowPathChange(!showPath)}
        className={
          "rounded-md border px-2 py-1 text-[11px] flex items-center gap-1.5 transition-colors cursor-pointer " +
          (showPath
            ? "border-primary/40 bg-primary/10 text-slate-200"
            : "border-slate-700 text-slate-500 opacity-50")
        }
      >
        <Spline className="size-3" />
        {t("toolbar.path")}
      </button>

      {/* Diameters toggle */}
      <button
        type="button"
        onClick={() => onShowDiametersChange(!showDiameters)}
        className={
          "rounded-md border px-2 py-1 text-[11px] flex items-center gap-1.5 transition-colors cursor-pointer " +
          (showDiameters
            ? "border-primary/40 bg-primary/10 text-slate-200"
            : "border-slate-700 text-slate-500 opacity-50")
        }
      >
        <Tag className="size-3" />
        {t("toolbar.diameters")}
      </button>
    </div>
  );
}

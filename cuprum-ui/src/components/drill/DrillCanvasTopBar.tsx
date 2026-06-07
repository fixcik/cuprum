import { useTranslation } from "react-i18next";
import { Spline, Tag } from "lucide-react";

export interface DrillCanvasTopBarProps {
  showPath: boolean;
  onShowPathChange: (v: boolean) => void;
  showDiameters: boolean;
  onShowDiametersChange: (v: boolean) => void;
}

/** Top toolbar for the drill canvas: view toggles for the traverse path and
 *  diameter labels, plus a hint that on-canvas highlighting follows the plan
 *  selection. The per-class visibility filter was removed — visibility now
 *  mirrors the run selection (selected holes bright, the rest dim context). */
export function DrillCanvasTopBar({
  showPath,
  onShowPathChange,
  showDiameters,
  onShowDiametersChange,
}: DrillCanvasTopBarProps) {
  const { t } = useTranslation("drill");

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-3 py-1.5">
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

      {/* Selection hint */}
      <span className="text-[11px] text-slate-500">{t("toolbar.selectionHint")}</span>
    </div>
  );
}

import { useTranslation } from "react-i18next";
import type { DrillClass } from "@/lib/api";
import { DRILL_PASSES, DRILL_CLASSES, activePresetId } from "@/lib/drillPasses";

export interface DrillPassSelectorProps {
  selected: Set<DrillClass>;
  counts: Record<DrillClass, number>;
  onChange: (next: Set<DrillClass>) => void;
}

/** Process-phase pass presets + per-class checkbox fine-tuning. Selection is
 *  ephemeral drill-window state; presets are non-overlapping class sets. */
export function DrillPassSelector({ selected, counts, onChange }: DrillPassSelectorProps) {
  const { t } = useTranslation("drill");
  const active = activePresetId(selected);

  const toggleClass = (c: DrillClass) => {
    const next = new Set(selected);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-2 border-b border-slate-800 px-3 py-2">
      {/* Pass presets */}
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-slate-500">{t("pass.label")}</span>
        <div className="inline-flex rounded-md bg-slate-900 p-0.5">
          {DRILL_PASSES.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onChange(new Set(p.classes))}
              className={
                "px-2.5 py-1 text-xs rounded transition-colors " +
                (active === p.id ? "bg-slate-700 text-slate-100" : "text-slate-400 hover:text-slate-200")
              }
            >
              {t(`pass.${p.id}`)}
            </button>
          ))}
        </div>
      </div>
      {/* Per-class checkboxes with counts */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {DRILL_CLASSES.map((c) => (
          <label key={c} className="inline-flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={selected.has(c)}
              onChange={() => toggleClass(c)}
              className="accent-blue-500"
            />
            <span>{t(`class.${c}`)}</span>
            <span className="text-slate-500 tabular-nums">{counts[c]}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

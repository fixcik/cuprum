import { useTranslation } from "react-i18next";
import type { DrillClass } from "@/lib/api";
import { DRILL_PASSES, DRILL_CLASSES, activePresetId, passToClasses } from "@/lib/drillPasses";

export interface DrillSelectionControlsProps {
  counts: Record<DrillClass, number>;
  selectedClasses: Set<DrillClass>;
  onChange: (next: Set<DrillClass>) => void;
  disabled?: boolean;
}

/** Free-selection controls: stage presets (replace the class set) + per-class
 *  chips (toggle a class in/out). Replaces the linear pass stepper. */
export function DrillSelectionControls({ counts, selectedClasses, onChange, disabled }: DrillSelectionControlsProps) {
  const { t } = useTranslation("drill");
  const activePreset = activePresetId(selectedClasses);
  const allSelected = DRILL_CLASSES.every((c) => selectedClasses.has(c));
  const toggleClass = (c: DrillClass) => {
    const next = new Set(selectedClasses);
    if (next.has(c)) next.delete(c); else next.add(c);
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap gap-1.5">
        {DRILL_PASSES.map((p) => (
          <button key={p.id} type="button" disabled={disabled}
            onClick={() => onChange(passToClasses(p.id))}
            className={"rounded-md border px-2 py-1 text-[12px] transition-colors " +
              (activePreset === p.id ? "border-primary bg-primary/10 text-foreground"
                : "border-border text-muted-foreground hover:text-foreground")}>
            {t(`preset.${p.id}`)}
          </button>
        ))}
        <button type="button" disabled={disabled}
          onClick={() => onChange(new Set(DRILL_CLASSES))}
          className={"rounded-md border px-2 py-1 text-[12px] transition-colors " +
            (allSelected ? "border-primary bg-primary/10 text-foreground"
              : "border-border text-muted-foreground hover:text-foreground")}>
          {t("preset.all")}
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {DRILL_CLASSES.map((c) => {
          const on = selectedClasses.has(c);
          return (
            <button key={c} type="button" disabled={disabled} onClick={() => toggleClass(c)}
              className={"inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors " +
                (on ? "border-primary/60 bg-primary/5 text-foreground"
                  : "border-border text-muted-foreground/60 hover:text-foreground")}>
              {t(`class.${c}`)}
              <span className="tabular-nums text-muted-foreground/60">{counts[c]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

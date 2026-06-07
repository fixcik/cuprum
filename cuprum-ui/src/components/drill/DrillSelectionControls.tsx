import { useTranslation } from "react-i18next";
import type { DrillClass } from "@/lib/api";
import type { PanelDrillPlan } from "@/lib/panelDrill";
import { DRILL_PASSES, DRILL_CLASSES, passToClasses } from "@/lib/drillPasses";
import { holesForClasses } from "@/lib/drillSelection";

export interface DrillSelectionControlsProps {
  plan: PanelDrillPlan;
  counts: Record<DrillClass, number>;
  selectedHoleIds: Set<string>;
  onChange: (next: Set<string>) => void;
  disabled?: boolean;
}

/** Derives which preset (if any) the current selection exactly matches. */
function activePresetIdFromHoleIds(plan: PanelDrillPlan, selectedHoleIds: Set<string>): string | null {
  for (const p of DRILL_PASSES) {
    const presetIds = holesForClasses(plan, passToClasses(p.id));
    if (
      presetIds.size === selectedHoleIds.size &&
      [...presetIds].every((id) => selectedHoleIds.has(id))
    ) {
      return p.id;
    }
  }
  // Check "all" preset
  const allIds = holesForClasses(plan, new Set(DRILL_CLASSES));
  if (
    allIds.size === selectedHoleIds.size &&
    [...allIds].every((id) => selectedHoleIds.has(id))
  ) {
    return "all";
  }
  return null;
}

/** Free-selection controls: stage presets (replace the id set) + per-class chips
 *  (toggle a class's ids in/out). Operates on stable hole ids. */
export function DrillSelectionControls({
  plan,
  counts,
  selectedHoleIds,
  onChange,
  disabled,
}: DrillSelectionControlsProps) {
  const { t } = useTranslation("drill");
  const activePreset = activePresetIdFromHoleIds(plan, selectedHoleIds);

  const toggleClass = (c: DrillClass) => {
    const classIds = holesForClasses(plan, new Set([c]));
    const allOn = classIds.size > 0 && [...classIds].every((id) => selectedHoleIds.has(id));
    const next = new Set(selectedHoleIds);
    if (allOn) {
      classIds.forEach((id) => next.delete(id));
    } else {
      classIds.forEach((id) => next.add(id));
    }
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap gap-1.5">
        {DRILL_PASSES.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={disabled}
            onClick={() => onChange(holesForClasses(plan, passToClasses(p.id)))}
            className={
              "rounded-md border px-2 py-1 text-[12px] transition-colors " +
              (activePreset === p.id
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border text-muted-foreground hover:text-foreground")
            }
          >
            {t(`preset.${p.id}`)}
          </button>
        ))}
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(holesForClasses(plan, new Set(DRILL_CLASSES)))}
          className={
            "rounded-md border px-2 py-1 text-[12px] transition-colors " +
            (activePreset === "all"
              ? "border-primary bg-primary/10 text-foreground"
              : "border-border text-muted-foreground hover:text-foreground")
          }
        >
          {t("preset.all")}
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {DRILL_CLASSES.map((c) => {
          const classIds = holesForClasses(plan, new Set([c]));
          const on = classIds.size > 0 && [...classIds].every((id) => selectedHoleIds.has(id));
          return (
            <button
              key={c}
              type="button"
              disabled={disabled}
              onClick={() => toggleClass(c)}
              className={
                "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors " +
                (on
                  ? "border-primary/60 bg-primary/5 text-foreground"
                  : "border-border text-muted-foreground/60 hover:text-foreground")
              }
            >
              {t(`class.${c}`)}
              <span className="tabular-nums text-muted-foreground/60">{counts[c]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

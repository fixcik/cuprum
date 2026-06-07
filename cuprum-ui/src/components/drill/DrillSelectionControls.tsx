import { useTranslation } from "react-i18next";
import { Check, Layers } from "lucide-react";
import type { DrillClass } from "@/lib/api";
import type { PanelDrillPlan } from "@/lib/panelDrill";
import { DRILL_PASSES, DRILL_CLASSES, passToClasses } from "@/lib/drillPasses";
import { holesForClasses } from "@/lib/drillSelection";
import { DRILL_CLASS_COLOR } from "@/lib/drillClassColor";

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

/** "What to drill" selector: section header + stage preset tabs (replace the id
 *  set) + per-class checkbox chips (toggle a class's ids in/out). Selection drives
 *  on-canvas highlighting. Operates on stable hole ids. */
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

  // Plain text-tab styling shared by the stage presets and the "all" tab.
  const tabCls = (active: boolean) =>
    "text-[12px] transition-colors disabled:opacity-50 " +
    (active ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground");

  return (
    <div className="flex flex-col gap-2.5 px-4 py-3">
      {/* Section header */}
      <div className="flex items-center gap-2">
        <Layers className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="text-[13px] font-semibold text-foreground">{t("selection.title")}</span>
      </div>

      {/* Preset tabs — plain text row */}
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {DRILL_PASSES.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={disabled}
            onClick={() => onChange(holesForClasses(plan, passToClasses(p.id)))}
            className={tabCls(activePreset === p.id)}
          >
            {t(`preset.${p.id}`)}
          </button>
        ))}
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(holesForClasses(plan, new Set(DRILL_CLASSES)))}
          className={tabCls(activePreset === "all")}
        >
          {t("preset.all")}
        </button>
      </div>

      {/* Category checkbox chips — 2-column grid */}
      <div className="grid grid-cols-2 gap-1.5">
        {DRILL_CLASSES.map((c) => {
          const count = counts[c];
          const classIds = holesForClasses(plan, new Set([c]));
          const on = classIds.size > 0 && [...classIds].every((id) => selectedHoleIds.has(id));
          const empty = count === 0;
          return (
            <button
              key={c}
              type="button"
              disabled={disabled || empty}
              onClick={() => toggleClass(c)}
              className={
                "flex items-center gap-2 rounded-lg border px-2.5 py-2 text-[12px] transition-colors " +
                (on
                  ? "border-primary/60 bg-primary/10"
                  : "border-border hover:border-slate-500") +
                (empty ? " opacity-40" : " cursor-pointer")
              }
            >
              {/* Checkbox square */}
              <span
                className={
                  "grid size-4 shrink-0 place-items-center rounded-[4px] border " +
                  (on ? "border-primary bg-primary" : "border-muted-foreground/40")
                }
              >
                {on && <Check className="size-3 text-primary-foreground" />}
              </span>
              {/* Category colour dot */}
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: DRILL_CLASS_COLOR[c] }}
              />
              {/* Name + count */}
              <span className={"flex-1 text-left " + (on ? "text-foreground" : "text-muted-foreground")}>
                {t(`class.${c}`)}
              </span>
              <span className="tabular-nums text-muted-foreground">{count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

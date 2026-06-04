import { useTranslation } from "react-i18next";
import { LayoutDashboard } from "lucide-react";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/Switch";
import { Slider } from "@/components/ui/Slider";
import { UnitField } from "@/components/ui/settings/UnitField";
import { useSettings } from "@/settingsStore";
import type { NestSettings } from "@/lib/nest";

/** Small group with an uppercase caption. */
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">{children}</div>
    </div>
  );
}

const CORNERS: NestSettings["corner"][] = ["tl", "tr", "bl", "br"];
const CORNER_POS: Record<NestSettings["corner"], string> = {
  tl: "left-1 top-1",
  tr: "right-1 top-1",
  bl: "left-1 bottom-1",
  br: "right-1 bottom-1",
};
const CORNER_LABEL: Record<NestSettings["corner"], string> = {
  tl: "cornerTl",
  tr: "cornerTr",
  bl: "cornerBl",
  br: "cornerBr",
};

/** Collapsible auto-placement (nesting) settings strip. Reads/writes settingsStore.nest. */
export function NestingControls() {
  const { t } = useTranslation("project");
  const nest = useSettings((s) => s.nest);
  const setNest = useSettings((s) => s.setNest);

  return (
    <div className="shrink-0 border-t border-border">
      {/* Plain div (not a button) so the Switch — itself a <button> — isn't nested
          in a button. The Switch is the keyboard toggle target; clicking it stops
          propagation so the row's onClick doesn't double-toggle. */}
      <div
        onClick={() => setNest({ enabled: !nest.enabled })}
        className="flex w-full cursor-pointer items-center justify-between px-4 py-2.5 transition-colors hover:bg-foreground/[0.03]"
      >
        <span className="flex items-center gap-2">
          <LayoutDashboard
            className={`size-4 ${nest.enabled ? "text-primary" : "text-muted-foreground"}`}
          />
          <span className="text-[12px] font-semibold text-foreground">
            {t("panel.add.nest.title")}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {nest.enabled ? t("panel.add.nest.hintOn") : t("panel.add.nest.hintOff")}
          </span>
        </span>
        <span onClick={(e) => e.stopPropagation()}>
          <Switch
            checked={nest.enabled}
            onCheckedChange={(v) => setNest({ enabled: v })}
          />
        </span>
      </div>

      {nest.enabled && (
        <div className="flex flex-wrap items-start gap-x-7 gap-y-4 border-t border-border bg-panel/40 px-4 py-4">
          <Group title={t("panel.add.nest.fill")}>
            <SegmentedControl<NestSettings["fillMode"]>
              value={nest.fillMode}
              onChange={(v) => setNest({ fillMode: v })}
              options={[
                { value: "copies", label: t("panel.add.nest.copies") },
                { value: "fill", label: t("panel.add.nest.percent") },
              ]}
            />
            {nest.fillMode === "copies" ? (
              <div className="inline-flex items-center gap-1">
                <button
                  type="button"
                  className="grid size-7 place-items-center rounded-md border border-input text-muted-foreground hover:text-foreground"
                  onClick={() => setNest({ copies: Math.max(1, nest.copies - 1) })}
                >
                  −
                </button>
                <input
                  value={nest.copies}
                  onChange={(e) =>
                    setNest({ copies: Math.max(1, parseInt(e.target.value) || 1) })
                  }
                  className="h-7 w-12 rounded-md border border-input bg-background px-1 text-center text-[12px] tabular-nums text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
                <button
                  type="button"
                  className="grid size-7 place-items-center rounded-md border border-input text-muted-foreground hover:text-foreground"
                  onClick={() => setNest({ copies: nest.copies + 1 })}
                >
                  +
                </button>
              </div>
            ) : (
              <div className="inline-flex items-center gap-2">
                {/* Radix Slider uses number[] for value/onValueChange */}
                <Slider
                  min={10}
                  max={100}
                  step={5}
                  value={[nest.fillPct]}
                  onValueChange={([v]) => setNest({ fillPct: v })}
                  className="w-28"
                />
                <span className="w-9 text-[12px] tabular-nums text-muted-foreground">
                  {nest.fillPct}%
                </span>
              </div>
            )}
          </Group>

          <Group title={t("panel.add.nest.gaps")}>
            <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              {t("panel.add.nest.gapBoards")}
              <UnitField
                value={nest.gapMm}
                onChange={(v) => setNest({ gapMm: v })}
                dim="fine"
                step="0.5"
              />
            </label>
            <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              {t("panel.add.nest.gapEdge")}
              <UnitField
                value={nest.marginMm}
                onChange={(v) => setNest({ marginMm: v })}
                dim="fine"
                step="0.5"
              />
            </label>
          </Group>

          <Group title={t("panel.add.nest.layout")}>
            <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              {t("panel.add.nest.rotate")}
              <Switch
                checked={nest.rotate}
                onCheckedChange={(v) => setNest({ rotate: v })}
              />
            </label>
            <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              {t("panel.add.nest.corner")}
              <span className="relative inline-block h-7 w-11 shrink-0 rounded-sm border border-input bg-background">
                {CORNERS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={t(`panel.add.nest.${CORNER_LABEL[c]}`)}
                    onClick={() => setNest({ corner: c })}
                    className={`absolute ${CORNER_POS[c]} size-2 rounded-full ${
                      nest.corner === c
                        ? "bg-primary ring-2 ring-primary/30"
                        : "bg-muted-foreground/40"
                    }`}
                  />
                ))}
              </span>
            </span>
            <SegmentedControl<NestSettings["dir"]>
              value={nest.dir}
              onChange={(v) => setNest({ dir: v })}
              options={[
                { value: "rows", label: t("panel.add.nest.rows") },
                { value: "cols", label: t("panel.add.nest.cols") },
              ]}
            />
            <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              {t("panel.add.nest.step")}
              <UnitField
                value={nest.snapMm}
                onChange={(v) => setNest({ snapMm: v })}
                dim="fine"
                step="0.5"
              />
            </label>
          </Group>

          <Group title={t("panel.add.nest.behavior")}>
            <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              {t("panel.add.nest.repack")}
              <Switch
                checked={nest.repack}
                onCheckedChange={(v) => setNest({ repack: v })}
              />
            </label>
          </Group>
        </div>
      )}
    </div>
  );
}

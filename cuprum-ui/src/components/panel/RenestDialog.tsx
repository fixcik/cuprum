import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { UnitField } from "@/components/ui/settings/UnitField";
import { Switch } from "@/components/ui/Switch";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { useSettings } from "@/settingsStore";
import { renestSelection, panelObstacles, type RenestTransform } from "@/lib/panelPlacement";
import { solveRenest } from "@/lib/packSolve";
import type { BoardInstance, KeepOutZone, ToolingHole } from "@/lib/api";
import { recommendedGapMm, type NestSettings } from "@/lib/nest";

// Corner picker constants — mirrors NestingControls so both use the same layout.
const CORNERS: NestSettings["corner"][] = ["tl", "tr", "bl", "br"];
const CORNER_POS: Record<NestSettings["corner"], string> = {
  tl: "left-1 top-1",
  tr: "right-1 top-1",
  bl: "left-1 bottom-1",
  br: "right-1 bottom-1",
};
const CORNER_LABEL_KEY: Record<NestSettings["corner"], string> = {
  tl: "cornerTl",
  tr: "cornerTr",
  bl: "cornerBl",
  br: "cornerBr",
};

/** Small group with an uppercase caption (mirrors NestingControls style). */
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">{children}</div>
    </div>
  );
}

export function RenestDialog({
  open,
  onClose,
  selectedIds,
  instances,
  toolingHoles,
  keepOutZones,
  sizes,
  panelW,
  panelH,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  selectedIds: string[];
  instances: BoardInstance[];
  toolingHoles: ToolingHole[];
  keepOutZones: KeepOutZone[];
  sizes: Record<string, { w: number; h: number }>;
  panelW: number;
  panelH: number;
  onApply: (items: { id: string; x_mm: number; y_mm: number; rotation_deg: number }[]) => void;
}) {
  const { t } = useTranslation(["project", "common"]);
  const nest = useSettings((s) => s.nest);
  const setNest = useSettings((s) => s.setNest);
  const profile = useSettings((s) => s.profile);

  // Selection + obstacles, shared by the greedy preview and the solver. Unselected
  // boards AND tooling holes are obstacles (re-nest must not drop boards onto pins).
  const { selected, obstacles } = useMemo(() => {
    const sel = new Set(selectedIds);
    return {
      selected: instances.filter((i) => sel.has(i.id)).map((i) => ({ id: i.id, design_id: i.design_id })),
      obstacles: panelObstacles(
        { instances: instances.filter((i) => !sel.has(i.id)), tooling_holes: toolingHoles, keep_out_zones: keepOutZones },
        sizes,
        { clampRadiusMm: profile.toolingClampRadiusMm },
      ),
    };
  }, [selectedIds, instances, toolingHoles, keepOutZones, sizes, profile]);

  // Greedy preview = instant fallback; the solver (debounced) replaces it once ready.
  const result = useMemo(
    () => renestSelection({ selected, sizes, obstacles, panelW, panelH, nest }),
    [selected, obstacles, sizes, panelW, panelH, nest],
  );
  const [solved, setSolved] = useState<{ transforms: RenestTransform[]; requested: number; placed: number } | null>(null);
  useEffect(() => {
    setSolved(null);
    let cancelled = false;
    const handle = setTimeout(() => {
      void solveRenest({ selected, sizes, obstacles, panelW, panelH, nest })
        .then((r) => {
          if (!cancelled) setSolved(r);
        })
        .catch(() => {});
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [selected, obstacles, sizes, panelW, panelH, nest]);

  // Use the solver result once it lands and is no sparser than greedy; else greedy.
  const view = solved && solved.placed >= result.placed ? solved : result;

  const summary =
    view.placed === 0
      ? t("panel.renest.summaryNone")
      : view.placed === view.requested
        ? t("panel.renest.summaryFit", { n: view.requested })
        : t("panel.renest.summaryPartial", { placed: view.placed, requested: view.requested });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("panel.renest.title")}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("panel.renest.cancel")}
          </Button>
          <Button
            disabled={view.placed === 0}
            onClick={() => {
              onApply(view.transforms);
              onClose();
            }}
          >
            {t("panel.renest.apply")}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4 text-[12px]">
        {/* Gap / edge fields */}
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
          <button
            type="button"
            title={t("panel.add.nest.gapAutoHint")}
            onClick={() => setNest({ gapMm: recommendedGapMm() })}
            className="h-7 rounded-md border border-input px-2 text-[12px] text-muted-foreground hover:text-foreground"
          >
            {t("panel.add.nest.gapAuto")}
          </button>
        </Group>

        {/* Layout: mix-orientation, rotate, corner, dir, step */}
        <Group title={t("panel.add.nest.layout")}>
          <label
            className="flex items-center gap-1.5 text-[12px] text-muted-foreground"
            title={t("panel.add.nest.mixRotationHint")}
          >
            {t("panel.add.nest.mixRotation")}
            <Switch
              checked={nest.mixRotation}
              onCheckedChange={(v) => setNest({ mixRotation: v })}
            />
          </label>
          <label
            className={`flex items-center gap-1.5 text-[12px] ${
              nest.mixRotation ? "text-muted-foreground/40" : "text-muted-foreground"
            }`}
          >
            {t("panel.add.nest.rotate")}
            <Switch
              checked={nest.rotate}
              disabled={nest.mixRotation}
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
                  aria-label={t(`panel.add.nest.${CORNER_LABEL_KEY[c]}`)}
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

        {/* Live summary */}
        <p className="text-muted-foreground">{summary}</p>
      </div>
    </Modal>
  );
}

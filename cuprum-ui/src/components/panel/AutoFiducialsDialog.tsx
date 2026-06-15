import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { UnitField } from "@/components/ui/settings/UnitField";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Select } from "@/components/ui/Select";
import { placeFiducials, clampToolingHoleCenter } from "@/lib/panelPlacement";
import type { FiducialAxis, FiducialParams, ToolingHole } from "@/lib/api";

/** Default parameters seeded when the panel has no persisted fiducial params. */
export const DEFAULT_FIDUCIAL_PARAMS: FiducialParams = {
  axis: "x",
  count: 2,
  step_mm: 50,
  diameter_mm: 3,
  center_offset_mm: 0,
};

// Budget for the small panel thumbnail preview (px).
const BOX_W = 300;
const BOX_H = 150;
const MIN_DOT_PX = 2.5;

/** Caption group — matches the style used by RegistrationSetDialog. */
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">{children}</div>
    </div>
  );
}

/** Live SVG thumbnail: panel outline, existing holes (faded when replacing),
 *  and the new fiducial set (primary colour). */
function FiducialsPreview({
  panelW,
  panelH,
  positions,
  diameterMm,
  existing,
  replacing,
}: {
  panelW: number;
  panelH: number;
  positions: { x_mm: number; y_mm: number }[];
  diameterMm: number;
  existing: ToolingHole[];
  replacing: boolean;
}) {
  if (panelW <= 0 || panelH <= 0) return null;
  const scale = Math.min(BOX_W / panelW, BOX_H / panelH);
  const vw = panelW * scale;
  const vh = panelH * scale;
  const r = Math.max((diameterMm / 2) * scale, MIN_DOT_PX);

  return (
    <div className="flex items-center justify-center rounded-md border border-border bg-background/40 p-3">
      <svg width={vw} height={vh} className="overflow-visible">
        <rect
          x={0}
          y={0}
          width={vw}
          height={vh}
          rx={2}
          style={{ fill: "hsl(var(--pcb-preview))", stroke: "hsl(var(--primary) / 0.85)" }}
          strokeWidth={1.5}
        />
        {existing.map((h) => (
          <circle
            key={h.id}
            cx={h.x_mm * scale}
            cy={h.y_mm * scale}
            r={Math.max((h.diameter_mm / 2) * scale, MIN_DOT_PX)}
            style={{
              fill: "hsl(var(--muted-foreground) / 0.15)",
              stroke: "hsl(var(--muted-foreground) / 0.6)",
            }}
            strokeWidth={1}
            opacity={replacing ? 0.3 : 1}
          />
        ))}
        {positions.map((p, i) => {
          // Mirror the actual placement: bore clamped inside the panel.
          const c = clampToolingHoleCenter(p.x_mm, p.y_mm, diameterMm / 2, panelW, panelH);
          return (
            <circle
              key={`new-${i}`}
              cx={c.x * scale}
              cy={c.y * scale}
              r={r}
              style={{ fill: "hsl(var(--primary) / 0.2)", stroke: "hsl(var(--primary))" }}
              strokeWidth={1.5}
            />
          );
        })}
      </svg>
    </div>
  );
}

/** Format a mm value to two decimal places, stripping trailing zeros. */
function fmtMm(v: number): string {
  return v.toFixed(2).replace(/\.?0+$/, "");
}

export interface AutoFiducialsOptions {
  params: FiducialParams;
  replace: boolean;
}

/** Dialog for auto-placing fiducial holes symmetrically about the panel centre.
 *
 *  Parameters: axis (X/Y), count N≥2, step between holes, diameter, and the
 *  offset from the panel edge perpendicular to the axis.  The resulting hole
 *  coordinates are shown in a table so the user can verify before applying. */
export function AutoFiducialsDialog({
  open,
  onClose,
  panelW,
  panelH,
  existingHoles,
  initialParams,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  panelW: number;
  panelH: number;
  existingHoles: ToolingHole[];
  /** Seeds the dialog fields; falls back to DEFAULT_FIDUCIAL_PARAMS when null/undefined. */
  initialParams?: FiducialParams | null;
  onApply: (opts: AutoFiducialsOptions) => void;
}) {
  const { t } = useTranslation(["project", "common"]);

  const seed = initialParams ?? DEFAULT_FIDUCIAL_PARAMS;
  const [axis, setAxis] = useState<FiducialAxis>(seed.axis);
  const [count, setCount] = useState(seed.count);
  const [stepMm, setStepMm] = useState(seed.step_mm);
  const [diameterMm, setDiameterMm] = useState(seed.diameter_mm);
  const [centerOffsetMm, setCenterOffsetMm] = useState(seed.center_offset_mm);
  const [mode, setMode] = useState<"add" | "replace">("add");

  const hasExisting = existingHoles.length > 0;
  const replacing = hasExisting && mode === "replace";

  const params: FiducialParams = { axis, count, step_mm: stepMm, diameter_mm: diameterMm, center_offset_mm: centerOffsetMm };
  const positions = useMemo(
    () => placeFiducials(panelW, panelH, params),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [panelW, panelH, axis, count, stepMm, diameterMm, centerOffsetMm],
  );

  const handleApply = () => {
    onApply({ params, replace: replacing });
    onClose();
  };

  // Count options 2..8.
  const countOptions = Array.from({ length: 7 }, (_, i) => i + 2);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("panel.autoFiducials.title")}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("panel.renest.cancel")}
          </Button>
          <Button onClick={handleApply}>{t("panel.autoFiducials.apply")}</Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4 text-[12px]">
        <FiducialsPreview
          panelW={panelW}
          panelH={panelH}
          positions={positions}
          diameterMm={diameterMm}
          existing={existingHoles}
          replacing={replacing}
        />

        <Group title={t("panel.autoFiducials.axis")}>
          <SegmentedControl<FiducialAxis>
            value={axis}
            onChange={setAxis}
            options={[
              { value: "x", label: t("panel.autoFiducials.axisX") },
              { value: "y", label: t("panel.autoFiducials.axisY") },
            ]}
          />
        </Group>

        <Group title={t("panel.autoFiducials.params")}>
          <label className="flex items-center gap-1.5 text-muted-foreground">
            {t("panel.autoFiducials.count")}
            <Select
              value={String(count)}
              onChange={(e) => setCount(Number(e.target.value))}
              className="w-16"
            >
              {countOptions.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </Select>
          </label>
          <label className="flex items-center gap-1.5 text-muted-foreground">
            {t("panel.autoFiducials.step")}
            <UnitField value={stepMm} onChange={setStepMm} dim="fine" step="1" />
          </label>
          <label className="flex items-center gap-1.5 text-muted-foreground">
            {t("panel.tooling.diameter")}
            <UnitField value={diameterMm} onChange={setDiameterMm} dim="fine" step="0.5" />
          </label>
          <label className="flex items-center gap-1.5 text-muted-foreground">
            {t("panel.autoFiducials.centerOffset")}
            <UnitField value={centerOffsetMm} onChange={setCenterOffsetMm} dim="fine" step="0.5" />
          </label>
        </Group>

        {/* Coordinate table: shows where each hole will land. */}
        <Group title={t("panel.autoFiducials.coordinates")}>
          <div className="w-full overflow-hidden rounded-md border border-border">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">
                    {t("panel.autoFiducials.coordNo")}
                  </th>
                  <th className="px-3 py-1.5 text-right font-medium text-muted-foreground">{`X, ${t("common:unit.mm")}`}</th>
                  <th className="px-3 py-1.5 text-right font-medium text-muted-foreground">{`Y, ${t("common:unit.mm")}`}</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p, i) => {
                  const c = clampToolingHoleCenter(p.x_mm, p.y_mm, diameterMm / 2, panelW, panelH);
                  return (
                    <tr key={i} className={i % 2 === 1 ? "bg-muted/10" : ""}>
                      <td className="px-3 py-1 text-left text-muted-foreground">{i + 1}</td>
                      <td className="px-3 py-1 text-right tabular-nums">{fmtMm(c.x)}</td>
                      <td className="px-3 py-1 text-right tabular-nums">{fmtMm(c.y)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Group>

        {hasExisting && (
          <Group title={t("panel.regset.existing")}>
            <SegmentedControl<"add" | "replace">
              value={mode}
              onChange={setMode}
              options={[
                { value: "add", label: t("panel.regset.existingAdd") },
                { value: "replace", label: t("panel.regset.existingReplace") },
              ]}
            />
          </Group>
        )}
      </div>
    </Modal>
  );
}

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { UnitField } from "@/components/ui/settings/UnitField";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { DEFAULT_TOOLING_DIAMETER_MM, REGISTRATION_SET_MARGIN_MM } from "@/lib/panel";
import { registrationSetPositions, clampToolingHoleCenter } from "@/lib/panelPlacement";
import type { ToolingHole } from "@/lib/api";

export interface RegistrationSetOptions {
  count: 2 | 4;
  marginMm: number;
  diameterMm: number;
  replace: boolean;
}

// Preview box budget (px). The panel is fit into this preserving aspect.
const BOX_W = 300;
const BOX_H = 150;
const MIN_DOT_PX = 2.5;

/** Small caption group (mirrors RenestDialog style). */
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">{children}</div>
    </div>
  );
}

/** Live preview of the registration set on a scaled panel: existing holes (muted,
 *  faded when they'll be replaced) + the set-to-be (copper). Pure render. */
function RegSetPreview({
  panelW,
  panelH,
  diameterMm,
  positions,
  existing,
  replacing,
}: {
  panelW: number;
  panelH: number;
  diameterMm: number;
  positions: { x: number; y: number }[];
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
          // Mirror addRegistrationSet: clamp the bore fully inside the panel so the
          // preview matches where the hole actually lands (WYSIWYG).
          const c = clampToolingHoleCenter(p.x, p.y, diameterMm / 2, panelW, panelH);
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

/** Parameterised generator for a registration-hole set. Asks for layout (2
 *  diagonal / 4 corners), edge margin and diameter, with a live preview; when
 *  holes already exist it also offers add-vs-replace. Placement → onApply. */
export function RegistrationSetDialog({
  open,
  onClose,
  panelW,
  panelH,
  existingHoles,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  panelW: number;
  panelH: number;
  existingHoles: ToolingHole[];
  onApply: (opts: RegistrationSetOptions) => void;
}) {
  const { t } = useTranslation(["project", "common"]);
  const [count, setCount] = useState<"2" | "4">("4");
  const [marginMm, setMarginMm] = useState(REGISTRATION_SET_MARGIN_MM);
  const [diameterMm, setDiameterMm] = useState(DEFAULT_TOOLING_DIAMETER_MM);
  const [mode, setMode] = useState<"add" | "replace">("add");

  const hasExisting = existingHoles.length > 0;
  const replacing = hasExisting && mode === "replace";
  const positions = useMemo(
    () => registrationSetPositions(panelW, panelH, marginMm, count === "2" ? 2 : 4),
    [panelW, panelH, marginMm, count],
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("panel.regset.title")}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("panel.renest.cancel")}
          </Button>
          <Button
            onClick={() => {
              onApply({ count: count === "2" ? 2 : 4, marginMm, diameterMm, replace: replacing });
              onClose();
            }}
          >
            {t("panel.regset.apply")}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4 text-[12px]">
        <RegSetPreview
          panelW={panelW}
          panelH={panelH}
          diameterMm={diameterMm}
          positions={positions}
          existing={existingHoles}
          replacing={replacing}
        />

        <Group title={t("panel.regset.placement")}>
          <SegmentedControl<"2" | "4">
            value={count}
            onChange={setCount}
            options={[
              { value: "4", label: t("panel.regset.placement4") },
              { value: "2", label: t("panel.regset.placement2") },
            ]}
          />
        </Group>

        <Group title={t("panel.regset.params")}>
          <label className="flex items-center gap-1.5 text-muted-foreground">
            {t("panel.regset.margin")}
            <UnitField value={marginMm} onChange={setMarginMm} dim="fine" step="0.5" />
          </label>
          <label className="flex items-center gap-1.5 text-muted-foreground">
            {t("panel.tooling.diameter")}
            <UnitField value={diameterMm} onChange={setDiameterMm} dim="fine" step="0.5" />
          </label>
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

import { useState } from "react";
import { Move } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useShell } from "@/shellStore";
import { usePanelSelection } from "@/panelSelectionStore";
import { usePlacedBoardSizes } from "@/hooks/usePlacedBoardSizes";
import { useUnitFormat } from "@/i18n/useUnitFormat";
import { instanceBounds, clampPoseIntoPanel } from "@/lib/panelPlacement";
import { SettingRow } from "@/components/ui/settings/SettingRow";
import { UnitField } from "@/components/ui/settings/UnitField";
import { TextInput } from "@/components/ui/TextInput";
import type { BoardInstance } from "@/lib/api";

// Stable empty fallback so the selector keeps a constant reference when there's
// no panel (avoids re-running consumers every render).
const EMPTY: BoardInstance[] = [];

/** Degrees input with a "°" suffix. Keeps a raw draft while editing so an empty
 *  field / intermediate value isn't coerced; commits a finite number on change. */
function DegreeField({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = Math.round(value * 10) / 10;
  return (
    <div className="relative w-28">
      <TextInput
        type="number"
        step="1"
        inputMode="decimal"
        className="pr-7"
        value={draft ?? String(shown)}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          const n = parseFloat(raw);
          if (raw.trim() !== "" && Number.isFinite(n)) onChange(n);
        }}
        onBlur={() => setDraft(null)}
      />
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">
        °
      </span>
    </div>
  );
}

/** Numeric placement inspector for the selected BoardInstance(s): typed X / Y /
 *  rotation (+ read-only size) for precise positioning, beyond drag/nudge/knob.
 *  X/Y are the instance's (rotated) AABB top-left in mm from the panel origin, so
 *  they match the rulers; edits clamp the board back into the panel. Renders only
 *  when something is selected; multi-selection shows a count hint (v1). */
export function PlacementFields({ panelW, panelH }: { panelW: number; panelH: number }) {
  const { t } = useTranslation("project");
  const { fmtLen } = useUnitFormat();
  const selected = usePanelSelection((s) => s.selected);
  const instances = useShell((s) => s.currentManifest?.panel?.instances ?? EMPTY);
  const setInstanceTransforms = useShell((s) => s.setInstanceTransforms);
  const sizes = usePlacedBoardSizes();

  // Only instances with a resolved board size can be edited (need the footprint).
  const sel = instances.filter((i) => selected.has(i.id) && sizes[i.design_id]);
  if (sel.length === 0) return null;

  const header = (
    <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-foreground">
      <Move className="size-4 text-muted-foreground" />
      {t("setup.placement.title")}
    </div>
  );

  if (sel.length > 1) {
    return (
      <div className="border-b border-border px-3 py-3">
        {header}
        <p className="text-[11px] text-muted-foreground">{t("setup.placement.multi", { count: sel.length })}</p>
      </div>
    );
  }

  const inst = sel[0];
  const sz = sizes[inst.design_id];
  const b = instanceBounds({ xMm: inst.x_mm, yMm: inst.y_mm, boardW: sz.w, boardH: sz.h, rotationDeg: inst.rotation_deg });

  // Apply a candidate pose, clamped back into the panel, as one undo step.
  const commit = (pose: { x_mm: number; y_mm: number; rotation_deg: number }) => {
    const c = clampPoseIntoPanel(pose, sz.w, sz.h, panelW, panelH);
    void setInstanceTransforms([{ id: inst.id, x_mm: c.x_mm, y_mm: c.y_mm, rotation_deg: pose.rotation_deg }]);
  };
  // X/Y edit the AABB top-left → shift the origin by the same delta (the
  // origin↔AABB offset is constant for a fixed rotation).
  const setX = (minX: number) => commit({ x_mm: inst.x_mm + (minX - b.minX), y_mm: inst.y_mm, rotation_deg: inst.rotation_deg });
  const setY = (minY: number) => commit({ x_mm: inst.x_mm, y_mm: inst.y_mm + (minY - b.minY), rotation_deg: inst.rotation_deg });
  const setRot = (deg: number) => commit({ x_mm: inst.x_mm, y_mm: inst.y_mm, rotation_deg: ((deg % 360) + 360) % 360 });

  return (
    <div className="border-b border-border px-3 py-3">
      {header}
      <SettingRow label={t("setup.placement.x")}>
        <UnitField value={b.minX} onChange={setX} dim="coarse" step="1" />
      </SettingRow>
      <SettingRow label={t("setup.placement.y")}>
        <UnitField value={b.minY} onChange={setY} dim="coarse" step="1" />
      </SettingRow>
      <SettingRow label={t("setup.placement.rotation")}>
        <DegreeField value={inst.rotation_deg} onChange={setRot} />
      </SettingRow>
      <SettingRow label={t("setup.placement.size")}>
        <span className="text-[12px] tabular-nums text-muted-foreground">
          {fmtLen(sz.w)} × {fmtLen(sz.h)}
        </span>
      </SettingRow>
    </div>
  );
}

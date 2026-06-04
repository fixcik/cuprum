import { useLayoutEffect, useRef, useState } from "react";
import { RotateCw, Ruler, Copy, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useShell } from "@/shellStore";
import { usePanelSelection } from "@/panelSelectionStore";
import { usePlacedBoardSizes } from "@/hooks/usePlacedBoardSizes";
import { useUnitFormat } from "@/i18n/useUnitFormat";
import { instanceBounds, clampPoseIntoPanel } from "@/lib/panelPlacement";
import { placeHud } from "@/lib/hudPlacement";
import { RULER_TOP, RULER_LEFT } from "@/components/editor/canvasStyle";
import type { Viewport } from "@/components/editor/RulersOverlay";
import type { BoardInstance, ProjectDesign } from "@/lib/api";

const EMPTY_INST: BoardInstance[] = [];
const EMPTY_DESIGNS: ProjectDesign[] = [];
// Below this on-screen board width the full HUD (with X/Y + size) is wider than the
// board, so we drop to actions-only to avoid the HUD dwarfing the object.
const HUD_FULL_MIN_PX = 220;

/** Compact unit-aware coordinate input (mm model, active-unit display). */
function HudCoord({ label, valueMm, onCommitMm }: { label: string; valueMm: number; onCommitMm: (mm: number) => void }) {
  const { toDisplay, fromDisplay } = useUnitFormat();
  const shown = +toDisplay(valueMm, "coarse").toFixed(3);
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="flex items-center gap-1">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <input
        type="number"
        inputMode="decimal"
        className="h-6 w-12 rounded border border-input bg-background px-1 text-right text-[11px] tabular-nums text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        value={draft ?? String(shown)}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          const n = parseFloat(raw);
          if (raw.trim() !== "" && Number.isFinite(n)) onCommitMm(fromDisplay(n, "coarse"));
        }}
        onBlur={() => setDraft(null)}
        onMouseDown={(e) => e.stopPropagation()}
      />
    </label>
  );
}

/** Floating, object-anchored HUD with the selected board's properties (name, X/Y,
 *  rotate 90°, size, duplicate, delete). Screen-space overlay above the Konva stage;
 *  follows the board live (drag/rotate/pan), stays a constant size under zoom, flips/
 *  clamps at viewport edges, and collapses to actions-only on a small board. Shown
 *  only for a single selected instance (multi-selection keeps PanelAlignBar). */
export function SelectionHud({
  viewport,
  size,
  panelW,
  panelH,
  livePose,
  onDuplicate,
  onDelete,
  onRotate90,
}: {
  viewport: Viewport;
  size: { w: number; h: number };
  panelW: number;
  panelH: number;
  livePose: { dragDelta: { dx: number; dy: number } | null; rotPreview: number | null };
  onDuplicate: () => void;
  onDelete: () => void;
  onRotate90: () => void;
}) {
  const { t } = useTranslation("project");
  const { fmtLen } = useUnitFormat();
  const selected = usePanelSelection((s) => s.selected);
  const instances = useShell((s) => s.currentManifest?.panel?.instances ?? EMPTY_INST);
  const designs = useShell((s) => s.currentManifest?.designs ?? EMPTY_DESIGNS);
  const setInstanceTransforms = useShell((s) => s.setInstanceTransforms);
  const sizes = usePlacedBoardSizes();

  const ref = useRef<HTMLDivElement>(null);
  const [hud, setHud] = useState({ w: 0, h: 0 });

  const ids = [...selected];
  const inst = ids.length === 1 ? instances.find((i) => i.id === ids[0]) : undefined;
  const sz = inst ? sizes[inst.design_id] : undefined;

  // Measure after each layout so flip/clamp use the real HUD size (no flicker:
  // useLayoutEffect runs before paint).
  useLayoutEffect(() => {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    if (r.width !== hud.w || r.height !== hud.h) setHud({ w: r.width, h: r.height });
  });

  if (!inst || !sz || viewport.pxPerMm <= 0) return null;

  const name = designs.find((d) => d.id === inst.design_id)?.source_name ?? "";

  // Committed bbox → X/Y field values + edit math. Live bbox (incl. drag/rotate
  // preview) → on-screen position so the HUD tracks the board during manipulation.
  const committed = instanceBounds({ xMm: inst.x_mm, yMm: inst.y_mm, boardW: sz.w, boardH: sz.h, rotationDeg: inst.rotation_deg });
  const dx = livePose.dragDelta?.dx ?? 0;
  const dy = livePose.dragDelta?.dy ?? 0;
  const liveRot = inst.rotation_deg + (livePose.rotPreview ?? 0);
  const live = instanceBounds({ xMm: inst.x_mm + dx, yMm: inst.y_mm + dy, boardW: sz.w, boardH: sz.h, rotationDeg: liveRot });

  const sx = (mm: number) => viewport.originX + mm * viewport.pxPerMm;
  const sy = (mm: number) => viewport.originY + mm * viewport.pxPerMm;
  const bboxScreen = { left: sx(live.minX), right: sx(live.maxX), top: sy(live.minY), bottom: sy(live.maxY) };
  const compact = bboxScreen.right - bboxScreen.left < HUD_FULL_MIN_PX;

  const pos = placeHud({
    bboxScreen,
    viewportW: size.w,
    hudW: hud.w || 1,
    hudH: hud.h || 1,
    rulerTop: RULER_TOP,
    rulerLeft: RULER_LEFT,
  });

  const commit = (pose: { x_mm: number; y_mm: number; rotation_deg: number }) => {
    const c = clampPoseIntoPanel(pose, sz.w, sz.h, panelW, panelH);
    void setInstanceTransforms([{ id: inst.id, x_mm: c.x_mm, y_mm: c.y_mm, rotation_deg: pose.rotation_deg }]);
  };
  const setX = (minX: number) => commit({ x_mm: inst.x_mm + (minX - committed.minX), y_mm: inst.y_mm, rotation_deg: inst.rotation_deg });
  const setY = (minY: number) => commit({ x_mm: inst.x_mm, y_mm: inst.y_mm + (minY - committed.minY), rotation_deg: inst.rotation_deg });

  // 90° rotation swaps the displayed W×H.
  const quarter = Math.abs(Math.round(inst.rotation_deg / 90)) % 2 === 1;
  const dimW = quarter ? sz.h : sz.w;
  const dimH = quarter ? sz.w : sz.h;

  const sep = <div className="h-5 w-px bg-border" />;
  const actionBtn =
    "grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground";

  return (
    <div
      ref={ref}
      data-hud
      onMouseDown={(e) => e.stopPropagation()}
      className="pointer-events-auto absolute z-20 flex items-center gap-1 whitespace-nowrap rounded-lg border border-border bg-card/95 p-1 shadow-2xl backdrop-blur"
      style={{ left: pos.left, top: pos.top, animation: "hudIn 120ms ease-out" }}
    >
      <div className="flex items-center gap-1.5 px-1.5 py-1 text-[11px] font-medium text-foreground">
        <span className="size-5 rounded-[3px] bg-muted ring-1 ring-primary/60" />
        <span className="max-w-[120px] truncate">{name}</span>
      </div>

      {!compact && (
        <>
          {sep}
          <HudCoord label={t("setup.placement.x")} valueMm={committed.minX} onCommitMm={setX} />
          <HudCoord label={t("setup.placement.y")} valueMm={committed.minY} onCommitMm={setY} />
        </>
      )}

      {sep}
      <button type="button" className={actionBtn} title={t("panel.hud.rotate")} onClick={onRotate90}>
        <RotateCw className="size-4" />
      </button>

      {!compact && (
        <>
          {sep}
          <div className="flex items-center gap-1.5 rounded-md bg-muted/50 px-1.5 py-1 text-[11px] text-muted-foreground">
            <Ruler className="size-3.5" />
            <span className="tabular-nums text-foreground/90">
              {fmtLen(dimW)} × {fmtLen(dimH)}
            </span>
          </div>
        </>
      )}

      {sep}
      <button type="button" className={actionBtn} title={t("panel.hud.duplicate")} onClick={onDuplicate}>
        <Copy className="size-4" />
      </button>
      <button
        type="button"
        className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
        title={t("panel.hud.delete")}
        onClick={onDelete}
      >
        <Trash2 className="size-4" />
      </button>

      {/* Caret pointing at the board centre. */}
      <span
        className={`absolute size-2 rotate-45 bg-card ${pos.placement === "top" ? "border-b border-r border-border" : "border-l border-t border-border"}`}
        style={{ left: pos.caretLeft - 4, [pos.placement === "top" ? "bottom" : "top"]: -4 }}
      />
    </div>
  );
}

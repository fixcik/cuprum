import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer, Rect, Group, Text } from "react-konva";
import Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";
import { Maximize, Plus, Minus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { PanelToolPalette, type PanelTool } from "@/components/panel/PanelToolPalette";
import { CadGrid } from "@/components/editor/CadGrid";
import { MIN_SCALE, MAX_SCALE, COPPER_STROKE, COPPER_FILL, NO_COPPER_STROKE } from "@/components/editor/canvasStyle";
import { useShell } from "@/shellStore";
import { api, type BoardInstance, type ProjectDesign } from "@/lib/api";

const EDGE_KEEP = 64; // px of the blank that must stay on-canvas while panning

// Stable empty fallbacks so the store selectors keep a constant reference when
// the panel/designs are absent (avoids re-running the sizes effect every render).
const EMPTY_INSTANCES: BoardInstance[] = [];
const EMPTY_DESIGNS: ProjectDesign[] = [];

/** Schematic preview of an empty FR4 blank, in the dark CAD-canvas style of the
 *  exposure editor. Copper-clad side → solid amber outline + faint fill + "Cu";
 *  bare side → dashed grey outline + "no copper". Top always has copper; the
 *  bottom only when double-sided. Driven purely by props (no exposure store). */
export function PanelBlankCanvas({
  widthMm,
  heightMm,
  doubleSided,
}: {
  widthMm: number;
  heightMm: number;
  doubleSided: boolean;
}) {
  const { t } = useTranslation(["project", "common"]);
  const pxPerMm = useShell((s) => s.pxPerMm);
  const instances = useShell((s) => s.currentManifest?.panel?.instances ?? EMPTY_INSTANCES);
  const designs = useShell((s) => s.currentManifest?.designs ?? EMPTY_DESIGNS);
  const workingDir = useShell((s) => s.workingDir);
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [zoomPct, setZoomPct] = useState(100);
  const [side, setSide] = useState<"top" | "bottom">("top");
  const [spaceDown, setSpaceDown] = useState(false);
  const [tool, setTool] = useState<PanelTool>("select");
  const panMode = tool === "pan" || spaceDown;
  // Resolved board extents (mm) keyed by design id, fetched once per referenced design.
  const [sizes, setSizes] = useState<Record<string, { w: number; h: number }>>({});

  // Resolve board extents (mm) for placed instances (cached metrics). Keyed by
  // design id; fetched once per design referenced on the panel.
  useEffect(() => {
    if (!workingDir) return;
    const needed = Array.from(new Set(instances.map((i) => i.design_id))).filter((id) => !sizes[id]);
    let cancelled = false;
    needed.forEach((id) => {
      const d = designs.find((x) => x.id === id);
      if (!d) return;
      api
        .projectBoardMetrics(
          workingDir,
          d.gerbers.map((g) => ({ rel: g.path, layerType: g.layer_type })),
        )
        .then((m) => {
          if (cancelled) return;
          setSizes((prev) => ({ ...prev, [id]: { w: m.metrics.board.widthMm, h: m.metrics.board.heightMm } }));
        })
        .catch(() => {});
    });
    // Drop cached extents for designs no longer placed (bound session growth).
    const liveIds = new Set(instances.map((i) => i.design_id));
    setSizes((prev) => {
      const entries = Object.entries(prev).filter(([id]) => liveIds.has(id));
      return entries.length === Object.keys(prev).length ? prev : Object.fromEntries(entries);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingDir, instances, designs]);

  // O(1) design lookup for the instance render loop + labels.
  const designById = useMemo(() => new Map(designs.map((d) => [d.id, d])), [designs]);

  const W = Math.max(widthMm, 1);
  const H = Math.max(heightMm, 1);
  const hasCopper = side === "top" || doubleSided;

  const fit = useMemo(() => Math.min(size.w / W, size.h / H) * 0.9, [size.w, size.h, W, H]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (down: boolean) => (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      e.preventDefault();
      setSpaceDown(down);
    };
    const kd = onKey(true);
    const ku = onKey(false);
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    return () => {
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
    };
  }, []);

  const clampPos = useCallback(
    (x: number, y: number, scale: number) => {
      const sw = W * fit * scale;
      const sh = H * fit * scale;
      return {
        x: Math.min(size.w - EDGE_KEEP, Math.max(EDGE_KEEP - sw, x)),
        y: Math.min(size.h - EDGE_KEEP, Math.max(EDGE_KEEP - sh, y)),
      };
    },
    [fit, size.w, size.h, W, H],
  );

  const centerAt = useCallback(
    (scale: number, animate: boolean) => {
      const stage = stageRef.current;
      if (!stage) return;
      const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
      const pos = clampPos((size.w - W * fit * s) / 2, (size.h - H * fit * s) / 2, s);
      if (animate) {
        stage.to({ x: pos.x, y: pos.y, scaleX: s, scaleY: s, duration: 0.16, easing: Konva.Easings.EaseOut });
      } else {
        stage.scale({ x: s, y: s });
        stage.position(pos);
        stage.batchDraw();
      }
      setZoomPct(Math.round((fit * s / pxPerMm) * 100));
    },
    [clampPos, fit, size.w, size.h, W, H, pxPerMm],
  );

  const fitView = useCallback(() => centerAt(1, true), [centerAt]);
  const realSize = useCallback(() => centerAt(pxPerMm / fit, true), [centerAt, pxPerMm, fit]);

  // Fit the view on first layout and whenever the blank size (or viewport)
  // changes. In the setup wizard width/height are edited live, so re-framing
  // keeps the resized blank fully in view; manual zoom is intentionally reset.
  const framed = useRef("");
  useEffect(() => {
    const key = `${W}:${H}:${size.w}:${size.h}`;
    if (size.w === 0 || framed.current === key) return;
    framed.current = key;
    centerAt(1, false);
  }, [W, H, size.w, size.h, centerAt]);

  const zoomAt = useCallback(
    (pointer: { x: number; y: number }, factor: number, animate = false) => {
      const stage = stageRef.current;
      if (!stage) return;
      const oldScale = stage.scaleX();
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, oldScale * factor));
      if (newScale === oldScale) return;
      const wx = (pointer.x - stage.x()) / oldScale;
      const wy = (pointer.y - stage.y()) / oldScale;
      const pos = clampPos(pointer.x - wx * newScale, pointer.y - wy * newScale, newScale);
      if (animate) {
        stage.to({ x: pos.x, y: pos.y, scaleX: newScale, scaleY: newScale, duration: 0.16, easing: Konva.Easings.EaseOut });
      } else {
        stage.scale({ x: newScale, y: newScale });
        stage.position(pos);
        stage.batchDraw();
      }
      setZoomPct(Math.round((fit * newScale / pxPerMm) * 100));
    },
    [clampPos, fit, pxPerMm],
  );

  const onWheel = (e: KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    zoomAt(pointer, Math.exp(-e.evt.deltaY * 0.0015));
  };

  const zoomButton = (factor: number) => zoomAt({ x: size.w / 2, y: size.h / 2 }, factor, true);

  const dragBound = (pos: { x: number; y: number }) => {
    const stage = stageRef.current;
    return clampPos(pos.x, pos.y, stage ? stage.scaleX() : 1);
  };
  const setCursor = (c: string) => {
    const el = containerRef.current;
    if (el) el.style.cursor = c;
  };

  const labelMm = Math.max(Math.min(W, H) * 0.08, 2);

  return (
    <div
      ref={containerRef}
      className={`relative h-full w-full overflow-hidden bg-[#0a0c10] ${panMode ? "cursor-grab" : ""}`}
    >
      <Stage
        ref={stageRef}
        width={size.w}
        height={size.h}
        draggable={panMode}
        dragBoundFunc={dragBound}
        onWheel={onWheel}
        onDragStart={() => setCursor("grabbing")}
        onDragEnd={() => setCursor(panMode ? "grab" : "")}
      >
        <Layer>
          <Group x={0} y={0} scaleX={fit} scaleY={fit}>
            <CadGrid widthMm={W} heightMm={H} />
            <Rect
              x={0}
              y={0}
              width={W}
              height={H}
              fill={hasCopper ? COPPER_FILL : undefined}
              stroke={hasCopper ? COPPER_STROKE : NO_COPPER_STROKE}
              strokeWidth={hasCopper ? 1.25 : 1}
              strokeScaleEnabled={false}
              dash={hasCopper ? undefined : [3, 2]}
            />
            {instances.length === 0 && (
              <Text
                x={0}
                y={H / 2 - labelMm / 2}
                width={W}
                align="center"
                text={hasCopper ? t("panel.canvas.copper") : t("panel.canvas.noCopper")}
                fontSize={labelMm}
                fill={hasCopper ? COPPER_STROKE : NO_COPPER_STROKE}
                listening={false}
              />
            )}
            {instances.map((inst) => {
              const sz = sizes[inst.design_id];
              const instSide = inst.layer_ref === "Bottom" ? "bottom" : "top";
              if (!sz || instSide !== side) return null;
              const name = designById.get(inst.design_id)?.source_name ?? "";
              // Axis-aligned footprint at (x_mm, y_mm): a 90°/270° instance occupies a
              // swapped (h × w) slot — matches packLayout's placement. No Konva rotation.
              const rot = ((inst.rotation_deg % 360) + 360) % 360;
              const fw = rot === 90 || rot === 270 ? sz.h : sz.w;
              const fh = rot === 90 || rot === 270 ? sz.w : sz.h;
              return (
                <Group key={inst.id} x={inst.x_mm} y={inst.y_mm}>
                  <Rect
                    width={fw}
                    height={fh}
                    fill={COPPER_FILL}
                    stroke={COPPER_STROKE}
                    strokeWidth={1}
                    strokeScaleEnabled={false}
                    cornerRadius={0.3}
                  />
                  <Text
                    x={0}
                    y={0}
                    width={fw}
                    height={fh}
                    align="center"
                    verticalAlign="middle"
                    text={name}
                    // mm — scales with the board rect inside the fit-scaled group
                    fontSize={Math.max(Math.min(fw, fh) * 0.12, 1.5)}
                    fill={COPPER_STROKE}
                    listening={false}
                  />
                </Group>
              );
            })}
          </Group>
        </Layer>
      </Stage>

      <PanelToolPalette tool={tool} onToolChange={setTool} />

      <div className="absolute left-20 top-3 z-10">
        <SegmentedControl<"top" | "bottom">
          value={side}
          onChange={setSide}
          options={[
            { value: "top", label: t("setup.sideTop") },
            { value: "bottom", label: t("setup.sideBottom") },
          ]}
        />
      </div>

      <div className="absolute right-3 top-3 z-10 rounded-md border border-border bg-card/90 px-2 py-1 text-[11px] tabular-nums text-muted-foreground">
        {W} × {H} mm
      </div>

      <div className="absolute bottom-2 right-2 flex items-center gap-0.5 rounded-md border border-border bg-card/90 p-0.5 text-muted-foreground [&_button]:cursor-pointer">
        <button className="rounded p-1 hover:bg-muted/60" aria-label={t("common:viewer.zoomOut")} title={t("common:viewer.zoomOut")} onClick={() => zoomButton(1 / 1.2)}>
          <Minus className="size-4" />
        </button>
        <button
          className="min-w-12 rounded px-1.5 py-1 text-center text-[11px] tabular-nums hover:bg-muted/60"
          aria-label={t("common:viewer.realSize")}
          title={t("common:viewer.realSize")}
          onClick={realSize}
        >
          {zoomPct}%
        </button>
        <button className="rounded p-1 hover:bg-muted/60" aria-label={t("common:viewer.zoomIn")} title={t("common:viewer.zoomIn")} onClick={() => zoomButton(1.2)}>
          <Plus className="size-4" />
        </button>
        <button className="rounded p-1 hover:bg-muted/60" aria-label={t("common:viewer.fitAll")} title={t("common:viewer.fitAll")} onClick={fitView}>
          <Maximize className="size-4" />
        </button>
      </div>
    </div>
  );
}

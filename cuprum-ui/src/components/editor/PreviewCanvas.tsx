import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer, Rect, Group, Line, Image as KImage } from "react-konva";
import Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";
import { Maximize, Plus, Minus, Loader2 } from "lucide-react";
import { SCREEN_W_MM, SCREEN_H_MM } from "@/lib/api";
import { useStore, type Placement } from "@/store";
import { CanvasToolbar } from "@/components/editor/CanvasToolbar";
import { CadGrid } from "@/components/editor/CadGrid";
import { MIN_SCALE, MAX_SCALE } from "@/components/editor/canvasStyle";

/** Build an inverted (RGB) copy of a loaded image via an offscreen canvas. */
function invertImage(im: HTMLImageElement): HTMLImageElement {
  const c = document.createElement("canvas");
  c.width = im.naturalWidth;
  c.height = im.naturalHeight;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(im, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    px[i] = 255 - px[i];
    px[i + 1] = 255 - px[i + 1];
    px[i + 2] = 255 - px[i + 2];
  }
  ctx.putImageData(data, 0, 0);
  const out = new window.Image();
  out.src = c.toDataURL();
  return out;
}

/** Konva image for one placement. The PNG is drawn directly (no node.cache(),
 *  which would rasterize at the node's mm size and blur); invert swaps to a
 *  pre-built inverted copy, so both stay crisp and toggling is instant. */
function GerberImage({
  p,
  selected,
  invert,
  onPick,
  onDragStart,
  onDragMove,
  onDragEnd,
}: {
  p: Placement;
  selected: boolean;
  invert: boolean;
  onPick: (p: Placement, additive: boolean) => void;
  onDragStart: (p: Placement, node: Konva.Node) => void;
  onDragMove: (p: Placement, node: Konva.Node) => void;
  onDragEnd: (p: Placement, node: Konva.Node) => void;
}) {
  const [normal, setNormal] = useState<HTMLImageElement | null>(null);
  const [inverted, setInverted] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    const im = new window.Image();
    im.src = p.pngUrl;
    im.onload = () => {
      setNormal(im);
      setInverted(invertImage(im));
    };
  }, [p.pngUrl]);

  const img = invert ? inverted : normal;
  if (!img) return null;
  // Image + selection glow live in one draggable Group so the glow tracks the
  // artwork while dragging (it's a child, not bound to committed store coords).
  return (
    <Group
      x={p.xMm}
      y={p.yMm}
      draggable
      onMouseDown={(e) => onPick(p, e.evt.shiftKey || e.evt.metaKey || e.evt.ctrlKey)}
      onTap={() => onPick(p, false)}
      onMouseEnter={(e) => {
        const s = e.target.getStage();
        if (s) s.container().style.cursor = "move";
      }}
      onMouseLeave={(e) => {
        const s = e.target.getStage();
        if (s) s.container().style.cursor = "";
      }}
      onDragStart={(e) => onDragStart(p, e.target)}
      onDragMove={(e) => onDragMove(p, e.target)}
      onDragEnd={(e) => onDragEnd(p, e.target)}
    >
      <KImage
        image={img}
        x={0}
        y={0}
        width={p.wMm}
        height={p.hMm}
        shadowEnabled={selected}
        shadowColor="#f0a24e"
        shadowBlur={selected ? 2.5 : 0}
        shadowOpacity={0.95}
        shadowOffset={{ x: 0, y: 0 }}
      />
    </Group>
  );
}

const EDGE_KEEP = 64; // px of the screen that must stay on-canvas while panning
const SNAP_PX = 6; // snap distance in screen pixels

export function PreviewCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [zoomPct, setZoomPct] = useState(100);
  const framedCount = useRef(-1);

  const mirror = useStore((s) => s.mirror);
  const invert = useStore((s) => s.invert);
  const boardWmm = useStore((s) => s.boardWmm);
  const boardHmm = useStore((s) => s.boardHmm);
  const boardXmm = useStore((s) => s.boardXmm);
  const boardYmm = useStore((s) => s.boardYmm);
  const placements = useStore((s) => s.placements);
  const selectedIds = useStore((s) => s.selectedIds);
  const select = useStore((s) => s.select);
  const selectMany = useStore((s) => s.selectMany);
  const move = useStore((s) => s.movePlacement);
  const moveMany = useStore((s) => s.moveMany);
  const tool = useStore((s) => s.tool);
  const previewLoading = useStore((s) => s.previewLoading);
  const [guides, setGuides] = useState<number[][]>([]);
  const dragRef = useRef<{ sx: number; sy: number; items: { id: string; x0: number; y0: number }[] } | null>(null);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const groupRef = useRef<Konva.Group>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const panMode = tool === "pan" || spaceDown;
  const marqueeRef = useRef<{ x0: number; y0: number; additive: boolean } | null>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // Hold Space to temporarily pan in any tool (standard editor convention).
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

  // px-per-mm at stage-scale 1: fit the screen into the viewport with padding.
  const fit = useMemo(
    () => Math.min(size.w / SCREEN_W_MM, size.h / SCREEN_H_MM) * 0.92,
    [size.w, size.h],
  );

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Keep at least EDGE_KEEP px of the screen within the viewport at the given
  // scale — so the board can never be flung completely out of sight.
  const clampPos = useCallback(
    (x: number, y: number, scale: number) => {
      const sw = SCREEN_W_MM * fit * scale;
      const sh = SCREEN_H_MM * fit * scale;
      return {
        x: Math.min(size.w - EDGE_KEEP, Math.max(EDGE_KEEP - sw, x)),
        y: Math.min(size.h - EDGE_KEEP, Math.max(EDGE_KEEP - sh, y)),
      };
    },
    [fit, size.w, size.h],
  );

  // Center at a given scale, optionally animated (used by fit / zoom buttons).
  const centerAt = useCallback(
    (scale: number, animate: boolean) => {
      const stage = stageRef.current;
      if (!stage) return;
      const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
      const pos = clampPos((size.w - SCREEN_W_MM * fit * s) / 2, (size.h - SCREEN_H_MM * fit * s) / 2, s);
      if (animate) {
        stage.to({ x: pos.x, y: pos.y, scaleX: s, scaleY: s, duration: 0.16, easing: Konva.Easings.EaseOut });
      } else {
        stage.scale({ x: s, y: s });
        stage.position(pos);
        stage.batchDraw();
      }
      setZoomPct(Math.round(s * 100));
    },
    [clampPos, fit, size.w, size.h],
  );

  const fitView = useCallback(() => centerAt(1, true), [centerAt]);

  // Frame the view on first mount and whenever a new file is added — but never
  // on a plain window resize (that would yank the user's view around).
  useEffect(() => {
    if (placements.length !== framedCount.current) {
      framedCount.current = placements.length;
      centerAt(1, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placements.length, fit]);

  // Zoom toward a point. `factor` multiplies the scale; cursor stays put.
  const zoomAt = useCallback(
    (pointer: { x: number; y: number }, factor: number, animate = false) => {
      const stage = stageRef.current;
      if (!stage) return;
      const oldScale = stage.scaleX();
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, oldScale * factor));
      if (newScale === oldScale) return;
      const worldX = (pointer.x - stage.x()) / oldScale;
      const worldY = (pointer.y - stage.y()) / oldScale;
      const pos = clampPos(pointer.x - worldX * newScale, pointer.y - worldY * newScale, newScale);
      if (animate) {
        stage.to({ x: pos.x, y: pos.y, scaleX: newScale, scaleY: newScale, duration: 0.16, easing: Konva.Easings.EaseOut });
      } else {
        stage.scale({ x: newScale, y: newScale });
        stage.position(pos);
        stage.batchDraw();
      }
      setZoomPct(Math.round(newScale * 100));
    },
    [clampPos],
  );

  // Wheel zooms toward the cursor (mouse-wheel and trackpad pinch alike); the
  // amount is exponential in the scroll delta so it's smooth and never steps.
  // Shift+wheel pans horizontally; pan is otherwise drag (grab cursor).
  const onWheel = (e: KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    if (e.evt.shiftKey && e.evt.deltaX === 0) {
      const pos = clampPos(stage.x() - e.evt.deltaY, stage.y(), stage.scaleX());
      stage.position(pos);
      stage.batchDraw();
      return;
    }
    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    zoomAt(pointer, Math.exp(-e.evt.deltaY * 0.0015));
  };

  const zoomButton = (factor: number) => zoomAt({ x: size.w / 2, y: size.h / 2 }, factor, true);

  // Snap a dragged box (w×h at the node's x/y) to alignment targets — screen
  // edges/center, optionally the board, and the edges/centers of placements
  // (excluding `excludeId`). Mutates the node and draws guides. Reused by both
  // placement and board dragging.
  const snapBox = useCallback(
    (node: Konva.Node, w: number, h: number, opts: { board: boolean; exclude: Set<string> }) => {
      const stage = stageRef.current;
      const scale = (stage ? stage.scaleX() : 1) * fit;
      const thr = SNAP_PX / scale; // mm
      let nx = node.x();
      let ny = node.y();

      const vts = [0, SCREEN_W_MM / 2, SCREEN_W_MM];
      const hts = [0, SCREEN_H_MM / 2, SCREEN_H_MM];
      if (opts.board) {
        vts.push(boardXmm, boardXmm + boardWmm / 2, boardXmm + boardWmm);
        hts.push(boardYmm, boardYmm + boardHmm / 2, boardYmm + boardHmm);
      }
      for (const o of placements) {
        if (opts.exclude.has(o.id)) continue;
        vts.push(o.xMm, o.xMm + o.wMm / 2, o.xMm + o.wMm);
        hts.push(o.yMm, o.yMm + o.hMm / 2, o.yMm + o.hMm);
      }

      const g: number[][] = [];
      let bestX: { d: number; nx: number; t: number } | null = null;
      for (const a of [0, w / 2, w]) {
        for (const t of vts) {
          const d = Math.abs(nx + a - t);
          if (d < thr && (!bestX || d < bestX.d)) bestX = { d, nx: t - a, t };
        }
      }
      if (bestX) {
        nx = bestX.nx;
        g.push([bestX.t, 0, bestX.t, SCREEN_H_MM]);
      }
      let bestY: { d: number; ny: number; t: number } | null = null;
      for (const a of [0, h / 2, h]) {
        for (const t of hts) {
          const d = Math.abs(ny + a - t);
          if (d < thr && (!bestY || d < bestY.d)) bestY = { d, ny: t - a, t };
        }
      }
      if (bestY) {
        ny = bestY.ny;
        g.push([0, bestY.t, SCREEN_W_MM, bestY.t]);
      }
      node.x(nx);
      node.y(ny);
      setGuides(g);
    },
    [fit, boardXmm, boardYmm, boardWmm, boardHmm, placements],
  );

  // Click selects one; Shift/⌘ toggles. Clicking an already-selected item keeps
  // the selection so the whole group can be dragged.
  const onPick = useCallback(
    (p: Placement, additive: boolean) => {
      if (additive) select(p.id, true);
      else if (!selectedSet.has(p.id)) select(p.id, false);
    },
    [select, selectedSet],
  );

  // Capture the moving set (the selection if the grabbed item is part of it,
  // else just that item) and their start positions for a group drag.
  const startDrag = useCallback(
    (p: Placement, node: Konva.Node) => {
      const ids = selectedSet.has(p.id) && selectedSet.size > 1 ? selectedSet : new Set([p.id]);
      dragRef.current = {
        sx: node.x(),
        sy: node.y(),
        items: placements.filter((pp) => ids.has(pp.id)).map((pp) => ({ id: pp.id, x0: pp.xMm, y0: pp.yMm })),
      };
    },
    [placements, selectedSet],
  );

  const moveDrag = useCallback(
    (p: Placement, node: Konva.Node) => {
      const d = dragRef.current;
      const exclude = new Set(d ? d.items.map((it) => it.id) : [p.id]);
      snapBox(node, p.wMm, p.hMm, { board: true, exclude });
      if (!d) return;
      const dx = node.x() - d.sx;
      const dy = node.y() - d.sy;
      const others = d.items
        .filter((it) => it.id !== p.id)
        .map((it) => ({ id: it.id, xMm: it.x0 + dx, yMm: it.y0 + dy }));
      if (others.length) moveMany(others);
    },
    [snapBox, moveMany],
  );

  const endDrag = useCallback(
    (p: Placement, node: Konva.Node) => {
      move(p.id, node.x(), node.y());
      dragRef.current = null;
      setGuides([]);
    },
    [move],
  );

  // Marquee selection (KiCad-style): left-drag empty bed in Select mode draws a
  // rubber band; placements ≥85% inside are selected (Shift to add).
  const groupPoint = () => groupRef.current?.getRelativePointerPosition() ?? null;
  const onStageDown = (e: KonvaEventObject<MouseEvent>) => {
    if (panMode) return; // stage handles panning (draggable)
    const t = e.target;
    const onBed = t === t.getStage() || t.name() === "bed";
    if (!onBed) return; // placements / board run their own handlers
    const pt = groupPoint();
    if (!pt) return;
    marqueeRef.current = { x0: pt.x, y0: pt.y, additive: e.evt.shiftKey || e.evt.metaKey };
    setMarquee({ x: pt.x, y: pt.y, w: 0, h: 0 });
  };
  const onStageMove = () => {
    const m = marqueeRef.current;
    const pt = groupPoint();
    if (!m || !pt) return;
    setMarquee({
      x: Math.min(m.x0, pt.x),
      y: Math.min(m.y0, pt.y),
      w: Math.abs(pt.x - m.x0),
      h: Math.abs(pt.y - m.y0),
    });
  };
  const onStageUp = () => {
    const m = marqueeRef.current;
    const rect = marquee;
    marqueeRef.current = null;
    setMarquee(null);
    if (!m) return;
    if (!rect || rect.w < 0.5 || rect.h < 0.5) {
      if (!m.additive) select(null); // a click on empty space clears
      return;
    }
    const ids = placements
      .filter((p) => {
        const ox = Math.max(0, Math.min(p.xMm + p.wMm, rect.x + rect.w) - Math.max(p.xMm, rect.x));
        const oy = Math.max(0, Math.min(p.yMm + p.hMm, rect.y + rect.h) - Math.max(p.yMm, rect.y));
        return (ox * oy) / (p.wMm * p.hMm) >= 0.85;
      })
      .map((p) => p.id);
    selectMany(ids, m.additive);
  };

  // Keep the screen on-canvas while dragging-to-pan, and force the grabbing cursor.
  const dragBound = (pos: { x: number; y: number }) => {
    const stage = stageRef.current;
    return clampPos(pos.x, pos.y, stage ? stage.scaleX() : 1);
  };
  const setCursor = (c: string) => {
    const el = containerRef.current;
    if (el) el.style.cursor = c;
  };

  return (
    <div
      ref={containerRef}
      className={`relative h-full w-full overflow-hidden bg-[#0a0c10] ${panMode ? "cursor-grab" : "cursor-crosshair"}`}
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
        onMouseDown={onStageDown}
        onMouseMove={onStageMove}
        onMouseUp={onStageUp}
      >
        <Layer>
          {/* mm-space group; global mirror flips the whole sheet horizontally */}
          <Group
            ref={groupRef}
            x={mirror ? SCREEN_W_MM * fit : 0}
            y={0}
            scaleX={mirror ? -fit : fit}
            scaleY={fit}
          >
            {/* exposure screen (the bed) */}
            <Rect
              name="bed"
              x={0}
              y={0}
              width={SCREEN_W_MM}
              height={SCREEN_H_MM}
              fill="#101317"
              stroke="#2b313c"
              strokeWidth={1}
              strokeScaleEnabled={false}
              cornerRadius={0.5}
            />
            <CadGrid widthMm={SCREEN_W_MM} heightMm={SCREEN_H_MM} />
            {/* copper board reference frame — non-interactive (position via the
                X/Y fields); listening off so clicks fall through to the bed */}
            <Rect
              x={boardXmm}
              y={boardYmm}
              width={boardWmm}
              height={boardHmm}
              fill="rgba(184,115,51,0.06)"
              stroke="#b87333"
              strokeWidth={1.25}
              strokeScaleEnabled={false}
              dash={[3, 2]}
              listening={false}
            />
            {placements.map((p) => (
              <GerberImage
                key={p.id}
                p={p}
                selected={selectedSet.has(p.id)}
                invert={invert}
                onPick={onPick}
                onDragStart={startDrag}
                onDragMove={moveDrag}
                onDragEnd={endDrag}
              />
            ))}
            {/* alignment guides */}
            {guides.map((pts, i) => (
              <Line
                key={i}
                points={pts}
                stroke="#3ec6ff"
                strokeWidth={1}
                strokeScaleEnabled={false}
                dash={[3, 3]}
                listening={false}
              />
            ))}
            {/* marquee selection rubber band */}
            {marquee && (
              <Rect
                x={marquee.x}
                y={marquee.y}
                width={marquee.w}
                height={marquee.h}
                fill="rgba(62,198,255,0.12)"
                stroke="#3ec6ff"
                strokeWidth={1}
                strokeScaleEnabled={false}
                listening={false}
              />
            )}
          </Group>
        </Layer>
      </Stage>

      <CanvasToolbar />

      {previewLoading && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/20">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      )}

      <div className="absolute bottom-2 left-2 cursor-default rounded bg-card/80 px-2 py-1 text-[11px] text-muted-foreground">
        screen {SCREEN_W_MM}×{SCREEN_H_MM} mm · drag to select · Space/H pans · scroll zooms
      </div>

      {/* viewer zoom controls */}
      <div className="absolute bottom-2 right-2 flex cursor-default items-center gap-0.5 rounded-md border border-border bg-card/90 p-0.5 text-muted-foreground [&_button]:cursor-pointer">
        <button className="rounded p-1 hover:bg-muted/60" title="Zoom out" onClick={() => zoomButton(1 / 1.2)}>
          <Minus className="size-4" />
        </button>
        <button
          className="min-w-12 rounded px-1.5 py-1 text-center text-[11px] tabular-nums hover:bg-muted/60"
          title="Reset / fit"
          onClick={fitView}
        >
          {zoomPct}%
        </button>
        <button className="rounded p-1 hover:bg-muted/60" title="Zoom in" onClick={() => zoomButton(1.2)}>
          <Plus className="size-4" />
        </button>
        <button className="rounded p-1 hover:bg-muted/60" title="Fit to screen" onClick={fitView}>
          <Maximize className="size-4" />
        </button>
      </div>
    </div>
  );
}

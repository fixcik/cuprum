import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Crosshair, Loader2, LocateFixed, Maximize, Minus, Plus, Ruler } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BBox, Hole, LayerType } from "@/lib/api";
import { LAYER_Z } from "@/lib/layerColors";
import { outlineLoops, outlinePathD } from "@/lib/boardOutline";
import { DrcMarkers, type DrcMarkerInput, type ProjectedMarker } from "@/components/preview/DrcMarkers";
import { RulersOverlay, type Viewport } from "@/components/editor/RulersOverlay";
import { gridSteps, ticksFor } from "@/lib/canvasTicks";
import { useShell } from "@/shellStore";
import { useUnitFormat } from "@/i18n/useUnitFormat";

/** Programmatic view focus: centre board point `p`, zoomed so ~`spanMm` fits the
 *  pane width (context around the spot). `nonce` lets re-clicking re-centre. */
export interface FocusTarget {
  p: [number, number];
  spanMm: number;
  nonce: number;
}

export interface StackLayer {
  key: string;
  svgBody: string;
  bbox: BBox;
  color: string;
  visible: boolean;
  type: LayerType;
  snap: [number, number][];
}

const MIN_SCALE = 0.05;
const MAX_ZOOM = 150; // cap at 15000% of real size (maxScale = pxPerMm * MAX_ZOOM)
// "Fit all" / first-frame / thumbnail framing leaves a small gap so the board
// never sits flush against the rulers/edges.
const FIT_MARGIN = 0.9;
const RULER = 20; // px — width/height of the edge rulers
// Measure overlay — a copper core (--primary) over a dark casing, so the line
// and reticles stay legible over any PCB colour (green mask, white silk, gold
// pads, black holes) instead of washing out as a single flat tint. All widths
// and radii are SCREEN px (constant under zoom); endpoints live in board mm.
const M_CORE = "hsl(var(--primary))"; // copper accent
const M_CASE = "rgba(0,0,0,0.6)"; // dark halo/casing under the copper
const M_LINE_CASE = 5; // measure line — casing width
const M_LINE_CORE = 2; // measure line — copper width
const M_LEG_CORE = 1.5; // ΔX/ΔY leg — copper width
const M_LEG_CASE = 3.5; // ΔX/ΔY leg — casing width
const M_RING_R = 10; // reticle ring radius
const M_RING_CASE = 5; // reticle ring — casing width
const M_RING_CORE = 2; // reticle ring — copper width
const M_CROSS_ARM = 16; // crosshair half-arm length (32px tip-to-tip)
const M_CROSS_CASE = 4; // crosshair — casing width
const M_CROSS_CORE = 1.5; // crosshair — copper width
const M_DOT_R = 2.5; // centre dot radius
const M_FEATURE_R = 15; // dashed lock ring shown when snapped to a feature
const MEASURE_LABEL_BG = "hsl(222 16% 9% / 0.92)";
const MEASURE_LABEL_FG = "rgba(255,255,255,0.95)";
const MEASURE_LABEL_SUB = "rgba(255,255,255,0.6)";
// Tick/grid step math (ladder, nice-step selection) lives in `lib/canvasTicks`,
// shared with the panel canvas so a ruler label and a grid line always coincide.

/** Union of ALL layer bboxes — ignores visibility, so toggling never moves the camera. */
function fullBBox(layers: StackLayer[]): BBox | null {
  if (layers.length === 0) return null;
  return layers.reduce<BBox>(
    (a, l) => ({
      minX: Math.min(a.minX, l.bbox.minX),
      minY: Math.min(a.minY, l.bbox.minY),
      maxX: Math.max(a.maxX, l.bbox.maxX),
      maxY: Math.max(a.maxY, l.bbox.maxY),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
}

interface View {
  s: number; // px per mm
  tx: number; // screen px
  ty: number; // screen px
}

/** A placed measurement endpoint: gerber-mm position + whether it locked onto a
 *  real feature (hole/pad/board node), which drives the dashed lock ring. */
interface MPoint {
  g: [number, number];
  feature: boolean;
}

/** Halve every `stroke-width` and cap `r` in an SVG fragment — used to render
 *  the Edge_Cuts outline at half its gerber width. */
function halveStrokeWidth(svg: string): string {
  return svg
    .replace(/stroke-width="([\d.]+)"/g, (_, w) => `stroke-width="${parseFloat(w) / 2}"`)
    .replace(/\br="([\d.]+)"/g, (_, r) => `r="${parseFloat(r) / 2}"`);
}

/**
 * Composite SVG viewer. Layers are drawn in millimetres (gerber Y-up); a single
 * screen-space transform `translate(tx,ty) scale(s)` (s = px/mm) places them, so
 * panning is 1:1 with the cursor and zoom homes on the pointer — same UX as the
 * exposure editor's canvas. A 10mm grid and edge rulers (mm from the board
 * corner) track the view.
 */
export function LayerStack({
  layers,
  holes = [],
  side,
  mirror = false,
  onScale,
  markers = [],
  focusTarget = null,
  chrome = true,
  loading = false,
}: {
  layers: StackLayer[];
  holes?: Hole[];
  side: "top" | "bottom";
  /** The "mirror" toggle for the bottom view (no effect on top). Gerber bottom
   *  layers are authored mirrored, so by default we flip the bottom across X to
   *  read correctly — a real back-of-board view that matches the 3D bottom. Turn
   *  this ON to drop that flip: a see-through view whose X positions line up with
   *  the top (text then reads reversed). */
  mirror?: boolean;
  /** Report the current px/mm scale so the 3D view can open at the same scale. */
  onScale?: (pxPerMm: number) => void;
  /** DRC dimension markers (board mm) to overlay. */
  markers?: DrcMarkerInput[];
  /** When set, centre+zoom the view on this board point. */
  focusTarget?: FocusTarget | null;
  /** Interactive chrome (rulers, zoom toolbar, board-size badge, pan/zoom). When
   *  false the viewer is a static, fit-to-board thumbnail with none of that. */
  chrome?: boolean;
  /** Show a centered spinner instead of the empty-state text while layers load. */
  loading?: boolean;
}) {
  const { t } = useTranslation("import");
  const { fmtLen } = useUnitFormat();

  // True CSS px/mm for the host display — fetched once at launch in App.tsx.
  // Falls back to the 96dpi CSS reference if the native query fails.
  const pxPerMm = useShell((s) => s.pxPerMm);
  const maxScale = pxPerMm * MAX_ZOOM; // upper zoom clamp, in px/mm (= 8000%)

  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const roRef = useRef<ResizeObserver | null>(null);
  // Callback ref: attach the ResizeObserver to whichever container mounts — the
  // empty-state div OR the real viewer. A mount-only effect missed the case where
  // layers arrive after mount (the empty div had no ref), leaving size at 0 and
  // the board unframed until a remount (toggling 2D/3D) re-attached it.
  const setContainer = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    if (el) {
      const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
      ro.observe(el);
      setSize({ w: el.clientWidth, h: el.clientHeight });
      roRef.current = ro;
    }
  }, []);

  const box = useMemo(() => fullBBox(layers), [layers]);
  const w = box ? Math.max(box.maxX - box.minX, 1e-3) : 1;
  const h = box ? Math.max(box.maxY - box.minY, 1e-3) : 1;

  const [view, setView] = useState<View>({ s: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;

  // Surface the live px/mm scale so 3D can match it exactly.
  useEffect(() => {
    onScale?.(view.s);
  }, [view.s, onScale]);

  const [tool, setTool] = useState<"pan" | "measure">("pan");
  // Measurement endpoints in gerber mm; `a` set on first click, `b` on second.
  // `feature` marks a point snapped to a real feature (hole/pad/board node) →
  // shown with the dashed lock ring, vs a free/grid point.
  const [mA, setMA] = useState<MPoint | null>(null);
  const [mB, setMB] = useState<MPoint | null>(null);
  const [hover, setHover] = useState<{ g: [number, number]; feature: boolean } | null>(null);
  // Opt-in hover crosshair + coordinate readout (off by default — the preview
  // already has the click-to-measure tool, so an always-on crosshair is busy).
  const [showCrosshair, setShowCrosshair] = useState(false);
  // Cursor in screen px for that crosshair; coalesced to one update per frame so a
  // bare mousemove doesn't re-render the whole layer stack.
  const [cursorPx, setCursorPx] = useState<{ x: number; y: number } | null>(null);
  const cursorRaf = useRef<number | null>(null);
  const pendingCursor = useRef<{ x: number; y: number } | null>(null);
  const queueCursor = useCallback((p: { x: number; y: number } | null) => {
    pendingCursor.current = p;
    if (p === null) {
      if (cursorRaf.current != null) {
        cancelAnimationFrame(cursorRaf.current);
        cursorRaf.current = null;
      }
      setCursorPx(null);
      return;
    }
    if (cursorRaf.current != null) return;
    cursorRaf.current = requestAnimationFrame(() => {
      cursorRaf.current = null;
      setCursorPx(pendingCursor.current);
    });
  }, []);
  useEffect(() => () => { if (cursorRaf.current != null) cancelAnimationFrame(cursorRaf.current); }, []);

  // Space reserved for the edge rulers; zero in chrome-less thumbnail mode so the
  // board centres in the whole pane.
  const rPad = chrome ? RULER : 0;

  // Fit/centre into the area NOT covered by the rulers (offset by rPad on the
  // top and left edges), so the board never hides under them.
  const fitScale = useCallback(() => {
    if (!box || size.w === 0 || size.h === 0) return 1;
    return Math.min((size.w - rPad) / w, (size.h - rPad) / h);
  }, [box, size.w, size.h, w, h, rPad]);

  const frameAt = useCallback(
    (scale: number) => {
      if (!box) return;
      const s = Math.min(maxScale, Math.max(MIN_SCALE, scale));
      setView({
        s,
        tx: (size.w + rPad - s * w) / 2 - s * box.minX,
        ty: (size.h + rPad - s * h) / 2 - s * box.minY,
      });
    },
    [box, size.w, size.h, w, h, maxScale, rPad],
  );

  // Frame at the default fill when the board extent or pane size changes — keyed
  // on box dims (not visibility), so toggling layers leaves the view put.
  const frameKey = box ? `${box.minX}:${box.minY}:${w}:${h}:${size.w}:${size.h}` : "";
  const framed = useRef("");
  useEffect(() => {
    if (!box || size.w === 0) return;
    if (framed.current === frameKey) return;
    framed.current = frameKey;
    // Open framed to (nearly) fill the pane — same fit as the "fit all" button.
    frameAt(fitScale() * FIT_MARGIN);
  }, [frameKey, box, size.w, frameAt, fitScale]);

  // Programmatic focus: centre the requested board point at the target scale.
  const focusNonce = useRef(-1);
  useEffect(() => {
    if (!focusTarget || !box || size.w === 0) return;
    if (focusNonce.current === focusTarget.nonce) return;
    focusNonce.current = focusTarget.nonce;
    const want = (size.w - RULER) / Math.max(focusTarget.spanMm, 1e-3);
    const s = Math.min(maxScale, Math.max(MIN_SCALE, want));
    const cx = (size.w + RULER) / 2;
    const cy = (size.h + RULER) / 2;
    const m = box.minY + box.maxY;
    const mxx = box.minX + box.maxX;
    const dx = side === "bottom" && !mirror ? mxx - focusTarget.p[0] : focusTarget.p[0];
    const dy = m - focusTarget.p[1];
    setView({ s, tx: cx - s * dx, ty: cy - s * dy });
  }, [focusTarget, box, size.w, size.h, side, mirror, maxScale]);

  // Wheel = zoom toward the cursor. Native non-passive listener so preventDefault
  // actually stops the page from scrolling (React's onWheel is passive).
  useEffect(() => {
    const el = svgRef.current;
    if (!el || !chrome) return; // thumbnail mode is non-interactive
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const { s, tx, ty } = viewRef.current;
      const ns = Math.min(maxScale, Math.max(MIN_SCALE, s * Math.exp(-e.deltaY * 0.0015)));
      if (ns === s) return;
      const wx = (cx - tx) / s;
      const wy = (cy - ty) / s;
      setView({ s: ns, tx: cx - wx * ns, ty: cy - wy * ns });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // `box` is in the deps so the listener (re)attaches once the <svg> actually
    // mounts: on entering a project the layers load async, so the first pass runs
    // with no <svg> yet (the empty-state div is shown) and svgRef is null.
  }, [maxScale, box, chrome]);

  // Drag to pan — screen px in, screen px out, so it tracks the cursor exactly.
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc backs out of both viewer tools: exit the measure tool (clearing any
      // placed points) and turn the hover crosshair off.
      if (e.key === "Escape") { setTool("pan"); setMA(null); setMB(null); setHover(null); setShowCrosshair(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const zoomButton = (factor: number) => {
    const { s, tx, ty } = viewRef.current;
    const cx = size.w / 2;
    const cy = size.h / 2;
    const ns = Math.min(maxScale, Math.max(MIN_SCALE, s * factor));
    if (ns === s) return;
    const wx = (cx - tx) / s;
    const wy = (cy - ty) / s;
    setView({ s: ns, tx: cx - wx * ns, ty: cy - wy * ns });
  };
  const realSize = () => frameAt(pxPerMm);
  const fitFull = () => frameAt(fitScale() * FIT_MARGIN);
  const centerView = () => frameAt(viewRef.current.s); // recenter, keep zoom

  // Board outline path (gerber mm) for clipping the soldermask/substrate to the
  // real board shape. Kept above the early returns so hook order stays stable.
  const clipId = useId().replace(/:/g, "");
  const edgeLayer = layers.find((l) => l.type === "edgeCuts");
  const boardClipD = useMemo(
    () => (edgeLayer ? outlinePathD(edgeLayer.svgBody) : null),
    [edgeLayer],
  );
  // True board extent = bbox of the Edge_Cuts CENTERLINE (the cut path), NOT the
  // stroked layer bbox — the rendered outline has the gerber stroke width, so its
  // bbox is half a line-width too big on every side. The cut follows the centre.
  const edgeBoxOutline = useMemo(() => {
    if (!edgeLayer) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const loop of outlineLoops(edgeLayer.svgBody)) {
      for (const p of loop) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
    return isFinite(minX) ? { minX, minY, maxX, maxY } : null;
  }, [edgeLayer]);

  // Project DRC markers (board mm → screen px) with the live view transform,
  // memoised so a cursor-only re-render (the hover crosshair tracking the
  // pointer) does NOT rebuild the array. A fresh array forced the heavy DRC
  // overlay (up to ~500 hotspots, incl. per-stroke "line" highlights) to
  // re-rasterize every frame at high zoom — the root of the zoom artifacts.
  const projectedMarkers = useMemo<ProjectedMarker[]>(() => {
    if (!box) return [];
    const mir = side === "bottom" && !mirror;
    const mY = box.minY + box.maxY;
    const mX = box.minX + box.maxX;
    const toScr = (g: [number, number]): [number, number] => {
      const dx = mir ? mX - g[0] : g[0];
      const dy = mY - g[1];
      return [view.tx + view.s * dx, view.ty + view.s * dy];
    };
    return markers.map((m) => {
      const [ax, ay] = toScr(m.a);
      const [bx, by] = toScr(m.b);
      const [mx, my] = toScr([(m.a[0] + m.b[0]) / 2, (m.a[1] + m.b[1]) / 2]);
      return { ...m, ax, ay, bx, by, mx, my, widthPx: m.widthMm != null ? m.widthMm * view.s : undefined };
    });
  }, [markers, box, side, mirror, view.s, view.tx, view.ty]);

  if (!box) {
    return (
      <div
        ref={setContainer}
        className="flex h-full w-full items-center justify-center text-[12px] text-muted-foreground"
      >
        {loading ? (
          <Loader2 className="size-6 animate-spin text-primary" />
        ) : (
          t("viewer.noLayers")
        )}
      </div>
    );
  }

  // Y-flip (gerber is Y-up) within the board extent. The bottom is X-flipped by
  // default so it reads as a real back-of-board view (gerber bottom data is
  // authored mirrored); the "mirror" toggle ON drops that flip → see-through view
  // aligned with the top. `mirrored` = whether the X-flip is applied.
  const mirrored = side === "bottom" && !mirror;
  const flip = mirrored
    ? `translate(${box.minX + box.maxX} ${box.minY + box.maxY}) scale(-1 -1)`
    : `translate(0 ${box.minY + box.maxY}) scale(1 -1)`;

  const mid = box.minY + box.maxY;
  const midx = box.minX + box.maxX;
  const toScreen = (g: [number, number]): [number, number] => {
    const dx = mirrored ? midx - g[0] : g[0];
    const dy = mid - g[1];
    return [view.tx + view.s * dx, view.ty + view.s * dy];
  };
  const toGerber = (px: number, py: number): [number, number] => {
    const dx = (px - view.tx) / view.s;
    const dy = (py - view.ty) / view.s;
    return [mirrored ? midx - dx : dx, mid - dy];
  };

  const pct = Math.round((view.s / pxPerMm) * 100);
  const visible = layers
    .filter((l) => l.visible)
    .slice()
    .sort((a, b) => LAYER_Z[a.type] - LAYER_Z[b.type]);

  // Real board size — the Edge_Cuts centerline extent when present, else the
  // overall extent of all layers.
  const edgeBox = edgeBoxOutline ?? box;
  const boardW = edgeBox.maxX - edgeBox.minX;
  const boardH = edgeBox.maxY - edgeBox.minY;

  // Grid/ruler ticks, anchored at the board's min corner so "0" sits on the edge
  // and aligns with a grid line. Step coarsens (10→50→100…) so lines stay ≥8px
  // apart; every 5th line is "major" (label + brighter).
  const ready = size.w > 0 && size.h > 0 && view.s > 0;
  // Grid step = finest ladder rung still ≥8px on screen (→ 10/5/1/0.5/0.1mm as
  // you zoom in). Labels use a coarser rung with room for the digits, so they
  // appear/multiply as space allows. The label rung is an integer multiple of
  // the grid rung, so labelled lines always coincide with grid lines.
  const { minor: minorStep, labelEvery } = gridSteps(view.s);

  const SNAP_PX = 10;
  // Visible feature snap points (gerber mm).
  const featurePts: [number, number][] = visible.flatMap((l) => l.snap);
  // Board corners + edge midpoints + center (from the Edge_Cuts extent).
  const bx = edgeBox; // computed above for the board-size chip
  const boardPts: [number, number][] = [
    [bx.minX, bx.minY], [bx.maxX, bx.minY], [bx.minX, bx.maxY], [bx.maxX, bx.maxY],
    [(bx.minX + bx.maxX) / 2, bx.minY], [(bx.minX + bx.maxX) / 2, bx.maxY],
    [bx.minX, (bx.minY + bx.maxY) / 2], [bx.maxX, (bx.minY + bx.maxY) / 2],
    [(bx.minX + bx.maxX) / 2, (bx.minY + bx.maxY) / 2],
  ];

  // Snap the cursor (screen px) to the nearest candidate within SNAP_PX, else the
  // nearest grid node, else the raw point. Priority: features > board > grid.
  // `feature` is true only for a real feature/board node (not a grid node) — it
  // gates the dashed lock ring on the reticle.
  const snapCursor = (px: number, py: number): { g: [number, number]; feature: boolean } => {
    const near = (pts: [number, number][]) => {
      let best: [number, number] | null = null;
      let bestD = SNAP_PX;
      for (const g of pts) {
        const [sxp, syp] = toScreen(g);
        const d = Math.hypot(sxp - px, syp - py);
        if (d < bestD) { bestD = d; best = g; }
      }
      return best;
    };
    const f = near(featurePts) ?? near(boardPts);
    if (f) return { g: f, feature: true };
    // grid node: round the gerber point to the current minor grid step, anchored
    // at the board corner; snap only if it lands within SNAP_PX.
    const g0 = toGerber(px, py);
    const gx = box.minX + Math.round((g0[0] - box.minX) / minorStep) * minorStep;
    const gy = box.minY + Math.round((g0[1] - box.minY) / minorStep) * minorStep;
    const [gsx, gsy] = toScreen([gx, gy]);
    if (Math.hypot(gsx - px, gsy - py) < SNAP_PX) return { g: [gx, gy], feature: false };
    return { g: g0, feature: false };
  };

  const onDown = (e: React.MouseEvent) => {
    if (!chrome) return; // thumbnail mode: no pan
    if (tool === "measure") {
      if (e.button !== 0) { setMA(null); setMB(null); return; } // right/middle clears
      const rect = svgRef.current!.getBoundingClientRect();
      const snap = snapCursor(e.clientX - rect.left, e.clientY - rect.top);
      const p: MPoint = { g: snap.g, feature: snap.feature };
      if (!mA || (mA && mB)) { setMA(p); setMB(null); } else { setMB(p); }
      return;
    }
    drag.current = { x: e.clientX, y: e.clientY, tx: viewRef.current.tx, ty: viewRef.current.ty };
  };
  const onMove = (e: React.MouseEvent) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (tool === "measure") {
      if (rect) setHover(snapCursor(e.clientX - rect.left, e.clientY - rect.top));
      return;
    }
    // Track the cursor only when the crosshair is on, so an idle hover doesn't
    // churn state through the whole layer stack when it's off.
    if (chrome && showCrosshair && rect) {
      queueCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    }
    const d = drag.current;
    if (!d) return;
    setView((v) => ({ ...v, tx: d.tx + (e.clientX - d.x), ty: d.ty + (e.clientY - d.y) }));
  };
  const onUp = () => { drag.current = null; };

  // Visible content-space bounds (mm).
  const dx0 = (0 - view.tx) / view.s;
  const dx1 = (size.w - view.tx) / view.s;
  const dy0 = (0 - view.ty) / view.s;
  const dy1 = (size.h - view.ty) / view.s;
  // Anchor ruler "0" at the board edge (Edge_Cuts centerline), not the overall
  // content corner — labels read mm from the real board edge.
  const vTicks = ready ? ticksFor(edgeBox.minX, dx0, dx1, minorStep, labelEvery) : [];
  const hTicks = ready ? ticksFor(edgeBox.minY, dy0, dy1, minorStep, labelEvery) : [];

  // Map this canvas's view transform into the shared overlay's descriptor. The
  // rulers/grid use the plain (non-mirrored, non-Y-flipped) `tx + s·mm` mapping,
  // anchored at the board edge — the `mid/midx` pivot already lands the anchored
  // ticks on the board's visual extent on both sides. So a single increasing axis
  // matches the existing grid exactly.
  const rulerViewport: Viewport | null = ready
    ? { pxPerMm: view.s, originX: view.tx, originY: view.ty }
    : null;

  return (
    <div ref={setContainer} className="relative h-full w-full overflow-hidden bg-pcb-preview">
      <svg
        ref={svgRef}
        className={`h-full w-full ${!chrome ? "cursor-pointer" : tool === "measure" ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`}
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onMouseLeave={() => { onUp(); queueCursor(null); }}
        onContextMenu={(e) => { if (tool === "measure") { e.preventDefault(); setMA(null); setMB(null); } }}
      >
        <g transform={`translate(${view.tx} ${view.ty}) scale(${view.s})`}>
          {/* 10mm grid (mm space; non-scaling stroke keeps it ~1px at any zoom) */}
          <g style={{ pointerEvents: "none" }}>
            {vTicks.map((t) => (
              <line
                key={`gv${t.mm}`}
                x1={t.mm}
                y1={dy0}
                x2={t.mm}
                y2={dy1}
                vectorEffect="non-scaling-stroke"
                style={{ stroke: `hsl(var(--foreground) / ${t.major ? 0.1 : 0.05})` }}
                strokeWidth={1}
              />
            ))}
            {hTicks.map((t) => (
              <line
                key={`gh${t.mm}`}
                x1={dx0}
                y1={t.mm}
                x2={dx1}
                y2={t.mm}
                vectorEffect="non-scaling-stroke"
                style={{ stroke: `hsl(var(--foreground) / ${t.major ? 0.1 : 0.05})` }}
                strokeWidth={1}
              />
            ))}
          </g>
          <g transform={flip}>
            {/* Board-shaped clip (follows the rounded Edge_Cuts outline) so the
                substrate fill and the soldermask don't spill past the real edge. */}
            {boardClipD && (
              <defs>
                <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
                  <path d={boardClipD} fillRule="evenodd" />
                </clipPath>
              </defs>
            )}
            {/* Opaque FR4 substrate (bare fiberglass tan) clipped to the board
                shape — so the board reads as a solid object, matching the 3D
                substrate, instead of a see-through outline. */}
            <rect
              x={box.minX}
              y={box.minY}
              width={w}
              height={h}
              fill="#59512c"
              clipPath={boardClipD ? `url(#${clipId})` : undefined}
            />
            {visible.map((l) => {
              const isMask = l.type === "topMask" || l.type === "bottomMask";
              if (!isMask) {
                // Copper/silk/edge are drawn UNCLIPPED. The board already reads as
                // rounded via the clipped substrate + soldermask above; these
                // line/geometry layers don't visibly spill past the edge, so they
                // need no clip here. Clipping them is also harmful: under the zoom
                // `scale()` transform a clip-path makes WebKit (Tauri's WKWebView)
                // rasterize the group into a PRE-scale offscreen buffer, so thin
                // strokes (silk text, traces) collapse to sub-pixel and the zoom
                // magnifies them into broken "beads". The card-preview composite
                // does its own outline clip separately (cuprum-core/src/preview.rs).
                // Edge cuts render at half the gerber stroke width (thin cut line).
                const isEdge = l.type === "edgeCuts";
                const body = isEdge ? halveStrokeWidth(l.svgBody) : l.svgBody;
                return (
                  <g
                    key={l.key}
                    style={{ color: l.color }}
                    dangerouslySetInnerHTML={{ __html: body }}
                  />
                );
              }
              // Inverted mask: layer colour over the whole board, openings cut out.
              const maskId = `mask-open-${l.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
              return (
                <g key={l.key} style={{ color: l.color }}>
                  <mask id={maskId} maskUnits="userSpaceOnUse" x={edgeBox.minX} y={edgeBox.minY} width={edgeBox.maxX - edgeBox.minX} height={edgeBox.maxY - edgeBox.minY}>
                    <rect x={edgeBox.minX} y={edgeBox.minY} width={edgeBox.maxX - edgeBox.minX} height={edgeBox.maxY - edgeBox.minY} fill="#fff" />
                    {/* openings → black (currentColor=#000 here) so they're cut from the coverage */}
                    <g style={{ color: "#000" }} dangerouslySetInnerHTML={{ __html: l.svgBody }} />
                  </mask>
                  <rect
                    x={edgeBox.minX}
                    y={edgeBox.minY}
                    width={edgeBox.maxX - edgeBox.minX}
                    height={edgeBox.maxY - edgeBox.minY}
                    fill="currentColor"
                    fillOpacity={0.82}
                    mask={`url(#${maskId})`}
                    clipPath={boardClipD ? `url(#${clipId})` : undefined}
                  />
                </g>
              );
            })}
            {/* Drill holes: filled with the preview background colour so they read
                as bored through the board (drawn on top of all layers). */}
            {holes.map((hh, i) =>
              hh.d > 0 ? (
                <circle key={`hole${i}`} cx={hh.x} cy={hh.y} r={hh.d / 2} fill="hsl(var(--pcb-preview))" />
              ) : null,
            )}
          </g>
        </g>

        {tool === "measure" && (() => {
          // A snap reticle: dark casing under a copper core, all in screen px so it
          // stays crisp at any zoom. A dashed lock ring marks a feature snap.
          const reticle = (cx: number, cy: number, feature: boolean, key: string) => (
            <g key={key} transform={`translate(${cx} ${cy})`}>
              {feature && (
                <circle r={M_FEATURE_R} fill="none" stroke={M_CORE} strokeWidth={1.25} strokeDasharray="3 3" opacity={0.9} />
              )}
              <circle r={M_RING_R} fill="none" stroke={M_CASE} strokeWidth={M_RING_CASE} />
              <circle r={M_RING_R} fill="none" stroke={M_CORE} strokeWidth={M_RING_CORE} />
              <g stroke={M_CASE} strokeWidth={M_CROSS_CASE} strokeLinecap="round">
                <line x1={-M_CROSS_ARM} y1={0} x2={M_CROSS_ARM} y2={0} />
                <line x1={0} y1={-M_CROSS_ARM} x2={0} y2={M_CROSS_ARM} />
              </g>
              <g stroke={M_CORE} strokeWidth={M_CROSS_CORE} strokeLinecap="round">
                <line x1={-M_CROSS_ARM} y1={0} x2={M_CROSS_ARM} y2={0} />
                <line x1={0} y1={-M_CROSS_ARM} x2={0} y2={M_CROSS_ARM} />
              </g>
              <circle r={M_DOT_R} fill={M_CORE} stroke={M_CASE} strokeWidth={1.5} />
            </g>
          );

          // `mA` is the placed start; while picking the end, `hover` is the live
          // second point. Once both are placed, `hover` is the prospective NEXT
          // start (shown faint so you can see where a new measure would begin).
          const measuring = !!mA && !mB;
          const liveB: MPoint | null = mB ?? (measuring && hover ? { g: hover.g, feature: hover.feature } : null);
          const aS = mA ? toScreen(mA.g) : null;
          const bS = liveB ? toScreen(liveB.g) : null;
          const dxmm = mA && liveB ? liveB.g[0] - mA.g[0] : 0;
          const dymm = mA && liveB ? liveB.g[1] - mA.g[1] : 0;
          const dist = Math.hypot(dxmm, dymm);
          const showStartHover = hover && !measuring; // hover = next start point

          const labelW = 118;
          const labelH = 34;
          const labelOffX = 12;
          const labelOffY = -labelH - 8;
          let labelX = bS ? bS[0] + labelOffX : 0;
          let labelY = bS ? bS[1] + labelOffY : 0;
          if (bS) {
            if (labelX + labelW > size.w - 4) labelX = bS[0] - labelW - labelOffX;
            if (labelY < 4) labelY = bS[1] + 12;
          }
          // ΔX/ΔY legs: catheti of the right triangle A → (Bx,Ay) → B, in screen px.
          const legPts = aS && bS ? `${aS[0]},${aS[1]} ${bS[0]},${aS[1]} ${bS[0]},${bS[1]}` : "";
          return (
            <g style={{ pointerEvents: "none" }}>
              {/* Faint board scrim while measuring, so the overlay lifts off the art. */}
              <rect x={0} y={0} width={size.w} height={size.h} fill="rgba(0,0,0,0.07)" />
              {aS && bS && (
                <g fill="none" strokeLinecap="round" opacity={0.85}>
                  <polyline points={legPts} stroke={M_CASE} strokeWidth={M_LEG_CASE} strokeDasharray="6 5" />
                  <polyline points={legPts} stroke={M_CORE} strokeWidth={M_LEG_CORE} strokeDasharray="6 5" />
                </g>
              )}
              {aS && bS && (
                <>
                  <line x1={aS[0]} y1={aS[1]} x2={bS[0]} y2={bS[1]} stroke={M_CASE} strokeWidth={M_LINE_CASE} strokeLinecap="round" />
                  <line x1={aS[0]} y1={aS[1]} x2={bS[0]} y2={bS[1]} stroke={M_CORE} strokeWidth={M_LINE_CORE} strokeLinecap="round" />
                </>
              )}
              {aS && mA && reticle(aS[0], aS[1], mA.feature, "a")}
              {bS && liveB && reticle(bS[0], bS[1], liveB.feature, "b")}
              {showStartHover && (() => {
                const [hx, hy] = toScreen(hover.g);
                // Prospective NEXT start — faint, so it reads as a hint, not a
                // placed endpoint (avoids three equal reticles after a measure).
                return <g opacity={0.5}>{reticle(hx, hy, hover.feature, "hover")}</g>;
              })()}
              {aS && bS && (
                <g transform={`translate(${labelX} ${labelY})`}>
                  <rect x={0} y={0} width={labelW} height={labelH} rx={6} style={{ fill: MEASURE_LABEL_BG, stroke: "hsl(var(--border))" }} />
                  <text x={8} y={14} style={{ fill: MEASURE_LABEL_FG, fontSize: "11px", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                    {fmtLen(dist)}
                  </text>
                  <text x={8} y={27} style={{ fill: MEASURE_LABEL_SUB, fontSize: "9px", fontVariantNumeric: "tabular-nums" }}>
                    ΔX {fmtLen(dxmm)} · ΔY {fmtLen(dymm)}
                  </text>
                </g>
              )}
            </g>
          );
        })()}

      </svg>

      <DrcMarkers markers={projectedMarkers} width={size.w} height={size.h} pad={rPad} />

      {/* Edge rulers + grid alignment + optional hover crosshair — shared
          screen-space overlay (same component as the panel canvas). Sits above the
          board/markers; the hover crosshair is hidden while measuring. */}
      {chrome && rulerViewport && (
        <RulersOverlay
          viewport={rulerViewport}
          size={size}
          fmt={fmtLen}
          anchorMm={{ x: edgeBox.minX, y: edgeBox.minY }}
          extentMm={{ x: edgeBox.minX, y: edgeBox.minY, w: boardW, h: boardH }}
          hover={showCrosshair && tool !== "measure" ? cursorPx : null}
          rulerTop={RULER}
          rulerLeft={RULER}
          extentVariant="muted"
        />
      )}

      {chrome && (
        <div
          className="absolute right-2 top-[26px] rounded-md border border-border bg-card/90 px-2 py-1 text-[11px] tabular-nums text-muted-foreground"
          title={t("viewer.boardSize")}
        >
          {fmtLen(boardW)} × {fmtLen(boardH)}
        </div>
      )}

      {chrome && (
      <div className="absolute bottom-2 right-2 flex items-center gap-0.5 rounded-md border border-border bg-card/90 p-0.5 text-muted-foreground">
        <button
          className={`cursor-pointer rounded p-1 hover:bg-muted/60 ${tool === "measure" ? "bg-primary/20 text-primary" : ""}`}
          title={t("viewer.ruler")}
          onClick={() => {
            // Ruler and crosshair are mutually exclusive: turning the ruler on
            // turns the crosshair off (and vice-versa, below).
            const next = tool === "measure" ? "pan" : "measure";
            setTool(next);
            if (next === "measure") setShowCrosshair(false);
            setMA(null); setMB(null); setHover(null);
          }}
        >
          <Ruler className="size-4" />
        </button>
        <button
          className={`cursor-pointer rounded p-1 hover:bg-muted/60 ${showCrosshair ? "bg-primary/20 text-primary" : ""}`}
          title={t("viewer.crosshair")}
          onClick={() => {
            const next = !showCrosshair;
            setShowCrosshair(next);
            // Turning the crosshair on backs out of the ruler (mutually exclusive).
            if (next && tool === "measure") { setTool("pan"); setMA(null); setMB(null); setHover(null); }
          }}
        >
          <LocateFixed className="size-4" />
        </button>
        <button
          className="cursor-pointer rounded p-1 hover:bg-muted/60"
          title={t("viewer.zoomOut")}
          onClick={() => zoomButton(1 / 1.2)}
        >
          <Minus className="size-4" />
        </button>
        <button
          className="min-w-12 cursor-pointer rounded px-1.5 py-1 text-center text-[11px] tabular-nums hover:bg-muted/60"
          title={t("viewer.realSize")}
          onClick={realSize}
        >
          {pct}%
        </button>
        <button
          className="cursor-pointer rounded p-1 hover:bg-muted/60"
          title={t("viewer.zoomIn")}
          onClick={() => zoomButton(1.2)}
        >
          <Plus className="size-4" />
        </button>
        <button
          className="cursor-pointer rounded p-1 hover:bg-muted/60"
          title={t("viewer.center")}
          onClick={centerView}
        >
          <Crosshair className="size-4" />
        </button>
        <button
          className="cursor-pointer rounded p-1 hover:bg-muted/60"
          title={t("viewer.fitAll")}
          onClick={fitFull}
        >
          <Maximize className="size-4" />
        </button>
      </div>
      )}
    </div>
  );
}

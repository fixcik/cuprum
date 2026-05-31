import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Crosshair, Maximize, Minus, Plus, Ruler } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BBox, Hole, LayerType } from "@/lib/api";
import { LAYER_Z } from "@/lib/layerColors";
import { outlineLoops, outlinePathD } from "@/lib/boardOutline";
import { DrcMarkers, type DrcMarkerInput, type ProjectedMarker } from "@/components/preview/DrcMarkers";
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
const DEFAULT_FILL = 0.5; // board fills ~50% of the pane on first frame
const RULER = 20; // px — width/height of the edge rulers
/** Measure tool accent — white, readable on the green PCB preview. */
const MEASURE = "rgba(255,255,255,0.92)";
const MEASURE_DIM = "rgba(255,255,255,0.65)";
const MEASURE_RING = "rgba(255,255,255,0.35)";
const MEASURE_LABEL_BG = "hsl(222 16% 9% / 0.88)";
const MEASURE_STROKE = 2;
const MEASURE_DOT_R = 4;
const MEASURE_RING_R = 8;
const MEASURE_CROSSHAIR_ARM = 8;
// "1-5" nice-number ladder (mm). The grid step is the finest rung still ≥8px on
// screen, so zooming in reveals 10→5→1→0.5→0.1mm; labels use a coarser rung that
// leaves room for the text.
const STEP_LADDER = [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100, 500, 1000, 5000];

/** Format a mm value compactly: 0.5, 12.5, 50 (no trailing zeros). */
function fmtMm(v: number): string {
  if (Math.abs(v) < 1e-9) return "0";
  return parseFloat(v.toFixed(3)).toString();
}

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

/** Halve every `stroke-width` and cap `r` in an SVG fragment — used to render
 *  the Edge_Cuts outline at half its gerber width. */
function halveStrokeWidth(svg: string): string {
  return svg
    .replace(/stroke-width="([\d.]+)"/g, (_, w) => `stroke-width="${parseFloat(w) / 2}"`)
    .replace(/\br="([\d.]+)"/g, (_, r) => `r="${parseFloat(r) / 2}"`);
}

/** Grid/ruler tick: distance in mm from the board's origin corner, plus whether
 *  it's a major (every 5th) line. */
interface Tick {
  mm: number; // coordinate in the content's mm space
  label: number; // mm from the board corner (0 at the edge)
  major: boolean;
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
  onScale,
  markers = [],
  focusTarget = null,
}: {
  layers: StackLayer[];
  holes?: Hole[];
  side: "top" | "bottom";
  /** Report the current px/mm scale so the 3D view can open at the same scale. */
  onScale?: (pxPerMm: number) => void;
  /** DRC dimension markers (board mm) to overlay. */
  markers?: DrcMarkerInput[];
  /** When set, centre+zoom the view on this board point. */
  focusTarget?: FocusTarget | null;
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
  const [mA, setMA] = useState<[number, number] | null>(null);
  const [mB, setMB] = useState<[number, number] | null>(null);
  const [hover, setHover] = useState<{ g: [number, number]; snapped: boolean } | null>(null);

  // Fit/centre into the area NOT covered by the rulers (offset by RULER on the
  // top and left edges), so the board never hides under them.
  const fitScale = useCallback(() => {
    if (!box || size.w === 0 || size.h === 0) return 1;
    return Math.min((size.w - RULER) / w, (size.h - RULER) / h);
  }, [box, size.w, size.h, w, h]);

  const frameAt = useCallback(
    (scale: number) => {
      if (!box) return;
      const s = Math.min(maxScale, Math.max(MIN_SCALE, scale));
      setView({
        s,
        tx: (size.w + RULER - s * w) / 2 - s * box.minX,
        ty: (size.h + RULER - s * h) / 2 - s * box.minY,
      });
    },
    [box, size.w, size.h, w, h, maxScale],
  );

  // Frame at the default fill when the board extent or pane size changes — keyed
  // on box dims (not visibility), so toggling layers leaves the view put.
  const frameKey = box ? `${box.minX}:${box.minY}:${w}:${h}:${size.w}:${size.h}` : "";
  const framed = useRef("");
  useEffect(() => {
    if (!box || size.w === 0) return;
    if (framed.current === frameKey) return;
    framed.current = frameKey;
    frameAt(fitScale() * DEFAULT_FILL);
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
    const dx = side === "bottom" ? mxx - focusTarget.p[0] : focusTarget.p[0];
    const dy = m - focusTarget.p[1];
    setView({ s, tx: cx - s * dx, ty: cy - s * dy });
  }, [focusTarget, box, size.w, size.h, side, maxScale]);

  // Wheel = zoom toward the cursor. Native non-passive listener so preventDefault
  // actually stops the page from scrolling (React's onWheel is passive).
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
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
  }, [maxScale, box]);

  // Drag to pan — screen px in, screen px out, so it tracks the cursor exactly.
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setMA(null); setMB(null); }
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
  const fitFull = () => frameAt(fitScale());
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

  if (!box) {
    return (
      <div
        ref={setContainer}
        className="flex h-full w-full items-center justify-center text-[12px] text-muted-foreground"
      >
        {t("viewer.noLayers")}
      </div>
    );
  }

  // Y-flip (gerber is Y-up) within the board extent; the bottom view also mirrors X.
  const flip =
    side === "bottom"
      ? `translate(${box.minX + box.maxX} ${box.minY + box.maxY}) scale(-1 -1)`
      : `translate(0 ${box.minY + box.maxY}) scale(1 -1)`;

  const mid = box.minY + box.maxY;
  const midx = box.minX + box.maxX;
  const toScreen = (g: [number, number]): [number, number] => {
    const dx = side === "bottom" ? midx - g[0] : g[0];
    const dy = mid - g[1];
    return [view.tx + view.s * dx, view.ty + view.s * dy];
  };
  const toGerber = (px: number, py: number): [number, number] => {
    const dx = (px - view.tx) / view.s;
    const dy = (py - view.ty) / view.s;
    return [side === "bottom" ? midx - dx : dx, mid - dy];
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
  const pickStep = (minPx: number) =>
    STEP_LADDER.find((st) => st * view.s >= minPx) ?? STEP_LADDER[STEP_LADDER.length - 1];
  const minorStep = pickStep(8);

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
  const snapCursor = (px: number, py: number): { g: [number, number]; snapped: boolean } => {
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
    if (f) return { g: f, snapped: true };
    // grid node: round the gerber point to the current minor grid step, anchored
    // at the board corner; snap only if it lands within SNAP_PX.
    const g0 = toGerber(px, py);
    const gx = box.minX + Math.round((g0[0] - box.minX) / minorStep) * minorStep;
    const gy = box.minY + Math.round((g0[1] - box.minY) / minorStep) * minorStep;
    const [gsx, gsy] = toScreen([gx, gy]);
    if (Math.hypot(gsx - px, gsy - py) < SNAP_PX) return { g: [gx, gy], snapped: true };
    return { g: g0, snapped: false };
  };

  const onDown = (e: React.MouseEvent) => {
    if (tool === "measure") {
      if (e.button !== 0) { setMA(null); setMB(null); return; } // right/middle clears
      const rect = svgRef.current!.getBoundingClientRect();
      const snap = snapCursor(e.clientX - rect.left, e.clientY - rect.top);
      if (!mA || (mA && mB)) { setMA(snap.g); setMB(null); } else { setMB(snap.g); }
      return;
    }
    drag.current = { x: e.clientX, y: e.clientY, tx: viewRef.current.tx, ty: viewRef.current.ty };
  };
  const onMove = (e: React.MouseEvent) => {
    if (tool === "measure") {
      const rect = svgRef.current!.getBoundingClientRect();
      setHover(snapCursor(e.clientX - rect.left, e.clientY - rect.top));
      return;
    }
    const d = drag.current;
    if (!d) return;
    setView((v) => ({ ...v, tx: d.tx + (e.clientX - d.x), ty: d.ty + (e.clientY - d.y) }));
  };
  const onUp = () => { drag.current = null; };

  const labelStep = pickStep(44);
  const labelEvery = Math.max(1, Math.round(labelStep / minorStep));
  const ticksFor = (origin: number, lo: number, hi: number): Tick[] => {
    const out: Tick[] = [];
    const kStart = Math.ceil((lo - origin) / minorStep);
    const kEnd = Math.floor((hi - origin) / minorStep);
    if (kEnd - kStart > 2000) return out; // safety: never flood the DOM
    for (let k = kStart; k <= kEnd; k++) {
      out.push({ mm: origin + k * minorStep, label: k * minorStep, major: k % labelEvery === 0 });
    }
    return out;
  };
  // Visible content-space bounds (mm).
  const dx0 = (0 - view.tx) / view.s;
  const dx1 = (size.w - view.tx) / view.s;
  const dy0 = (0 - view.ty) / view.s;
  const dy1 = (size.h - view.ty) / view.s;
  // Anchor ruler "0" at the board edge (Edge_Cuts centerline), not the overall
  // content corner — labels read mm from the real board edge.
  const vTicks = ready ? ticksFor(edgeBox.minX, dx0, dx1) : [];
  const hTicks = ready ? ticksFor(edgeBox.minY, dy0, dy1) : [];
  const sx = (mm: number) => view.tx + view.s * mm;
  const sy = (mm: number) => view.ty + view.s * mm;

  // Project DRC markers (board mm) to screen px using the live view transform.
  const projectedMarkers: ProjectedMarker[] = markers.map((m) => {
    const [ax, ay] = toScreen(m.a);
    const [bx, by] = toScreen(m.b);
    const [mx, my] = toScreen([(m.a[0] + m.b[0]) / 2, (m.a[1] + m.b[1]) / 2]);
    return { ...m, ax, ay, bx, by, mx, my, widthPx: m.widthMm != null ? m.widthMm * view.s : undefined };
  });

  return (
    <div ref={setContainer} className="relative h-full w-full overflow-hidden bg-pcb-preview">
      <svg
        ref={svgRef}
        className={`h-full w-full ${tool === "measure" ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`}
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onMouseLeave={onUp}
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
                  <path d={boardClipD} />
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
                // Edge cuts: render at half the gerber stroke width — a thinner
                // outline that the soldermask overlaps.
                const body = l.type === "edgeCuts" ? halveStrokeWidth(l.svgBody) : l.svgBody;
                return (
                  <g key={l.key} style={{ color: l.color }} dangerouslySetInnerHTML={{ __html: body }} />
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
          const endA = mA;
          const endB = mB ?? hover?.g ?? null;
          const aS = endA && toScreen(endA);
          const bS = endB && toScreen(endB);
          const dxmm = endA && endB ? endB[0] - endA[0] : 0;
          const dymm = endA && endB ? endB[1] - endA[1] : 0;
          const dist = Math.hypot(dxmm, dymm);
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
          const pickingStart = !mA || !!mB;
          return (
            <g style={{ pointerEvents: "none" }}>
              {hover && (() => {
                const [hx, hy] = toScreen(hover.g);
                const hoverStroke = hover.snapped ? MEASURE : MEASURE_DIM;
                if (pickingStart) {
                  return (
                    <g transform={`translate(${hx} ${hy})`}>
                      <line x1={-MEASURE_CROSSHAIR_ARM} y1={0} x2={MEASURE_CROSSHAIR_ARM} y2={0} style={{ stroke: hoverStroke }} strokeWidth={MEASURE_STROKE - 0.5} />
                      <line x1={0} y1={-MEASURE_CROSSHAIR_ARM} x2={0} y2={MEASURE_CROSSHAIR_ARM} style={{ stroke: hoverStroke }} strokeWidth={MEASURE_STROKE - 0.5} />
                    </g>
                  );
                }
                return (
                  <circle
                    cx={hx}
                    cy={hy}
                    r={hover.snapped ? MEASURE_RING_R : MEASURE_RING_R - 1}
                    fill="none"
                    style={{ stroke: hoverStroke }}
                    strokeWidth={MEASURE_STROKE - 0.5}
                  />
                );
              })()}
              {aS && bS && (
                <>
                  <line x1={aS[0]} y1={aS[1]} x2={bS[0]} y2={bS[1]} style={{ stroke: MEASURE }} strokeWidth={MEASURE_STROKE} />
                  {[aS, bS].map((p, i) => (
                    <g key={i}>
                      <circle cx={p[0]} cy={p[1]} r={MEASURE_DOT_R} style={{ fill: MEASURE }} />
                      <circle cx={p[0]} cy={p[1]} r={MEASURE_RING_R} fill="none" style={{ stroke: MEASURE_RING }} strokeWidth={MEASURE_STROKE - 0.5} />
                    </g>
                  ))}
                  <g transform={`translate(${labelX} ${labelY})`}>
                    <rect x={0} y={0} width={labelW} height={labelH} rx={6} style={{ fill: MEASURE_LABEL_BG, stroke: "hsl(var(--border))" }} />
                    <text x={8} y={14} style={{ fill: MEASURE, fontSize: "11px", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                      {fmtLen(dist)}
                    </text>
                    <text x={8} y={27} style={{ fill: MEASURE_DIM, fontSize: "9px", fontVariantNumeric: "tabular-nums" }}>
                      ΔX {fmtLen(dxmm)} · ΔY {fmtLen(dymm)}
                    </text>
                  </g>
                </>
              )}
            </g>
          );
        })()}

        {/* Edge rulers — screen space, drawn LAST so they sit on top of every
            layer and the measure overlay; their opaque fill clips content out of
            the ruler band so nothing ever bleeds onto them. */}
        <g style={{ pointerEvents: "none" }}>
          <rect x={0} y={0} width={size.w} height={RULER} style={{ fill: "hsl(var(--card))" }} />
          <rect x={0} y={0} width={RULER} height={size.h} style={{ fill: "hsl(var(--card))" }} />
          <rect x={0} y={0} width={RULER} height={RULER} style={{ fill: "hsl(var(--card))" }} />
          {/* top ruler */}
          {vTicks.map((t) => {
            const x = sx(t.mm);
            if (x < RULER || x > size.w) return null;
            return (
              <g key={`tv${t.mm}`}>
                <line
                  x1={x}
                  y1={t.major ? RULER - 9 : RULER - 5}
                  x2={x}
                  y2={RULER}
                  style={{ stroke: `hsl(var(--muted-foreground) / ${t.major ? 0.7 : 0.4})` }}
                  strokeWidth={1}
                />
                {t.major && (
                  <text
                    x={x + 3}
                    y={9}
                    style={{ fill: "hsl(var(--muted-foreground))", fontSize: "9px" }}
                  >
                    {fmtMm(t.label)}
                  </text>
                )}
              </g>
            );
          })}
          {/* left ruler */}
          {hTicks.map((t) => {
            const y = sy(t.mm);
            if (y < RULER || y > size.h) return null;
            return (
              <g key={`th${t.mm}`}>
                <line
                  x1={t.major ? RULER - 9 : RULER - 5}
                  y1={y}
                  x2={RULER}
                  y2={y}
                  style={{ stroke: `hsl(var(--muted-foreground) / ${t.major ? 0.7 : 0.4})` }}
                  strokeWidth={1}
                />
                {t.major && (
                  <text
                    x={9}
                    y={y + 3}
                    transform={`rotate(-90 9 ${y + 3})`}
                    textAnchor="start"
                    style={{ fill: "hsl(var(--muted-foreground))", fontSize: "9px" }}
                  >
                    {fmtMm(t.label)}
                  </text>
                )}
              </g>
            );
          })}
          {/* ruler edges */}
          <line x1={RULER} y1={0} x2={RULER} y2={size.h} style={{ stroke: "hsl(var(--border))" }} strokeWidth={1} />
          <line x1={0} y1={RULER} x2={size.w} y2={RULER} style={{ stroke: "hsl(var(--border))" }} strokeWidth={1} />
        </g>
      </svg>

      <DrcMarkers markers={projectedMarkers} width={size.w} height={size.h} />

      <div
        className="absolute right-2 top-[26px] rounded-md border border-border bg-card/90 px-2 py-1 text-[11px] tabular-nums text-muted-foreground"
        title={t("viewer.boardSize")}
      >
        {fmtLen(boardW)} × {fmtLen(boardH)}
      </div>

      <div className="absolute bottom-2 right-2 flex items-center gap-0.5 rounded-md border border-border bg-card/90 p-0.5 text-muted-foreground">
        <button
          className={`cursor-pointer rounded p-1 hover:bg-muted/60 ${tool === "measure" ? "bg-primary/20 text-primary" : ""}`}
          title={t("viewer.ruler")}
          onClick={() => { setTool((t) => (t === "measure" ? "pan" : "measure")); setMA(null); setMB(null); setHover(null); }}
        >
          <Ruler className="size-4" />
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
          className="cursor-pointer rounded px-1.5 py-1 text-[11px] font-medium hover:bg-muted/60"
          title={t("viewer.realSize1to1")}
          onClick={realSize}
        >
          1:1
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
    </div>
  );
}

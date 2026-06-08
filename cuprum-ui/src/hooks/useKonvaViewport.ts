import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";
import { MIN_SCALE, MAX_SCALE } from "@/components/editor/canvasStyle";
import type { Viewport } from "@/components/editor/RulersOverlay";

// px of the canvas that must stay on-screen while panning, so the board can never
// be flung completely out of sight.
const EDGE_KEEP = 64;

export interface KonvaViewportOptions {
  /** World extents in mm (panel width/height, or the exposure screen size). */
  worldW: number;
  worldH: number;
  /** Ruler band reserved on the left/top edge (px); the view fits/centres into the
   *  area NOT covered by the rulers. 0 (default) for canvases without rulers. */
  rulerLeft?: number;
  rulerTop?: number;
  /** Breathing room around the fitted board: fit scale × this (default 0.9). */
  fitMargin?: number;
  /** Auto re-fit (centre at scale 1) on container resize as well as world-size
   *  change. true (default) for panel/drill; false for the exposure editor, which
   *  must never yank the user's view around on a plain window resize. */
  reframeOnResize?: boolean;
  /** Extra auto-frame trigger: re-fit whenever this string changes. The exposure
   *  editor passes its placement count so the view re-frames on new content. */
  frameContentKey?: string;
  /** Mirror the imperative stage transform into `viewport`/`viewportRef` so SVG
   *  overlays (rulers, datum axes, machine marker) can follow it. false for
   *  canvases without such overlays — skips the per-zoom state churn. */
  trackViewport?: boolean;
  /** Notified on every viewport change (pan, zoom, animation frame). */
  onViewportChange?: (v: Viewport) => void;
  /** Map a stage scale to the displayed zoom percent. Default `round(scale*100)`;
   *  the panel shows real-world zoom `round(fit*scale/pxPerMm*100)`. */
  scaleToPct?: (scale: number, fit: number) => number;
}

export interface KonvaViewport {
  containerRef: React.RefObject<HTMLDivElement>;
  stageRef: React.RefObject<Konva.Stage>;
  size: { w: number; h: number };
  /** px per mm at stage scale 1. */
  fit: number;
  viewport: Viewport;
  /** Live mirror of `viewport`, safe to read from rAF callbacks scheduled a frame
   *  ahead (the state value would be stale there). */
  viewportRef: React.MutableRefObject<Viewport>;
  zoomPct: number;
  spaceDown: boolean;
  syncViewport: () => void;
  clampPos: (x: number, y: number, scale: number) => { x: number; y: number };
  centerAt: (scale: number, animate: boolean) => void;
  zoomAt: (pointer: { x: number; y: number }, factor: number, animate?: boolean) => void;
  fitView: () => void;
  onWheel: (e: KonvaEventObject<WheelEvent>) => void;
  zoomButton: (factor: number) => void;
  dragBoundFunc: (pos: { x: number; y: number }) => { x: number; y: number };
}

/** Shared zoom/pan/fit for the imperative Konva-stage canvases (panel blank, drill
 *  map, exposure editor). Owns the container size, stage scale/position, fit scale,
 *  the screen-space viewport mirror, and the Space-to-pan toggle. The three canvases
 *  differ only in world extents, ruler offsets, the auto-frame trigger and the zoom
 *  readout — all options here. The exposure editor builds its own wheel handler (it
 *  adds Shift+wheel horizontal pan) on top of the returned primitives. */
export function useKonvaViewport(opts: KonvaViewportOptions): KonvaViewport {
  const { worldW, worldH, rulerLeft = 0, rulerTop = 0, fitMargin = 0.9, reframeOnResize = true, frameContentKey = "", trackViewport = true } = opts;

  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  // Start at 0×0 so the auto-frame effect's `size.w === 0` guard suppresses the
  // pre-layout frame until the ResizeObserver delivers the real container size —
  // no one-frame mis-frame at a guessed default.
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [zoomPct, setZoomPct] = useState(100);
  const [viewport, setViewport] = useState<Viewport>({ pxPerMm: 0, originX: 0, originY: 0 });
  const viewportRef = useRef<Viewport>({ pxPerMm: 0, originX: 0, originY: 0 });
  const [spaceDown, setSpaceDown] = useState(false);

  // Latest callbacks via refs so the memoised handlers stay stable across renders
  // even when the parent passes fresh inline functions.
  const onViewportChangeRef = useRef(opts.onViewportChange);
  onViewportChangeRef.current = opts.onViewportChange;
  const scaleToPctRef = useRef(opts.scaleToPct);
  scaleToPctRef.current = opts.scaleToPct;

  const W = Math.max(worldW, 1);
  const H = Math.max(worldH, 1);

  // Fit the world into the plot area (right of / below the ruler bands) with a
  // little breathing room.
  const fit = useMemo(
    () => Math.min((size.w - rulerLeft) / W, (size.h - rulerTop) / H) * fitMargin,
    [size.w, size.h, W, H, rulerLeft, rulerTop, fitMargin],
  );
  const fitRef = useRef(fit);
  fitRef.current = fit;

  const pct = useCallback((s: number) => {
    const fn = scaleToPctRef.current;
    return fn ? fn(s, fitRef.current) : Math.round(s * 100);
  }, []);

  // Mirror the imperative Konva stage transform into React state: screen px/mm =
  // stage scale × fit; world origin (mm 0,0) = stage pos. No-op when not tracking.
  const syncViewport = useCallback(() => {
    if (!trackViewport) return;
    const stage = stageRef.current;
    if (!stage) return;
    const v: Viewport = { pxPerMm: stage.scaleX() * fitRef.current, originX: stage.x(), originY: stage.y() };
    viewportRef.current = v;
    setViewport(v);
    onViewportChangeRef.current?.(v);
  }, [trackViewport]);

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
      const pos = clampPos(
        rulerLeft + (size.w - rulerLeft - W * fit * s) / 2,
        rulerTop + (size.h - rulerTop - H * fit * s) / 2,
        s,
      );
      if (animate) {
        stage.to({ x: pos.x, y: pos.y, scaleX: s, scaleY: s, duration: 0.16, easing: Konva.Easings.EaseOut, onUpdate: syncViewport, onFinish: syncViewport });
      } else {
        stage.scale({ x: s, y: s });
        stage.position(pos);
        stage.batchDraw();
        syncViewport();
      }
      setZoomPct(pct(s));
    },
    [clampPos, fit, size.w, size.h, W, H, rulerLeft, rulerTop, syncViewport, pct],
  );

  const fitView = useCallback(() => centerAt(1, true), [centerAt]);

  // Auto-frame on first layout and whenever the frame trigger changes: world dims
  // (+ pane size when reframeOnResize) for panel & drill; the content key for the
  // exposure editor (placement count — never on a plain resize).
  const frameKey = reframeOnResize ? `${W}:${H}:${size.w}:${size.h}` : `${W}:${H}:${frameContentKey}`;
  const framed = useRef("");
  useEffect(() => {
    if (size.w === 0 || framed.current === frameKey) return;
    framed.current = frameKey;
    centerAt(1, false);
  }, [frameKey, size.w, centerAt]);

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
        stage.to({ x: pos.x, y: pos.y, scaleX: newScale, scaleY: newScale, duration: 0.16, easing: Konva.Easings.EaseOut, onUpdate: syncViewport, onFinish: syncViewport });
      } else {
        stage.scale({ x: newScale, y: newScale });
        stage.position(pos);
        stage.batchDraw();
        syncViewport();
      }
      setZoomPct(pct(newScale));
    },
    [clampPos, syncViewport, pct],
  );

  const onWheel = useCallback(
    (e: KonvaEventObject<WheelEvent>) => {
      e.evt.preventDefault();
      const stage = stageRef.current;
      if (!stage) return;
      const pointer = stage.getPointerPosition();
      if (!pointer) return;
      zoomAt(pointer, Math.exp(-e.evt.deltaY * 0.0015));
    },
    [zoomAt],
  );

  const zoomButton = useCallback(
    (factor: number) => zoomAt({ x: size.w / 2, y: size.h / 2 }, factor, true),
    [zoomAt, size.w, size.h],
  );

  const dragBoundFunc = useCallback(
    (pos: { x: number; y: number }) => {
      const stage = stageRef.current;
      return clampPos(pos.x, pos.y, stage ? stage.scaleX() : 1);
    },
    [clampPos],
  );

  // Track container size.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

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

  return {
    containerRef,
    stageRef,
    size,
    fit,
    viewport,
    viewportRef,
    zoomPct,
    spaceDown,
    syncViewport,
    clampPos,
    centerAt,
    zoomAt,
    fitView,
    onWheel,
    zoomButton,
    dragBoundFunc,
  };
}

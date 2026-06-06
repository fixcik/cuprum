import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer, Group, Rect, Circle, Line, Arrow, Text, Arc } from "react-konva";
import Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";
import { Maximize, Plus, Minus } from "lucide-react";
import type { PanelDrillPlan } from "@/lib/panelDrill";
import type { DrillRoute, RouteGroup } from "@/lib/drillRoute";
import type { DrillClass } from "@/lib/api";
import { MachineMarker } from "./MachineMarker";
import { workPosToPanel } from "@/lib/machineMarker";
import { type DatumCorner, datumCornerPanelPoint } from "@/lib/datum";
import { AdaptiveGrid } from "@/components/editor/AdaptiveGrid";
import { MIN_SCALE, MAX_SCALE, RULER_LEFT, RULER_TOP } from "@/components/editor/canvasStyle";
import { RulersOverlay, type Viewport } from "@/components/editor/RulersOverlay";
import { useUnitFormat } from "@/i18n/useUnitFormat";
import { nearestHole } from "@/lib/drillHitTest";
import { DrillCanvasToolPalette } from "./DrillCanvasToolPalette";

// Re-export Viewport so callers (Task 2 rulers) can import it from here directly.
export type { Viewport };

/** Palette of distinct colours for drill groups, cycling when there are more groups than colours. */
export const GROUP_PALETTE = [
  "#4f9cf9", // blue
  "#f97316", // orange
  "#22c55e", // green
  "#a855f7", // purple
  "#f43f5e", // rose
  "#eab308", // yellow
  "#06b6d4", // cyan
  "#84cc16", // lime
  "#ec4899", // pink
  "#8b5cf6", // violet
];

export function groupColor(index: number): string {
  return GROUP_PALETTE[index % GROUP_PALETTE.length];
}

/** Circle stroke width (px, screen-space). */
const HOLE_STROKE_PX = 1.2;

/** Path line width (px, screen-space). */
const PATH_STROKE_PX = 0.8;

/** Tool-change marker outer ring radius offset (mm) added on top of hole radius. */
const TOOL_CHANGE_RING_OFFSET_MM = 0.6;

/** Selection ring offset above hole radius (mm). */
const SELECT_RING_OFFSET_MM = 0.6;
/** Hover ring offset above hole radius (mm). */
const HOVER_RING_OFFSET_MM = 0.4;
/** Copper/primary colour for the selection ring — matches COPPER_STROKE from canvasStyle. */
const SELECT_RING_COLOR = "#b87333";

/** Tool-change marker ring stroke (px, screen-space). */
const TOOL_CHANGE_RING_PX = 1.8;

/** Machine-origin axis indicator length (px, screen-space). */
const AXIS_PX = 30;
/** Colour of the origin marker + axis arrows. */
const AXIS_COLOR = "#94a3b8";

/** How many px of the panel must remain visible while panning. */
const EDGE_KEEP = 64;

export interface DrillMapCanvasProps {
  /** Panel width in mm. */
  widthMm: number;
  /** Panel height in mm. */
  heightMm: number;
  plan: PanelDrillPlan;
  route: DrillRoute;
  /** Keep-out zones in panel-space mm (optional). */
  zones?: { x: number; y: number; w: number; h: number }[];
  /** Optional live-run progress for highlight overlay. When absent the canvas
   *  renders exactly as it did before (no visual change). */
  progress?: { holesCompleted: number; currentHoleIndex: number | null };
  /** Live machine WORK position (mm), or null to hide the marker. Optional z is
   *  shown in the marker readout. */
  machineWork?: { x: number; y: number; z?: number } | null;
  /** Which panel corner is machine (0,0). Defaults to "bottom-left". */
  datum?: DatumCorner;
  /** Set of drill classes selected for this run. Holes whose class is NOT in this
   *  set are drawn as a dim base layer so the operator can see what is excluded. */
  selectedClasses?: Set<DrillClass>;
  /** Set of drill classes that are VISIBLE on the canvas. Holes whose class is NOT
   *  in this set are skipped entirely (not rendered). Defaults to all classes visible.
   *  Independent of selectedClasses: a class can be visible-but-dimmed (in visibleClasses
   *  but not in selectedClasses) or hidden entirely (not in visibleClasses). */
  visibleClasses?: Set<DrillClass>;
  /** Whether to render the traverse path line. Defaults to true. */
  showPath?: boolean;
  /** Whether to render a diameter label near the first hole of each visible group.
   *  Defaults to false. */
  showDiameters?: boolean;
  /** Smoothed 0..1 depth-progress fraction for the currently-drilling hole.
   *  Drives the filling Arc rendered around that hole. */
  currentHoleProgress?: number;
  /** Called on every viewport change (pan, zoom, animate frame) so Task 2 rulers
   *  can follow the canvas transform without prop drilling into the Stage. */
  onViewportChange?: (v: Viewport) => void;
  /** Currently selected hole key (`${gi}-${hi}`). Drives the copper selection ring. */
  selectedHoleId?: string | null;
  /** Called when the user clicks a hole (or clicks empty space → null). */
  onSelectHole?: (id: string | null) => void;
}

/** Read-only 2D drill map canvas: panel outline, holes by tool colour, traverse
 *  path, tool-change markers at each group's first hole, and a machine-origin
 *  indicator. Hole coordinates are panel-space mm (0,0 = top-left of blank). The
 *  work-zero marker is placed at the chosen datum corner (default: bottom-left).
 *  Supports pinch/scroll zoom and Space-to-pan, mirroring PanelBlankCanvas. */
export function DrillMapCanvas({ widthMm, heightMm, plan, route, zones, progress, machineWork, datum = "bottom-left", selectedClasses, visibleClasses, showPath = true, showDiameters = false, currentHoleProgress, onViewportChange, selectedHoleId, onSelectHole }: DrillMapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  // Ref to the fit-group for pointer → mm coordinate conversion.
  const fitGroupRef = useRef<Konva.Group>(null);
  const [size, setSize] = useState({ w: 400, h: 300 });
  const [viewport, setViewport] = useState<Viewport>({ pxPerMm: 0, originX: 0, originY: 0 });
  const [zoomPct, setZoomPct] = useState(100);
  const [spaceDown, setSpaceDown] = useState(false);
  // Internal tool: "select" or "pan". Space held → pan regardless.
  const [tool, setTool] = useState<"select" | "pan">("select");
  const panMode = tool === "pan" || spaceDown;
  const { fmtLen } = useUnitFormat();

  // RAF-coalesced hovered hole key for the highlight ring.
  const [hoveredHoleKey, setHoveredHoleKey] = useState<string | null>(null);
  const hoveredHoleRaf = useRef<number | null>(null);
  const pendingHoveredKey = useRef<string | null>(null);

  // RAF-coalesced hover position in screen px (for the rulers crosshair/readout).
  const [hoverPx, setHoverPx] = useState<{ x: number; y: number } | null>(null);
  const hoverRaf = useRef<number | null>(null);
  const pendingHover = useRef<{ x: number; y: number } | null>(null);
  const queueHover = useCallback((p: { x: number; y: number } | null) => {
    pendingHover.current = p;
    if (p === null) {
      if (hoverRaf.current != null) {
        cancelAnimationFrame(hoverRaf.current);
        hoverRaf.current = null;
      }
      setHoverPx(null);
      return;
    }
    if (hoverRaf.current != null) return;
    hoverRaf.current = requestAnimationFrame(() => {
      hoverRaf.current = null;
      setHoverPx(pendingHover.current);
    });
  }, []);
  useEffect(() => () => { if (hoverRaf.current != null) cancelAnimationFrame(hoverRaf.current); }, []);
  useEffect(() => () => { if (hoveredHoleRaf.current != null) cancelAnimationFrame(hoveredHoleRaf.current); }, []);

  // Track container size.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Space-bar = pan mode (mirrors PanelBlankCanvas).
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

  const W = Math.max(widthMm, 1);
  const H = Math.max(heightMm, 1);

  // Fit scale: how many px one mm occupies at scale=1 so the panel fills the
  // canvas minus the ruler margins (reserved for Task 2 rulers) with 10% breathing room.
  const fit = useMemo(
    () => Math.min((size.w - RULER_LEFT) / W, (size.h - RULER_TOP) / H) * 0.9,
    [size.w, size.h, W, H],
  );

  // Mirror the imperative Konva stage transform into React state so screen-space
  // overlays (datum axes, MachineMarker) always know the current viewport.
  const syncViewport = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const v: Viewport = { pxPerMm: stage.scaleX() * fit, originX: stage.x(), originY: stage.y() };
    setViewport(v);
    onViewportChange?.(v);
  }, [fit, onViewportChange]);

  // Clamp the stage position so at least EDGE_KEEP px of the panel remain visible.
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

  // Centre the panel at a given stage scale, optionally animated.
  const centerAt = useCallback(
    (scale: number, animate: boolean) => {
      const stage = stageRef.current;
      if (!stage) return;
      const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
      const pos = clampPos(
        RULER_LEFT + (size.w - RULER_LEFT - W * fit * s) / 2,
        RULER_TOP + (size.h - RULER_TOP - H * fit * s) / 2,
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
      setZoomPct(Math.round(s * 100));
    },
    [clampPos, fit, size.w, size.h, W, H, syncViewport],
  );

  const fitView = useCallback(() => centerAt(1, true), [centerAt]);

  // Auto-fit on first layout and whenever the panel dimensions or container size
  // change. A ref guard prevents re-fitting on every re-render.
  const framed = useRef("");
  useEffect(() => {
    const key = `${W}:${H}:${size.w}:${size.h}`;
    if (size.w === 0 || framed.current === key) return;
    framed.current = key;
    centerAt(1, false);
  }, [W, H, size.w, size.h, centerAt]);

  // Zoom toward an arbitrary screen-space pointer (scroll wheel or zoom buttons).
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
      setZoomPct(Math.round(newScale * 100));
    },
    [clampPos, syncViewport],
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

  const dragBoundFunc = (pos: { x: number; y: number }) => {
    const stage = stageRef.current;
    return clampPos(pos.x, pos.y, stage ? stage.scaleX() : 1);
  };

  // Flat path array for Konva Line (panel mm coords).
  const pathFlat = useMemo(
    () => route.pathPoints.flatMap((h) => [h.xMm, h.yMm]),
    [route.pathPoints],
  );

  // Datum-derived rulers configuration. The anchor is the datum corner in panel
  // mm (Y-down). axisFlip mirrors tick labels so the panel always reads 0→W and
  // 0→H from the datum corner toward the opposite edge.
  const right = datum === "bottom-right" || datum === "top-right";
  const bottom = datum === "bottom-left" || datum === "bottom-right";
  const anchorMm = { x: right ? W : 0, y: bottom ? H : 0 };
  const axisFlip = { x: right, y: bottom };

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
        dragBoundFunc={dragBoundFunc}
        onWheel={onWheel}
        onDragMove={syncViewport}
        onDragEnd={syncViewport}
        onMouseMove={() => {
          const pos = stageRef.current?.getPointerPosition() ?? null;
          queueHover(pos ? { x: pos.x, y: pos.y } : null);

          // Compute hovered hole key via fit-group relative pointer → mm.
          const fitGroup = fitGroupRef.current;
          if (fitGroup && viewport.pxPerMm > 0) {
            const rel = fitGroup.getRelativePointerPosition();
            if (rel) {
              const hit = nearestHole({ x: rel.x, y: rel.y }, route, viewport.pxPerMm);
              const nextKey = hit ? hit.key : null;
              pendingHoveredKey.current = nextKey;
              if (hoveredHoleRaf.current == null) {
                hoveredHoleRaf.current = requestAnimationFrame(() => {
                  hoveredHoleRaf.current = null;
                  setHoveredHoleKey(pendingHoveredKey.current);
                });
              }
            }
          }
        }}
        onMouseLeave={() => {
          queueHover(null);
          // Cancel a pending hover-hole rAF so it can't re-set the key after we clear it.
          if (hoveredHoleRaf.current != null) {
            cancelAnimationFrame(hoveredHoleRaf.current);
            hoveredHoleRaf.current = null;
          }
          setHoveredHoleKey(null);
        }}
        onClick={() => {
          if (tool === "pan" || spaceDown) return;
          const fitGroup = fitGroupRef.current;
          if (!fitGroup || viewport.pxPerMm <= 0) return;
          const rel = fitGroup.getRelativePointerPosition();
          if (!rel) return;
          const hit = nearestHole({ x: rel.x, y: rel.y }, route, viewport.pxPerMm);
          onSelectHole?.(hit ? hit.key : null);
        }}
      >
        <Layer>
          {/* The fit-group maps mm → px at scale 1; the Stage carries pan/zoom. */}
          <Group ref={fitGroupRef} x={0} y={0} scaleX={fit} scaleY={fit}>
            {/* Adaptive mm grid (zoom-aware, only draws visible lines). */}
            <AdaptiveGrid widthMm={W} heightMm={H} />

            {/* Panel outline */}
            <Rect
              x={0}
              y={0}
              width={W}
              height={H}
              stroke="#4a5568"
              strokeWidth={1}
              strokeScaleEnabled={false}
              fill="#0f172a"
              listening={false}
            />

            {/* Keep-out zones: semi-transparent red fill, thin red border. */}
            {(zones ?? []).map((z, zi) => (
              <Rect
                key={`zone-${zi}`}
                x={z.x}
                y={z.y}
                width={z.w}
                height={z.h}
                fill="rgba(244,63,94,0.12)"
                stroke="#f43f5e"
                strokeWidth={1}
                strokeScaleEnabled={false}
                listening={false}
              />
            ))}

            {/* Traverse path drawn UNDER the holes. Hidden when showPath is false. */}
            {showPath && pathFlat.length >= 4 && (
              <Line
                points={pathFlat}
                stroke="rgba(255,255,255,0.12)"
                strokeWidth={PATH_STROKE_PX}
                strokeScaleEnabled={false}
                lineJoin="round"
                lineCap="round"
                listening={false}
              />
            )}

            {/* Dim base layer: holes in visibleClasses but NOT in selectedClasses.
                Holes not in visibleClasses are skipped entirely (not rendered at all). */}
            {selectedClasses &&
              plan.groups
                .filter((g) => {
                  // Skip entirely if the class is hidden via visibleClasses.
                  if (visibleClasses && !visibleClasses.has(g.class)) return false;
                  // Only render dimmed holes that are NOT in the run selection.
                  return !selectedClasses.has(g.class);
                })
                .flatMap((g) =>
                  g.holes.map((h, hi) => (
                    <Circle
                      key={`dim-${g.class}-${g.diameterMm}-${hi}`}
                      x={h.xMm}
                      y={h.yMm}
                      radius={Math.max(g.diameterMm / 2, 0.1)}
                      stroke="#334155"
                      strokeWidth={HOLE_STROKE_PX}
                      strokeScaleEnabled={false}
                      opacity={0.25}
                      listening={false}
                    />
                  )),
                )}

            {/* Holes per group with distinct colour; first hole of each group gets a
                tool-change ring. The depth-progress Arc lives here too (mm-space with
                strokeScaleEnabled=false) so it scales correctly with zoom.
                Groups whose class is hidden via visibleClasses are skipped entirely. */}
            {(() => {
              let gIdx = 0;
              return route.groups.map((g: RouteGroup, gi: number) => {
                // Skip this group entirely if its class is hidden.
                if (visibleClasses && !visibleClasses.has(g.class)) {
                  gIdx += g.orderedHoles.length;
                  return null;
                }
                const color = groupColor(gi);
                const firstHole = g.orderedHoles[0];
                return g.orderedHoles.map((h, hi) => {
                  const currentGIdx = gIdx++;
                  const r = g.diameterMm / 2;
                  const isToolChange = hi === 0;

                  const isDrilled =
                    progress !== undefined && currentGIdx < progress.holesCompleted;
                  const isCurrent =
                    progress !== undefined &&
                    progress.currentHoleIndex !== null &&
                    currentGIdx === progress.currentHoleIndex;
                  const showCurrent = isCurrent && !isDrilled;

                  const holeFill = isDrilled
                    ? "rgba(34,197,94,0.5)"
                    : "rgba(0,0,0,0.6)";

                  const holeKey = `${gi}-${hi}`;
                  const isSelected = selectedHoleId === holeKey;
                  const isHovered = hoveredHoleKey === holeKey && !isSelected;

                  return (
                    <Group key={holeKey} listening={false}>
                      {/* Selection ring — copper coloured, drawn below other rings. */}
                      {isSelected && (
                        <Circle
                          x={h.xMm}
                          y={h.yMm}
                          radius={r + SELECT_RING_OFFSET_MM}
                          stroke={SELECT_RING_COLOR}
                          strokeWidth={2}
                          strokeScaleEnabled={false}
                          fill={undefined}
                        />
                      )}
                      {/* Hover highlight ring — subtle white, only when not selected. */}
                      {isHovered && (
                        <Circle
                          x={h.xMm}
                          y={h.yMm}
                          radius={r + HOVER_RING_OFFSET_MM}
                          stroke="rgba(255,255,255,0.45)"
                          strokeWidth={1}
                          strokeScaleEnabled={false}
                          fill={undefined}
                        />
                      )}
                      {/* Tool-change ring around the first hole in each group. */}
                      {isToolChange && (
                        <Circle
                          x={h.xMm}
                          y={h.yMm}
                          radius={r + TOOL_CHANGE_RING_OFFSET_MM}
                          stroke={color}
                          strokeWidth={TOOL_CHANGE_RING_PX}
                          strokeScaleEnabled={false}
                          fill={undefined}
                          opacity={0.6}
                        />
                      )}
                      {/* Diameter label near the first hole of the group. Rendered in
                          mm-space so it scales naturally with zoom. Only shown when
                          showDiameters is true and this is the group's first hole. */}
                      {showDiameters && isToolChange && firstHole && (
                        <Text
                          x={firstHole.xMm + r + 0.3}
                          y={firstHole.yMm - Math.max(g.diameterMm * 0.3, 0.25)}
                          text={`⌀${g.diameterMm}`}
                          fontSize={Math.min(Math.max(g.diameterMm * 0.6, 0.5), 2.5)}
                          fill="rgba(203,213,225,0.75)"
                          listening={false}
                        />
                      )}
                      {/* Faint full-circle track + depth-progress arc for the currently-drilling hole.
                          Both live in mm-space with strokeScaleEnabled=false so they scale correctly
                          under zoom (no screen-space conversion needed). */}
                      {showCurrent && (
                        <>
                          <Circle
                            x={h.xMm}
                            y={h.yMm}
                            radius={r + 0.6}
                            stroke="#22c55e"
                            strokeWidth={2}
                            strokeScaleEnabled={false}
                            opacity={0.25}
                            fill={undefined}
                            listening={false}
                          />
                          <Arc
                            x={h.xMm}
                            y={h.yMm}
                            innerRadius={r + 0.45}
                            outerRadius={r + 0.75}
                            angle={360 * Math.max(0, Math.min(1, currentHoleProgress ?? 0))}
                            rotation={-90}
                            fill="#22c55e"
                            listening={false}
                          />
                        </>
                      )}
                      {/* Hole circle */}
                      <Circle
                        x={h.xMm}
                        y={h.yMm}
                        radius={Math.max(r, 0.1)}
                        stroke={color}
                        strokeWidth={HOLE_STROKE_PX}
                        strokeScaleEnabled={false}
                        fill={holeFill}
                      />
                    </Group>
                  );
                });
              });
            })()}
          </Group>

          {/* Machine-origin indicator — screen-space so axis arrows stay constant-size.
              Screen position is computed from the live viewport so it tracks pan/zoom. */}
          {(() => {
            const { xMm: dxMm, yMm: dyMm } = datumCornerPanelPoint(datum, W, H);
            const ox = viewport.originX + dxMm * viewport.pxPerMm;
            const oy = viewport.originY + dyMm * viewport.pxPerMm;
            return (
              <Group listening={false}>
                <Arrow
                  points={[ox, oy, ox + AXIS_PX, oy]}
                  stroke={AXIS_COLOR}
                  fill={AXIS_COLOR}
                  strokeWidth={1.2}
                  pointerLength={5}
                  pointerWidth={5}
                />
                <Arrow
                  points={[ox, oy, ox, oy - AXIS_PX]}
                  stroke={AXIS_COLOR}
                  fill={AXIS_COLOR}
                  strokeWidth={1.2}
                  pointerLength={5}
                  pointerWidth={5}
                />
                <Circle x={ox} y={oy} radius={2.5} fill="#f59e0b" />
                <Text x={ox + AXIS_PX + 3} y={oy - 6} text="X" fontSize={11} fill={AXIS_COLOR} />
                <Text x={ox - 11} y={oy - AXIS_PX - 5} text="Y" fontSize={11} fill={AXIS_COLOR} />
                <Text x={ox + 5} y={oy + 4} text="0,0" fontSize={10} fill={AXIS_COLOR} />
              </Group>
            );
          })()}

          {/* Live machine-position marker — screen-space, constant visual size.
              Panel mm coords are converted to screen px via the live viewport. */}
          {machineWork && (() => {
            const p = workPosToPanel(machineWork.x, machineWork.y, H, datum, W);
            return (
              <MachineMarker
                screenX={viewport.originX + p.xMm * viewport.pxPerMm}
                screenY={viewport.originY + p.yMm * viewport.pxPerMm}
                workX={machineWork.x}
                workY={machineWork.y}
                workZ={machineWork.z}
              />
            );
          })()}
        </Layer>
      </Stage>

      {/* Floating left-side tool palette (select / pan). */}
      <DrillCanvasToolPalette tool={tool} onToolChange={setTool} />

      {/* Edge-pinned rulers SVG overlay — pointer-events-none, sits above the Stage. */}
      <RulersOverlay
        viewport={viewport}
        size={size}
        fmt={fmtLen}
        extentMm={{ x: 0, y: 0, w: W, h: H }}
        anchorMm={anchorMm}
        axisFlip={axisFlip}
        extentVariant="muted"
        hover={hoverPx}
      />

      {/* Bottom-right zoom bar — mirrors PanelBlankCanvas. */}
      <div className="absolute bottom-2 right-2 flex items-center gap-0.5 rounded-md border border-border bg-card/90 p-0.5 text-muted-foreground [&_button]:cursor-pointer">
        <button
          className="rounded p-1 hover:bg-muted/60"
          aria-label="Zoom out"
          title="Zoom out"
          onClick={() => zoomButton(1 / 1.2)}
        >
          <Minus className="size-4" />
        </button>
        <button
          className="min-w-12 rounded px-1.5 py-1 text-center text-[11px] tabular-nums hover:bg-muted/60"
          aria-label="Fit view"
          title="Fit view"
          onClick={fitView}
        >
          {zoomPct}%
        </button>
        <button
          className="rounded p-1 hover:bg-muted/60"
          aria-label="Zoom in"
          title="Zoom in"
          onClick={() => zoomButton(1.2)}
        >
          <Plus className="size-4" />
        </button>
        <button
          className="rounded p-1 hover:bg-muted/60"
          aria-label="Fit all"
          title="Fit all"
          onClick={fitView}
        >
          <Maximize className="size-4" />
        </button>
      </div>
    </div>
  );
}

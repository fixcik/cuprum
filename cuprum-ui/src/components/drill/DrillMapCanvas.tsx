import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer, Group, Rect, Circle, Line, Arrow, Text, Arc } from "react-konva";
import Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";
import { Maximize, Plus, Minus } from "lucide-react";
import type { PanelDrillPlan } from "@/lib/panelDrill";
import type { DrillRoute, RouteGroup } from "@/lib/drillRoute";
import { buildHoleToPathIndex, orderedHoleList } from "@/lib/drillRoute";
import type { DrillClass } from "@/lib/api";
import type { PhaseProgress } from "@/lib/drillPhaseProgress";
import { PHASE_COLORS } from "@/lib/drillPhaseProgress";
import { MachineMarker } from "./MachineMarker";
import { workPosToPanel } from "@/lib/machineMarker";
import { type DatumCorner, datumCornerPanelPoint } from "@/lib/datum";
import { AdaptiveGrid } from "@/components/editor/AdaptiveGrid";
import { MIN_SCALE, MAX_SCALE, RULER_LEFT, RULER_TOP } from "@/components/editor/canvasStyle";
import { RulersOverlay, type Viewport } from "@/components/editor/RulersOverlay";
import { useUnitFormat } from "@/i18n/useUnitFormat";
import { nearestPlanHole } from "@/lib/drillHitTest";
import { enumerateHoles } from "@/lib/drillSelection";
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

/** Per-hole geometry indexed by stable id — drives the single-node overlay rings
 *  (hover / inspected / current-phase) without touching the bulk holes layer. */
interface HoleGeom {
  xMm: number;
  yMm: number;
  /** Drawn radius (mm), clamped to a visible minimum. */
  r: number;
}

interface HolesLayerProps {
  plan: PanelDrillPlan;
  selectedHoleIds?: Set<string>;
  drilledHoleIds?: Set<string>;
  visibleClasses?: Set<DrillClass>;
}

/** The bulk holes layer: one Circle per plan hole, coloured by selection/drilled
 *  state. Memoised so frequent re-renders of the canvas (mouse hover, GRBL polling)
 *  don't reconcile the whole hole set — it only re-renders when the plan, the
 *  selection/drilled sets, or class visibility actually change. Per-hole rings
 *  (hover / inspected / current-phase) live in cheap single-node overlays instead,
 *  so they never force this layer to re-render. */
const HolesLayer = memo(function HolesLayer({
  plan,
  selectedHoleIds,
  drilledHoleIds,
  visibleClasses,
}: HolesLayerProps) {
  return (
    <>
      {enumerateHoles(plan).map((eh) => {
        if (visibleClasses && !visibleClasses.has(eh.class)) return null;
        const h = eh.hole;
        const r = Math.max(eh.diameterMm / 2, 0.1);
        const isSelected = selectedHoleIds ? selectedHoleIds.has(eh.id) : true;
        const isDrilled = drilledHoleIds ? drilledHoleIds.has(eh.id) : false;
        const color = groupColor(eh.gi);
        const holeFill = isDrilled ? "rgba(34,197,94,0.5)" : "rgba(0,0,0,0.6)";
        return (
          <Circle
            key={eh.id}
            x={h.xMm}
            y={h.yMm}
            radius={r}
            stroke={isSelected ? color : "#334155"}
            strokeWidth={HOLE_STROKE_PX}
            strokeScaleEnabled={false}
            fill={holeFill}
            opacity={isSelected ? 1 : 0.25}
            listening={false}
          />
        );
      })}
    </>
  );
});

interface RouteOverlayProps {
  route: DrillRoute;
  visibleClasses?: Set<DrillClass>;
  showDiameters: boolean;
}

/** Tool-change rings (one per route group's first hole) plus optional diameter
 *  labels. Memoised on the route + visibility so it stays out of the hover/poll
 *  re-render path. */
const RouteOverlay = memo(function RouteOverlay({ route, visibleClasses, showDiameters }: RouteOverlayProps) {
  return (
    <>
      {route.groups.map((g: RouteGroup, gi: number) => {
        if (visibleClasses && !visibleClasses.has(g.class)) return null;
        const color = groupColor(gi);
        const firstHole = g.orderedHoles[0];
        const r = g.diameterMm / 2;
        if (!firstHole) return null;
        return (
          <Group key={`tc-${gi}`} listening={false}>
            <Circle
              x={firstHole.xMm}
              y={firstHole.yMm}
              radius={r + TOOL_CHANGE_RING_OFFSET_MM}
              stroke={color}
              strokeWidth={TOOL_CHANGE_RING_PX}
              strokeScaleEnabled={false}
              fill={undefined}
              opacity={0.6}
            />
            {showDiameters && (
              <Text
                x={firstHole.xMm + r + 0.3}
                y={firstHole.yMm - Math.max(g.diameterMm * 0.3, 0.25)}
                text={`⌀${g.diameterMm}`}
                fontSize={Math.min(Math.max(g.diameterMm * 0.6, 0.5), 2.5)}
                fill="rgba(203,213,225,0.75)"
                listening={false}
              />
            )}
          </Group>
        );
      })}
    </>
  );
});

interface PathOverlayProps {
  route: DrillRoute;
  showPath: boolean;
  drilledHoleIds?: Set<string>;
}

/** Traverse path drawn under the holes. When holes have been drilled it splits
 *  into a traversed (copper) and remaining (dim) segment. Memoised on the route +
 *  drilled set so panning/hover don't recompute the flattened point arrays. */
const PathOverlay = memo(function PathOverlay({ route, showPath, drilledHoleIds }: PathOverlayProps) {
  // Flat path array for Konva Line (panel mm coords).
  const pathFlat = useMemo(() => route.pathPoints.flatMap((h) => [h.xMm, h.yMm]), [route.pathPoints]);
  // Map ordered hole N → index in route.pathPoints (by coord match).
  const holeToPathIdx = useMemo(() => buildHoleToPathIndex(route), [route]);
  // Count of drilled holes in route order (prefix of route holes all drilled).
  const holesCompletedCount = useMemo(() => {
    if (!drilledHoleIds || drilledHoleIds.size === 0) return 0;
    const holes = orderedHoleList(route);
    let count = 0;
    for (const h of holes) {
      if (h.id && drilledHoleIds.has(h.id)) count++;
      else break;
    }
    return count;
  }, [drilledHoleIds, route]);
  // Index where the drilled portion ends and the remaining begins.
  const splitPathIdx = useMemo(() => {
    if (holesCompletedCount <= 0) return 0;
    const i = holeToPathIdx[holesCompletedCount];
    return i != null && i >= 0 ? i : route.pathPoints.length;
  }, [holesCompletedCount, holeToPathIdx, route.pathPoints.length]);

  if (!showPath || pathFlat.length < 4) return null;

  if (holesCompletedCount <= 0) {
    // Nothing drilled yet — single dim path.
    return (
      <Line
        points={pathFlat}
        stroke="rgba(255,255,255,0.12)"
        strokeWidth={PATH_STROKE_PX}
        strokeScaleEnabled={false}
        lineJoin="round"
        lineCap="round"
        listening={false}
      />
    );
  }
  // Some holes drilled: split at splitPathIdx. Include the split point in both
  // slices so segments connect seamlessly.
  const traversedPts = route.pathPoints.slice(0, splitPathIdx + 1).flatMap((h) => [h.xMm, h.yMm]);
  const remainingPts = route.pathPoints.slice(splitPathIdx).flatMap((h) => [h.xMm, h.yMm]);
  return (
    <>
      {traversedPts.length >= 4 && (
        <Line
          points={traversedPts}
          stroke="#b87333"
          opacity={0.55}
          strokeWidth={PATH_STROKE_PX}
          strokeScaleEnabled={false}
          lineJoin="round"
          lineCap="round"
          listening={false}
        />
      )}
      {remainingPts.length >= 4 && (
        <Line
          points={remainingPts}
          stroke="#ffffff"
          opacity={0.18}
          strokeWidth={PATH_STROKE_PX}
          strokeScaleEnabled={false}
          lineJoin="round"
          lineCap="round"
          listening={false}
        />
      )}
    </>
  );
});

export interface DrillMapCanvasProps {
  /** Panel width in mm. */
  widthMm: number;
  /** Panel height in mm. */
  heightMm: number;
  /** Full (unfiltered) plan — all holes are rendered from this. */
  plan: PanelDrillPlan;
  /** Route built from selected holes only — drives path overlay + tool-change rings. */
  route: DrillRoute;
  /** Keep-out zones in panel-space mm (optional). */
  zones?: { x: number; y: number; w: number; h: number }[];
  /** Live machine WORK position (mm), or null to hide the marker. Optional z is
   *  shown in the marker readout. */
  machineWork?: { x: number; y: number; z?: number } | null;
  /** Which panel corner is machine (0,0). Defaults to "bottom-left". */
  datum?: DatumCorner;
  /** Stable hole ids of the holes included in the run selection. Unselected holes
   *  are rendered dimmed so the operator can see what is excluded. */
  selectedHoleIds?: Set<string>;
  /** Stable hole ids of holes already drilled in this session (shown green). */
  drilledHoleIds?: Set<string>;
  /** Stable id of the hole currently being drilled (drives the phase-ring). */
  currentHoleId?: string | null;
  /** Set of drill classes that are VISIBLE on the canvas. Holes whose class is NOT
   *  in this set are skipped entirely (not rendered). Defaults to all classes visible. */
  visibleClasses?: Set<DrillClass>;
  /** Whether to render the traverse path line. Defaults to true. */
  showPath?: boolean;
  /** Whether to render a diameter label near the first hole of each visible group.
   *  Defaults to false. */
  showDiameters?: boolean;
  /** Smoothed three-phase progress (descent / drilling / retract) for the
   *  currently-drilling hole. Drives the three coloured ring segments around it. */
  currentHolePhase?: PhaseProgress;
  /** Called on every viewport change (pan, zoom, animate frame) so rulers
   *  can follow the canvas transform without prop drilling into the Stage. */
  onViewportChange?: (v: Viewport) => void;
  /** Called when the user clicks a hole — toggles its selection state. */
  onToggleHole?: (id: string) => void;
  /** Called when the user clicks a hole to surface its id for the detail card. */
  onInspectHole?: (id: string | null) => void;
  /** Stable id of the inspected hole (drives the copper selection ring). */
  inspectedHoleId?: string | null;
}

/** Read-only 2D drill map canvas: panel outline, holes by tool colour, traverse
 *  path, tool-change markers at each group's first hole, and a machine-origin
 *  indicator. Hole coordinates are panel-space mm (0,0 = top-left of blank). The
 *  work-zero marker is placed at the chosen datum corner (default: bottom-left).
 *  Supports pinch/scroll zoom and Space-to-pan, mirroring PanelBlankCanvas. */
export function DrillMapCanvas({ widthMm, heightMm, plan, route, zones, machineWork, datum = "bottom-left", selectedHoleIds, drilledHoleIds, currentHoleId, visibleClasses, showPath = true, showDiameters = false, currentHolePhase, onViewportChange, onToggleHole, onInspectHole, inspectedHoleId }: DrillMapCanvasProps) {
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

  // Per-hole geometry by stable id — lets the single-node overlay rings (hover /
  // inspected / current-phase) look up coordinates without re-rendering the bulk
  // holes layer. Recomputed only when the plan changes.
  const holeIndex = useMemo(() => {
    const m = new Map<string, HoleGeom>();
    for (const eh of enumerateHoles(plan)) {
      m.set(eh.id, { xMm: eh.hole.xMm, yMm: eh.hole.yMm, r: Math.max(eh.diameterMm / 2, 0.1) });
    }
    return m;
  }, [plan]);

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

          // Compute hovered hole id via fit-group relative pointer → mm (all plan holes).
          const fitGroup = fitGroupRef.current;
          if (fitGroup && viewport.pxPerMm > 0) {
            const rel = fitGroup.getRelativePointerPosition();
            if (rel) {
              const hit = nearestPlanHole({ x: rel.x, y: rel.y }, plan, viewport.pxPerMm);
              const nextKey = hit ? hit.id : null;
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
          // Hit-test over all plan holes (not just selected/route subset).
          const hit = nearestPlanHole({ x: rel.x, y: rel.y }, plan, viewport.pxPerMm);
          if (hit) {
            onToggleHole?.(hit.id);
            onInspectHole?.(hit.id);
          } else {
            onInspectHole?.(null);
          }
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

            {/* Traverse path under the holes (memoised; splits into drilled/remaining). */}
            <PathOverlay route={route} showPath={showPath} drilledHoleIds={drilledHoleIds} />

            {/* Tool-change rings + diameter labels driven by the ROUTE (memoised). */}
            <RouteOverlay route={route} visibleClasses={visibleClasses} showDiameters={showDiameters} />

            {/* Bulk holes layer (memoised — isolated from hover/poll re-renders). */}
            <HolesLayer
              plan={plan}
              selectedHoleIds={selectedHoleIds}
              drilledHoleIds={drilledHoleIds}
              visibleClasses={visibleClasses}
            />

            {/* Single-node overlay rings drawn on top of the holes layer. Each is a
                cheap lookup by stable id, so hover/inspect/run progress never force
                the whole hole set to re-render. */}
            {/* Inspection ring — copper, for the inspected hole. */}
            {inspectedHoleId &&
              (() => {
                const g = holeIndex.get(inspectedHoleId);
                if (!g) return null;
                return (
                  <Circle
                    x={g.xMm}
                    y={g.yMm}
                    radius={g.r + SELECT_RING_OFFSET_MM}
                    stroke={SELECT_RING_COLOR}
                    strokeWidth={2}
                    strokeScaleEnabled={false}
                    fill={undefined}
                    listening={false}
                  />
                );
              })()}
            {/* Hover highlight ring — subtle white, only when not the inspected hole. */}
            {hoveredHoleKey &&
              hoveredHoleKey !== inspectedHoleId &&
              (() => {
                const g = holeIndex.get(hoveredHoleKey);
                if (!g) return null;
                return (
                  <Circle
                    x={g.xMm}
                    y={g.yMm}
                    radius={g.r + HOVER_RING_OFFSET_MM}
                    stroke="rgba(255,255,255,0.45)"
                    strokeWidth={1}
                    strokeScaleEnabled={false}
                    fill={undefined}
                    listening={false}
                  />
                );
              })()}
            {/* Three-phase progress ring for the currently-drilling hole. */}
            {currentHoleId &&
              !drilledHoleIds?.has(currentHoleId) &&
              (() => {
                const g = holeIndex.get(currentHoleId);
                if (!g) return null;
                const r = g.r;
                return (["descent", "drilling", "retract"] as const).map((ph, si) => {
                  const frac = Math.max(0, Math.min(1, currentHolePhase?.[ph] ?? 0));
                  const segStart = -90 + si * 120;
                  return (
                    <Group key={ph} listening={false}>
                      <Arc
                        x={g.xMm}
                        y={g.yMm}
                        innerRadius={r + 0.45}
                        outerRadius={r + 0.75}
                        angle={120}
                        rotation={segStart}
                        fill={PHASE_COLORS[ph]}
                        opacity={0.18}
                        listening={false}
                      />
                      {frac > 0 && (
                        <Arc
                          x={g.xMm}
                          y={g.yMm}
                          innerRadius={r + 0.45}
                          outerRadius={r + 0.75}
                          angle={120 * frac}
                          rotation={segStart}
                          fill={PHASE_COLORS[ph]}
                          listening={false}
                        />
                      )}
                    </Group>
                  );
                });
              })()}
            {/* Machine-origin indicator — INSIDE the fit-group (mm space) so it
                shares the holes' stage∘fit transform exactly (no double-applied
                stage transform). Pixel sizes are divided by pxPerMm to stay
                constant on screen. */}
            {viewport.pxPerMm > 0 && (() => {
              const { xMm: dxMm, yMm: dyMm } = datumCornerPanelPoint(datum, W, H);
              const k = 1 / viewport.pxPerMm;
              const axis = AXIS_PX * k;
              return (
                <Group x={dxMm} y={dyMm} listening={false}>
                  <Arrow
                    points={[0, 0, axis, 0]}
                    stroke={AXIS_COLOR}
                    fill={AXIS_COLOR}
                    strokeWidth={1.2}
                    strokeScaleEnabled={false}
                    pointerLength={5 * k}
                    pointerWidth={5 * k}
                  />
                  <Arrow
                    points={[0, 0, 0, -axis]}
                    stroke={AXIS_COLOR}
                    fill={AXIS_COLOR}
                    strokeWidth={1.2}
                    strokeScaleEnabled={false}
                    pointerLength={5 * k}
                    pointerWidth={5 * k}
                  />
                  <Circle x={0} y={0} radius={2.5 * k} fill="#f59e0b" />
                  <Text x={axis + 3 * k} y={-6 * k} text="X" fontSize={11 * k} fill={AXIS_COLOR} />
                  <Text x={-11 * k} y={-axis - 5 * k} text="Y" fontSize={11 * k} fill={AXIS_COLOR} />
                  <Text x={5 * k} y={4 * k} text="0,0" fontSize={10 * k} fill={AXIS_COLOR} />
                </Group>
              );
            })()}

            {/* Live machine-position marker — INSIDE the fit-group (mm space), same
                transform as the holes; constant on-screen size via pxPerMm. */}
            {machineWork && viewport.pxPerMm > 0 && (() => {
              const p = workPosToPanel(machineWork.x, machineWork.y, H, datum, W);
              return (
                <MachineMarker
                  xMm={p.xMm}
                  yMm={p.yMm}
                  pxPerMm={viewport.pxPerMm}
                  workX={machineWork.x}
                  workY={machineWork.y}
                  workZ={machineWork.z}
                />
              );
            })()}
          </Group>
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

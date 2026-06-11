import { useRef, useState } from "react";
import { Stage, Layer, Group, Rect, Line, Circle, Arrow, Text } from "react-konva";
import Konva from "konva";
import { ZoomToolbar, ZOOM_STEP } from "@/components/ui/ZoomToolbar";
import type { Poly, MillHotspot } from "@/lib/api";
import { type DatumCorner, datumCornerPanelPoint } from "@/lib/datum";
import { AdaptiveGrid } from "@/components/editor/AdaptiveGrid";
import { RULER_LEFT, RULER_TOP } from "@/components/editor/canvasStyle";
import { RulersOverlay } from "@/components/editor/RulersOverlay";
import { useKonvaViewport } from "@/hooks/useKonvaViewport";
import { useUnitFormat } from "@/i18n/useUnitFormat";
import { MachineMarker } from "@/components/drill/MachineMarker";
import { workPosToPanel } from "@/lib/machineMarker";
import { DrillCanvasToolPalette } from "@/components/drill/DrillCanvasToolPalette";

/** Isolation toolpath stroke colour (cyan) and width (px, screen-space). */
const PATH_COLOR = "#22d3ee";
const PATH_STROKE_PX = 1.0;

/** DFM violation marker colour (red) — gaps too narrow for the bit to isolate. */
const VIOLATION_COLOR = "#f43f5e";
const VIOLATION_STROKE_PX = 1.6;

/** Machine-origin axis indicator length (px, screen-space) + colour. */
const AXIS_PX = 30;
const AXIS_COLOR = "#94a3b8";

export interface MillMapCanvasProps {
  /** Panel width in mm (the world size — paths/violations are panel-space). */
  widthMm: number;
  /** Panel height in mm. */
  heightMm: number;
  /** Isolation toolpaths (panel-space mm, Y down, origin 0,0 top-left — the
   *  backend already projects every instance into panel space, so they draw
   *  straight over the panel outline). */
  paths: Poly[];
  /** Copper gaps too narrow for the bit to isolate (two closest mm points each). */
  violations: MillHotspot[];
  /** Which panel corner is machine (0,0). Defaults to "bottom-left". */
  datum?: DatumCorner;
  /** Live machine WORK position (mm), or null to hide the marker. */
  machineWork?: { x: number; y: number; z?: number } | null;
}

/** Read-only 2D isolation-milling preview canvas: panel outline, isolation
 *  toolpaths (cyan polylines), DFM violation markers (red), a machine-origin
 *  indicator and the live machine marker. Mirrors DrillMapCanvas (shared viewport,
 *  rulers, grid, datum, marker); the geometry differs — closed cut contours instead
 *  of holes. Coordinates are panel space (mm, Y down, origin 0,0 top-left) — the
 *  backend projects every placed instance into panel space, so paths draw straight
 *  over the `[0,0,W,H]` panel outline with no extra flip. */
export function MillMapCanvas({
  widthMm,
  heightMm,
  paths,
  violations,
  datum = "bottom-left",
  machineWork,
}: MillMapCanvasProps) {
  const fitGroupRef = useRef<Konva.Group>(null);
  const W = Math.max(widthMm, 1);
  const H = Math.max(heightMm, 1);
  const {
    containerRef, stageRef, size, fit, viewport, zoomPct, spaceDown,
    syncViewport, fitView, onWheel, zoomButton, dragBoundFunc,
  } = useKonvaViewport({ worldW: W, worldH: H, rulerLeft: RULER_LEFT, rulerTop: RULER_TOP });
  const [tool, setTool] = useState<"select" | "pan">("select");
  const panMode = tool === "pan" || spaceDown;
  const { fmtLen } = useUnitFormat();
  const [hoverPx, setHoverPx] = useState<{ x: number; y: number } | null>(null);

  // Datum-derived rulers configuration (same recipe as DrillMapCanvas): the panel
  // always reads 0→W and 0→H from the datum corner toward the opposite edge.
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
          setHoverPx(pos ? { x: pos.x, y: pos.y } : null);
        }}
        onMouseLeave={() => setHoverPx(null)}
      >
        <Layer>
          {/* The fit-group maps mm → px at scale 1; the Stage carries pan/zoom. */}
          <Group ref={fitGroupRef} x={0} y={0} scaleX={fit} scaleY={fit}>
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

            {/* Isolation toolpaths: each ring (outer + holes) as a closed cyan polyline. */}
            {paths.map((poly, pi) => (
              <Group key={`path-${pi}`} listening={false}>
                <Line
                  points={poly.outer.flatMap(([x, y]) => [x, y])}
                  stroke={PATH_COLOR}
                  strokeWidth={PATH_STROKE_PX}
                  strokeScaleEnabled={false}
                  closed
                  lineJoin="round"
                  lineCap="round"
                  listening={false}
                />
                {poly.holes.map((ring, hi) => (
                  <Line
                    key={`hole-${hi}`}
                    points={ring.flatMap(([x, y]) => [x, y])}
                    stroke={PATH_COLOR}
                    strokeWidth={PATH_STROKE_PX}
                    strokeScaleEnabled={false}
                    closed
                    lineJoin="round"
                    lineCap="round"
                    listening={false}
                  />
                ))}
              </Group>
            ))}

            {/* DFM violations: short red segment between the two closest copper points
                plus a ring at the midpoint (a bit this wide bridges the gap → short). */}
            {violations.map((v, vi) => {
              const [ax, ay] = v.a;
              const [bx, by] = v.b;
              const mx = (ax + bx) / 2;
              const my = (ay + by) / 2;
              const r = viewport.pxPerMm > 0 ? 4 / viewport.pxPerMm : 0.3;
              return (
                <Group key={`viol-${vi}`} listening={false}>
                  <Line
                    points={[ax, ay, bx, by]}
                    stroke={VIOLATION_COLOR}
                    strokeWidth={VIOLATION_STROKE_PX}
                    strokeScaleEnabled={false}
                    lineCap="round"
                    listening={false}
                  />
                  <Circle
                    x={mx}
                    y={my}
                    radius={r}
                    stroke={VIOLATION_COLOR}
                    strokeWidth={VIOLATION_STROKE_PX}
                    strokeScaleEnabled={false}
                    fill="rgba(244,63,94,0.18)"
                    listening={false}
                  />
                </Group>
              );
            })}

            {/* Machine-origin indicator at the datum corner (mm space). */}
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

            {/* Live machine-position marker (mm space; constant on-screen size). */}
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
                  panelWidthMm={W}
                />
              );
            })()}
          </Group>
        </Layer>
      </Stage>

      {/* Floating left-side tool palette (select / pan). */}
      <DrillCanvasToolPalette tool={tool} onToolChange={setTool} />

      {/* Edge-pinned rulers SVG overlay. */}
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

      <ZoomToolbar
        zoomPct={zoomPct}
        onZoomOut={() => zoomButton(1 / ZOOM_STEP)}
        onZoomIn={() => zoomButton(ZOOM_STEP)}
        onReset={fitView}
        onFit={fitView}
      />
    </div>
  );
}

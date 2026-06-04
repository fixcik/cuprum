import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer, Group, Rect, Circle, Line } from "react-konva";
import type { PanelDrillPlan } from "@/lib/panelDrill";
import type { DrillRoute, RouteGroup } from "@/lib/drillRoute";

/** Palette of distinct colours for drill groups, cycling when there are more groups than colours. */
const GROUP_PALETTE = [
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

function groupColor(index: number): string {
  return GROUP_PALETTE[index % GROUP_PALETTE.length];
}

/** Minimum margin (px) around the panel inside the canvas. */
const MARGIN_PX = 24;

/** Circle stroke width (px, screen-space). */
const HOLE_STROKE_PX = 1.2;

/** Path line width (px, screen-space). */
const PATH_STROKE_PX = 0.8;

/** Tool-change marker outer ring radius offset (mm) added on top of hole radius. */
const TOOL_CHANGE_RING_OFFSET_MM = 0.6;

/** Tool-change marker ring stroke (px, screen-space). */
const TOOL_CHANGE_RING_PX = 1.8;

export interface DrillMapCanvasProps {
  /** Panel width in mm. */
  widthMm: number;
  /** Panel height in mm. */
  heightMm: number;
  plan: PanelDrillPlan;
  route: DrillRoute;
  /** Optional live-run progress for highlight overlay. When absent the canvas
   *  renders exactly as it did before (no visual change). */
  progress?: { holesCompleted: number; currentHoleIndex: number | null };
}

/** Read-only 2D drill map canvas: panel outline, holes by tool colour, traverse
 *  path, and tool-change markers at each group's first hole.
 *  Coordinates are in panel-space mm (0,0 = top-left of blank). */
export function DrillMapCanvas({ widthMm, heightMm, plan: _plan, route, progress }: DrillMapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 400, h: 300 });

  // Track container size for the fit calculation.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const W = Math.max(widthMm, 1);
  const H = Math.max(heightMm, 1);

  // Scale to fit the panel in the canvas with a margin on all sides.
  const fit = useMemo(
    () => Math.min((size.w - MARGIN_PX * 2) / W, (size.h - MARGIN_PX * 2) / H),
    [size.w, size.h, W, H],
  );

  // Offset so the panel is centered in the canvas.
  const offsetX = (size.w - W * fit) / 2;
  const offsetY = (size.h - H * fit) / 2;

  // Flat path array for the Konva Line (panel mm coords, flattened x0,y0,x1,y1,…).
  const pathFlat = useMemo(
    () => route.pathPoints.flatMap((h) => [h.xMm, h.yMm]),
    [route.pathPoints],
  );

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-[#0a0c10]">
      <Stage width={size.w} height={size.h}>
        <Layer>
          {/* The fit-group maps mm directly to screen pixels via the fit scale. */}
          <Group x={offsetX} y={offsetY} scaleX={fit} scaleY={fit}>
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

            {/* Traverse path drawn UNDER the holes. */}
            {pathFlat.length >= 4 && (
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

            {/* Holes per group with distinct colour; first hole of each group gets a
                tool-change ring marker. A running global index gIdx tracks position
                across groups (same flattening order as route.pathPoints) to apply
                progress highlights when the `progress` prop is present. */}
            {(() => {
              let gIdx = 0;
              return route.groups.map((g: RouteGroup, gi: number) => {
                const color = groupColor(gi);
                return g.orderedHoles.map((h, hi) => {
                  const currentGIdx = gIdx++;
                  const r = g.diameterMm / 2;
                  const isToolChange = hi === 0;

                  // Determine per-hole highlight state (only when progress is provided).
                  const isDrilled =
                    progress !== undefined && currentGIdx < progress.holesCompleted;
                  const isCurrent =
                    progress !== undefined &&
                    progress.currentHoleIndex !== null &&
                    currentGIdx === progress.currentHoleIndex;
                  const showCurrent = isCurrent && !isDrilled;

                  const holeFill = isDrilled
                    ? "rgba(34,197,94,0.5)"   // green, reduced opacity
                    : "rgba(0,0,0,0.6)";       // default

                  return (
                    <Group key={`${gi}-${hi}`} listening={false}>
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
                      {/* Highlight ring for the currently-drilling hole. */}
                      {showCurrent && (
                        <Circle
                          x={h.xMm}
                          y={h.yMm}
                          radius={r + 0.6}
                          stroke="#22c55e"
                          strokeWidth={2}
                          strokeScaleEnabled={false}
                          fill={undefined}
                        />
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
        </Layer>
      </Stage>
    </div>
  );
}

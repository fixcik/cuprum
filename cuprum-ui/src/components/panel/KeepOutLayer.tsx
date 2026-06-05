import { Group, Rect, Line } from "react-konva";
import type { KonvaEventObject } from "konva/lib/Node";
import {
  KEEPOUT_FIXTURE_FILL,
  KEEPOUT_FIXTURE_STROKE,
  KEEPOUT_SELECTED_STROKE,
} from "@/components/editor/canvasStyle";
import type { KeepOutZone } from "@/lib/api";

export type ZoneCorner = "tl" | "tr" | "bl" | "br";

const ZONE_FILL = KEEPOUT_FIXTURE_FILL;
const ZONE_STROKE = KEEPOUT_FIXTURE_STROKE;

/** Konva layer rendering keep-out zones inside the mm fit-group, below board
 *  instances. Each zone is a tinted/hatched rect with a type label and, when
 *  selected, an extra copper selection outline. */
export function KeepOutLayer({
  zones,
  selected,
  dragDelta,
  pxPerMm,
  interactive,
  onZoneMouseDown,
  onZoneDragMove,
  onZoneDragEnd,
  resizePreview,
  onHandleMouseDown,
}: {
  zones: KeepOutZone[];
  selected: Set<string>;
  /** Live drag delta (mm) — applied while a drag is in progress. */
  dragDelta: { dx: number; dy: number } | null;
  pxPerMm: number;
  interactive: boolean;
  onZoneMouseDown?: (id: string, e: KonvaEventObject<MouseEvent>) => void;
  onZoneDragMove?: (id: string, e: KonvaEventObject<DragEvent>) => void;
  onZoneDragEnd?: (id: string, e: KonvaEventObject<DragEvent>) => void;
  /** Live resize preview for ONE zone (mm box). When set for a zone id, that zone
   *  renders at the preview rect instead of its committed pose. */
  resizePreview?: { id: string; x_mm: number; y_mm: number; width_mm: number; height_mm: number } | null;
  onHandleMouseDown?: (id: string, corner: ZoneCorner, e: KonvaEventObject<MouseEvent>) => void;
}) {
  // Screen-size scale factor: 1 / pxPerMm converts screen px to mm.
  const k = pxPerMm > 0 ? 1 / pxPerMm : 0;
  // Selection outset (screen px → mm) for the outer copper ring.
  const selOutset = 2 * k;
  // Hatch line spacing (mm) — fixed density scaled by screen px.
  const hatchSpacing = Math.max(3 * k, 0.5);

  return (
    <>
      {zones.map((zone) => {
        const isSelected = selected.has(zone.id);

        // Determine displayed geometry: resize preview overrides committed pose.
        const isResizing = resizePreview?.id === zone.id;
        const displayX = isResizing ? resizePreview!.x_mm : zone.x_mm + (isSelected && dragDelta ? dragDelta.dx : 0);
        const displayY = isResizing ? resizePreview!.y_mm : zone.y_mm + (isSelected && dragDelta ? dragDelta.dy : 0);
        const displayW = isResizing ? resizePreview!.width_mm : zone.width_mm;
        const displayH = isResizing ? resizePreview!.height_mm : zone.height_mm;

        const fill = ZONE_FILL;
        const stroke = ZONE_STROKE;

        // Build diagonal hatch lines clipped to the displayed rect.
        const hatchLines: number[][] = [];
        const steps = Math.ceil((displayW + displayH) / hatchSpacing) + 1;
        for (let i = 0; i < steps; i++) {
          const offset = i * hatchSpacing;
          const x1 = Math.min(offset, displayW);
          const y1 = Math.max(0, offset - displayW);
          const x2 = Math.max(0, offset - displayH);
          const y2 = Math.min(offset, displayH);
          if (Math.abs(x1 - x2) > 1e-6 || Math.abs(y1 - y2) > 1e-6) {
            hatchLines.push([x1, y1, x2, y2]);
          }
        }

        // Corner handle side (constant screen size).
        const hs = 7 * k;

        // Corner positions in the group's local coords (relative to displayed origin).
        const corners: { corner: ZoneCorner; cx: number; cy: number; cursor: string }[] = [
          { corner: "tl", cx: 0,        cy: 0,        cursor: "nwse-resize" },
          { corner: "tr", cx: displayW, cy: 0,        cursor: "nesw-resize" },
          { corner: "bl", cx: 0,        cy: displayH, cursor: "nesw-resize" },
          { corner: "br", cx: displayW, cy: displayH, cursor: "nwse-resize" },
        ];

        return (
          <Group
            key={zone.id}
            x={displayX}
            y={displayY}
            listening={interactive}
            draggable={interactive && !isResizing}
            onMouseDown={
              interactive && onZoneMouseDown ? (e) => onZoneMouseDown(zone.id, e) : undefined
            }
            onTap={
              interactive && onZoneMouseDown
                ? (e) => onZoneMouseDown(zone.id, e as unknown as KonvaEventObject<MouseEvent>)
                : undefined
            }
            onDragMove={
              interactive && onZoneDragMove ? (e) => onZoneDragMove(zone.id, e) : undefined
            }
            onDragEnd={
              interactive && onZoneDragEnd ? (e) => onZoneDragEnd(zone.id, e) : undefined
            }
          >
            {/* Invisible hit target covers the whole rect for click/drag. */}
            {interactive && (
              <Rect
                width={displayW}
                height={displayH}
                fill="transparent"
                listening
              />
            )}

            {/* Selection outline (copper, outside the zone). */}
            {isSelected && selOutset > 0 && (
              <Rect
                x={-selOutset}
                y={-selOutset}
                width={displayW + 2 * selOutset}
                height={displayH + 2 * selOutset}
                stroke={KEEPOUT_SELECTED_STROKE}
                strokeWidth={1.5}
                strokeScaleEnabled={false}
                listening={false}
              />
            )}

            {/* Zone background fill. */}
            <Rect
              width={displayW}
              height={displayH}
              fill={fill}
              stroke={stroke}
              strokeWidth={1}
              strokeScaleEnabled={false}
              dash={[3, 2]}
              listening={false}
            />

            {/* Diagonal hatch lines clipped inside the rect via clip. */}
            <Group
              clipX={0}
              clipY={0}
              clipWidth={displayW}
              clipHeight={displayH}
              listening={false}
            >
              {hatchLines.map((pts, i) => (
                <Line
                  key={i}
                  points={pts}
                  stroke={stroke}
                  strokeWidth={0.5}
                  strokeScaleEnabled={false}
                  opacity={0.45}
                  listening={false}
                />
              ))}
            </Group>


            {/* Corner resize handles — rendered on top, only when selected. */}
            {interactive && isSelected && corners.map(({ corner, cx, cy, cursor }) => (
              <Rect
                key={corner}
                x={cx - hs / 2}
                y={cy - hs / 2}
                width={hs}
                height={hs}
                fill={KEEPOUT_SELECTED_STROKE}
                strokeScaleEnabled={false}
                listening
                onMouseDown={(e) => {
                  e.cancelBubble = true;
                  onHandleMouseDown?.(zone.id, corner, e);
                }}
                onTap={(e) => {
                  e.cancelBubble = true;
                  onHandleMouseDown?.(zone.id, corner, e as unknown as KonvaEventObject<MouseEvent>);
                }}
                onMouseEnter={(e) => {
                  const stage = e.target.getStage();
                  if (stage) stage.container().style.cursor = cursor;
                }}
                onMouseLeave={(e) => {
                  const stage = e.target.getStage();
                  if (stage) stage.container().style.cursor = "default";
                }}
              />
            ))}
          </Group>
        );
      })}
    </>
  );
}

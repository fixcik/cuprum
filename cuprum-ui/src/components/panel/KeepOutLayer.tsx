import { Group, Rect, Text, Line } from "react-konva";
import type { KonvaEventObject } from "konva/lib/Node";
import {
  KEEPOUT_FIXTURE_FILL,
  KEEPOUT_FIXTURE_STROKE,
  KEEPOUT_DEAD_FILL,
  KEEPOUT_DEAD_STROKE,
  KEEPOUT_RESERVED_FILL,
  KEEPOUT_RESERVED_STROKE,
  KEEPOUT_SELECTED_STROKE,
} from "@/components/editor/canvasStyle";
import type { KeepOutKind, KeepOutZone } from "@/lib/api";

/** Resolve fill/stroke colours for a keep-out kind. */
function kindColors(kind: KeepOutKind): { fill: string; stroke: string } {
  switch (kind) {
    case "dead":
      return { fill: KEEPOUT_DEAD_FILL, stroke: KEEPOUT_DEAD_STROKE };
    case "reserved":
      return { fill: KEEPOUT_RESERVED_FILL, stroke: KEEPOUT_RESERVED_STROKE };
    default:
      return { fill: KEEPOUT_FIXTURE_FILL, stroke: KEEPOUT_FIXTURE_STROKE };
  }
}

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
}) {
  // Screen-size scale factor: 1 / pxPerMm converts screen px to mm.
  const k = pxPerMm > 0 ? 1 / pxPerMm : 0;
  // Selection outset (screen px → mm) for the outer copper ring.
  const selOutset = 2 * k;
  // Hatch line spacing (mm) — fixed density scaled by screen px.
  const hatchSpacing = Math.max(3 * k, 0.5);
  // Font size: at least 2 mm, at most 8% of the zone minor dimension.
  const labelSize = (z: KeepOutZone) => Math.max(Math.min(z.width_mm, z.height_mm) * 0.08, 2);

  return (
    <>
      {zones.map((zone) => {
        const isSelected = selected.has(zone.id);
        const shift = isSelected && dragDelta ? dragDelta : { dx: 0, dy: 0 };
        const x = zone.x_mm + shift.dx;
        const y = zone.y_mm + shift.dy;
        const { fill, stroke } = kindColors(zone.kind);

        // Build diagonal hatch lines clipped to the zone rect.
        const hatchLines: number[][] = [];
        const steps = Math.ceil((zone.width_mm + zone.height_mm) / hatchSpacing) + 1;
        for (let i = 0; i < steps; i++) {
          const offset = i * hatchSpacing;
          // Line goes from (offset, 0) to (0, offset) reflected across the rect.
          const x1 = Math.min(offset, zone.width_mm);
          const y1 = Math.max(0, offset - zone.width_mm);
          const x2 = Math.max(0, offset - zone.height_mm);
          const y2 = Math.min(offset, zone.height_mm);
          if (Math.abs(x1 - x2) > 1e-6 || Math.abs(y1 - y2) > 1e-6) {
            hatchLines.push([x1, y1, x2, y2]);
          }
        }

        return (
          <Group
            key={zone.id}
            x={x}
            y={y}
            listening={interactive}
            draggable={interactive}
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
                width={zone.width_mm}
                height={zone.height_mm}
                fill="transparent"
                listening
              />
            )}

            {/* Selection outline (copper, outside the zone). */}
            {isSelected && selOutset > 0 && (
              <Rect
                x={-selOutset}
                y={-selOutset}
                width={zone.width_mm + 2 * selOutset}
                height={zone.height_mm + 2 * selOutset}
                stroke={KEEPOUT_SELECTED_STROKE}
                strokeWidth={1.5}
                strokeScaleEnabled={false}
                listening={false}
              />
            )}

            {/* Zone background fill. */}
            <Rect
              width={zone.width_mm}
              height={zone.height_mm}
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
              clipWidth={zone.width_mm}
              clipHeight={zone.height_mm}
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

            {/* Kind label — centred, visible when the zone is large enough. */}
            {labelSize(zone) >= 1.5 && (
              <Text
                x={0}
                y={0}
                width={zone.width_mm}
                height={zone.height_mm}
                align="center"
                verticalAlign="middle"
                text={zone.kind}
                fontSize={labelSize(zone)}
                fill={stroke}
                opacity={0.8}
                listening={false}
              />
            )}
          </Group>
        );
      })}
    </>
  );
}

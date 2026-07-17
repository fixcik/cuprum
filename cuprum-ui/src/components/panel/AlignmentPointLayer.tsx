import { Group, Circle, Line } from "react-konva";
import type { KonvaEventObject } from "konva/lib/Node";
import { ALIGN_POINT_STROKE, COPPER_STROKE } from "@/components/editor/canvasStyle";
import type { AlignmentPoint } from "@/lib/api";

/** Konva layer rendering USER alignment points inside the mm fit-group: a blue
 *  ring with a cross, constant screen size. Registration tooling holes act as
 *  alignment points too, but they are already drawn by ToolingHoleLayer — this
 *  layer intentionally renders only the explicit (user-placed) points. */
export function AlignmentPointLayer({
  points,
  selectedId,
  pxPerMm,
  interactive,
  onPointMouseDown,
  onPointDragEnd,
}: {
  points: AlignmentPoint[];
  selectedId: string | null;
  pxPerMm: number;
  interactive: boolean;
  onPointMouseDown?: (id: string, e: KonvaEventObject<MouseEvent>) => void;
  onPointDragEnd?: (id: string, e: KonvaEventObject<DragEvent>) => void;
}) {
  // Convert screen px to mm so rendered elements stay a constant size on screen.
  const k = pxPerMm > 0 ? 1 / pxPerMm : 0;
  // Marker ring radius and crosshair arm half-length in mm (screen px based).
  const ring = 6 * k;
  const arm = 9 * k;
  // Selection ring outset in mm (3 screen px).
  const selOutset = 3 * k;

  return (
    <>
      {points.map((p) => {
        const isSelected = p.id === selectedId;
        return (
          <Group
            key={p.id}
            x={p.x_mm}
            y={p.y_mm}
            listening={interactive}
            draggable={interactive}
            onMouseDown={
              interactive && onPointMouseDown ? (e) => onPointMouseDown(p.id, e) : undefined
            }
            onTap={
              interactive && onPointMouseDown
                ? (e) => onPointMouseDown(p.id, e as unknown as KonvaEventObject<MouseEvent>)
                : undefined
            }
            onDragEnd={
              interactive && onPointDragEnd ? (e) => onPointDragEnd(p.id, e) : undefined
            }
          >
            {/* Invisible hit target — the visual children are listening=false, so
             *  without this filled circle the marker couldn't be clicked/dragged
             *  (same pattern as ToolingHoleLayer). */}
            {interactive && <Circle radius={10 * k} fill="transparent" listening />}

            {/* Selection ring — copper, outside the marker ring */}
            {isSelected && selOutset > 0 && (
              <Circle
                radius={ring + selOutset}
                stroke={COPPER_STROKE}
                strokeWidth={2}
                strokeScaleEnabled={false}
                listening={false}
              />
            )}

            {/* Blue ring */}
            <Circle
              radius={ring}
              stroke={ALIGN_POINT_STROKE}
              strokeWidth={1.5}
              strokeScaleEnabled={false}
              listening={false}
            />

            {/* Cross through the ring */}
            {arm > 0 && (
              <>
                <Line
                  points={[-arm, 0, arm, 0]}
                  stroke={ALIGN_POINT_STROKE}
                  strokeWidth={1}
                  strokeScaleEnabled={false}
                  listening={false}
                />
                <Line
                  points={[0, -arm, 0, arm]}
                  stroke={ALIGN_POINT_STROKE}
                  strokeWidth={1}
                  strokeScaleEnabled={false}
                  listening={false}
                />
              </>
            )}
          </Group>
        );
      })}
    </>
  );
}

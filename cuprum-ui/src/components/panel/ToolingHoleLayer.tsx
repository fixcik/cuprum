import { Group, Circle, Line } from "react-konva";
import type { KonvaEventObject } from "konva/lib/Node";
import { COPPER_STROKE, INSTANCE_OFF_STROKE, INSTANCE_STROKE } from "@/components/editor/canvasStyle";
import type { Severity } from "@/lib/feasibility";
import type { ToolingHole } from "@/lib/api";

/** Konva layer rendering tooling holes inside the mm fit-group. Each hole is a
 *  group positioned at (x_mm, y_mm) in panel coordinates. Visual style varies by
 *  role; the selected hole gets an outer copper ring. */
export function ToolingHoleLayer({
  holes,
  selectedId,
  pxPerMm,
  interactive,
  severityByHole,
  onHoleMouseDown,
  onHoleDragMove,
  onHoleDragEnd,
}: {
  holes: ToolingHole[];
  selectedId: string | null;
  pxPerMm: number;
  interactive: boolean;
  severityByHole?: Map<string, Severity>;
  onHoleMouseDown?: (id: string, e: KonvaEventObject<MouseEvent>) => void;
  onHoleDragMove?: (id: string, e: KonvaEventObject<DragEvent>) => void;
  onHoleDragEnd?: (id: string, e: KonvaEventObject<DragEvent>) => void;
}) {
  // Convert screen px to mm so rendered elements stay a constant size on screen.
  const k = pxPerMm > 0 ? 1 / pxPerMm : 0;
  // Crosshair arm half-length in mm (5 screen px).
  const arm = 5 * k;
  // Selection ring outset in mm (3 screen px).
  const selOutset = 3 * k;

  return (
    <>
      {holes.map((hole) => {
        const r = hole.diameter_mm / 2;
        const isSelected = hole.id === selectedId;
        const isUnused = hole.role === "unused";
        const isFlip = hole.role === "flip";
        const isBlock = severityByHole?.get(hole.id) === "block";

        return (
          <Group
            key={hole.id}
            x={hole.x_mm}
            y={hole.y_mm}
            listening={interactive}
            draggable={interactive}
            opacity={isUnused ? 0.5 : 1}
            onMouseDown={
              interactive && onHoleMouseDown
                ? (e) => onHoleMouseDown(hole.id, e)
                : undefined
            }
            onTap={
              interactive && onHoleMouseDown
                ? (e) => onHoleMouseDown(hole.id, e as unknown as KonvaEventObject<MouseEvent>)
                : undefined
            }
            onDragMove={
              interactive && onHoleDragMove
                ? (e) => onHoleDragMove(hole.id, e)
                : undefined
            }
            onDragEnd={
              interactive && onHoleDragEnd
                ? (e) => onHoleDragEnd(hole.id, e)
                : undefined
            }
          >
            {/* Invisible hit target. Konva hit-tests a Group through its children;
             *  every visual child below is listening=false, so without this filled
             *  circle the hole couldn't be clicked (to select) or dragged — clicks
             *  fell through to the panel background and just added another hole.
             *  Sized to a comfortable target (>= 7 screen px radius) since bores are
             *  tiny (~3 mm). transparent fill stays on the hit graph but invisible. */}
            {interactive && (
              <Circle radius={Math.max(r, 7 * k)} fill="transparent" listening />
            )}

            {/* Selection ring — copper, outside the main circle */}
            {isSelected && selOutset > 0 && (
              <Circle
                radius={r + selOutset}
                stroke={COPPER_STROKE}
                strokeWidth={2}
                strokeScaleEnabled={false}
                listening={false}
              />
            )}

            {/* Main bore circle */}
            <Circle
              radius={r}
              stroke={isBlock ? INSTANCE_OFF_STROKE : INSTANCE_STROKE}
              strokeWidth={isBlock ? 1.8 : 1.2}
              strokeScaleEnabled={false}
              dash={isUnused ? [2, 2] : undefined}
              listening={false}
            />

            {/* Inner ring for "flip" role (secondary concentric ring at 60% radius) */}
            {isFlip && (
              <Circle
                radius={r * 0.6}
                stroke={INSTANCE_STROKE}
                strokeWidth={1}
                strokeScaleEnabled={false}
                listening={false}
              />
            )}

            {/* Crosshair — two lines of constant screen size */}
            {arm > 0 && (
              <>
                <Line
                  points={[-arm, 0, arm, 0]}
                  stroke={INSTANCE_STROKE}
                  strokeWidth={1}
                  strokeScaleEnabled={false}
                  listening={false}
                />
                <Line
                  points={[0, -arm, 0, arm]}
                  stroke={INSTANCE_STROKE}
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

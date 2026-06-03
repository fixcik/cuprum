import { useRef } from "react";
import { Group, Line, Circle } from "react-konva";
import type Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";

const HANDLE_STROKE = "#5b9dff";
const HANDLE_FILL = "#0a0c10";

/** Free-rotation knob for the current panel selection. Drawn in the mm fit-group:
 *  a small circle sitting `radiusMm` above the selection-bbox centre, joined to the
 *  centre by a thin line. Dragging the knob rotates the selection; the angle is the
 *  pointer's bearing about the centre (mm), and the reported value is the DELTA from
 *  the bearing at drag start (so multi-select rotates each instance about its OWN
 *  centre by the same amount). Snap (15°/1°) is applied by the parent via
 *  `e.shiftKey || e.altKey`. The knob position is purely derived from props (the
 *  parent re-renders with a live preview angle); on drag end the parent commits. */
export function RotationHandle({
  cx,
  cy,
  radiusMm,
  pointerMm,
  onRotate,
  onCommit,
}: {
  cx: number;
  cy: number;
  radiusMm: number;
  /** Pointer position in panel mm (via the fit-group's relative pointer). */
  pointerMm: () => { x: number; y: number } | null;
  /** Live rotation delta (deg) since drag start. `fine` = shift/alt held. */
  onRotate: (deltaDeg: number, fine: boolean) => void;
  /** Commit the accumulated rotation as one undo step. */
  onCommit: () => void;
}) {
  // Pointer bearing (deg) about the selection centre at the moment the drag began.
  const startAngle = useRef<number | null>(null);

  const bearing = (): number | null => {
    const p = pointerMm();
    if (!p) return null;
    return (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI;
  };

  const onDragStart = (e: KonvaEventObject<DragEvent>) => {
    e.cancelBubble = true;
    startAngle.current = bearing();
  };

  const onDragMove = (e: KonvaEventObject<DragEvent>) => {
    e.cancelBubble = true;
    // Pin the knob back to its derived pose — movement is driven by the preview
    // angle the parent feeds back through cx/cy/radius, not the Konva drag.
    const node = e.target as Konva.Circle;
    node.x(cx);
    node.y(cy - radiusMm);
    if (startAngle.current === null) return;
    const now = bearing();
    if (now === null) return;
    onRotate(now - startAngle.current, e.evt.shiftKey || e.evt.altKey);
  };

  const onDragEnd = (e: KonvaEventObject<DragEvent>) => {
    e.cancelBubble = true;
    const node = e.target as Konva.Circle;
    node.x(cx);
    node.y(cy - radiusMm);
    startAngle.current = null;
    onCommit();
  };

  return (
    <Group listening>
      <Line
        points={[cx, cy, cx, cy - radiusMm]}
        stroke={HANDLE_STROKE}
        strokeWidth={1}
        strokeScaleEnabled={false}
        listening={false}
      />
      <Circle
        x={cx}
        y={cy - radiusMm}
        radius={4}
        fill={HANDLE_FILL}
        stroke={HANDLE_STROKE}
        strokeWidth={1.5}
        strokeScaleEnabled={false}
        draggable
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
        onMouseEnter={(e) => {
          const stage = e.target.getStage();
          if (stage) stage.container().style.cursor = "grab";
        }}
        onMouseLeave={(e) => {
          const stage = e.target.getStage();
          if (stage) stage.container().style.cursor = "";
        }}
      />
    </Group>
  );
}

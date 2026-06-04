import { useRef } from "react";
import { Group, Line, Circle } from "react-konva";
import type Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";

const HANDLE_STROKE = "#5b9dff";
const HANDLE_FILL = "#0a0c10";

/** Free-rotation knob for the current panel selection. The knob sits just OUTSIDE a
 *  bbox corner (diagonal stub), leaving the top-centre clear for the selection HUD;
 *  rotation is still about the selection-bbox centre `(cx,cy)`. Dragging the knob
 *  rotates the selection by the DELTA of the pointer's bearing about the centre since
 *  drag start (so multi-select rotates each instance about its OWN centre by the same
 *  amount). Snap (15°/1°) is applied by the parent via `e.shiftKey || e.altKey`. The
 *  knob is pinned to its derived pose (parent feeds a live preview angle); on drag end
 *  the parent commits. All coordinates in panel mm. */
export function RotationHandle({
  cx,
  cy,
  anchorX,
  anchorY,
  knobX,
  knobY,
  pointerMm,
  onRotate,
  onCommit,
}: {
  /** Rotation pivot = selection-bbox centre (mm). */
  cx: number;
  cy: number;
  /** Stub line start — the bbox corner the knob hangs off (mm). */
  anchorX: number;
  anchorY: number;
  /** Knob position — corner offset diagonally outward (mm). */
  knobX: number;
  knobY: number;
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
    // angle the parent feeds back through the corner props, not the Konva drag.
    const node = e.target as Konva.Circle;
    node.x(knobX);
    node.y(knobY);
    if (startAngle.current === null) return;
    const now = bearing();
    if (now === null) return;
    onRotate(now - startAngle.current, e.evt.shiftKey || e.evt.altKey);
  };

  const onDragEnd = (e: KonvaEventObject<DragEvent>) => {
    e.cancelBubble = true;
    const node = e.target as Konva.Circle;
    node.x(knobX);
    node.y(knobY);
    startAngle.current = null;
    onCommit();
  };

  return (
    <Group listening>
      <Line
        points={[anchorX, anchorY, knobX, knobY]}
        stroke={HANDLE_STROKE}
        strokeWidth={1}
        strokeScaleEnabled={false}
        listening={false}
      />
      <Circle
        x={knobX}
        y={knobY}
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

import { Group, Circle, Line, Text } from "react-konva";
import type { KonvaEventObject } from "konva/lib/Node";
import { ALIGN_POINT_STROKE, COPPER_STROKE } from "@/components/editor/canvasStyle";
import type { AlignmentPoint } from "@/lib/api";

/** Konva layer rendering alignment points inside the mm fit-group: a blue ring
 *  with a cross, constant screen size. The panel editor passes only the explicit
 *  (user-placed) points — registration tooling holes are already drawn there by
 *  ToolingHoleLayer. The drill map passes the full effective set (fiducials +
 *  user points) with display labels. */
export function AlignmentPointLayer({
  points,
  selectedId,
  pxPerMm,
  interactive,
  labels,
  dimmedIds,
  onPointMouseDown,
  onPointDragEnd,
}: {
  points: AlignmentPoint[];
  selectedId: string | null;
  pxPerMm: number;
  interactive: boolean;
  /** Optional display label per point id, drawn beside the marker (constant
   *  screen size). Used by the drill map so points match the wizard list. */
  labels?: Map<string, string>;
  /** Points rendered dimmed (same opacity as unselected holes) and without a
   *  label — the drill map dims points excluded from the wizard selection. */
  dimmedIds?: Set<string>;
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
        const isDimmed = !isSelected && (dimmedIds?.has(p.id) ?? false);
        return (
          <Group
            key={p.id}
            x={p.x_mm}
            y={p.y_mm}
            // Same dim level as unselected holes in the drill map (0.25).
            opacity={isDimmed ? 0.25 : 1}
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

            {/* Label beside the marker (constant screen size); dimmed points
             *  carry no label — they read as background, like unselected holes. */}
            {!isDimmed && labels?.get(p.id) && k > 0 && (
              <Text
                x={arm + 3 * k}
                y={-5.5 * k}
                text={labels.get(p.id)}
                fontSize={11 * k}
                fontStyle="600"
                fill={ALIGN_POINT_STROKE}
                listening={false}
              />
            )}
          </Group>
        );
      })}
    </>
  );
}

import { Rect } from "react-konva";
import { instanceBounds } from "@/lib/panelPlacement";
import type { BoardInstance } from "@/lib/api";

const SELECT_STROKE = "#5b9dff";

/** Dashed AABB outline around each selected instance (drawn in the mm fit-group). */
export function SelectionOverlay({
  instances,
  sizes,
  selected,
}: {
  instances: BoardInstance[];
  sizes: Record<string, { w: number; h: number }>;
  selected: Set<string>;
}) {
  return (
    <>
      {instances
        .filter((i) => selected.has(i.id) && sizes[i.design_id])
        .map((i) => {
          const sz = sizes[i.design_id];
          const b = instanceBounds({
            xMm: i.x_mm,
            yMm: i.y_mm,
            boardW: sz.w,
            boardH: sz.h,
            rotationDeg: i.rotation_deg,
          });
          return (
            <Rect
              key={i.id}
              x={b.minX}
              y={b.minY}
              width={b.maxX - b.minX}
              height={b.maxY - b.minY}
              stroke={SELECT_STROKE}
              strokeWidth={1.5}
              strokeScaleEnabled={false}
              dash={[4, 3]}
              listening={false}
            />
          );
        })}
    </>
  );
}

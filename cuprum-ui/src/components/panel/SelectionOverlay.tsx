import { Fragment } from "react";
import { Rect, Circle, Line } from "react-konva";
import { instanceBounds } from "@/lib/panelPlacement";
import { COPPER_STROKE } from "@/components/editor/canvasStyle";
import type { BoardInstance } from "@/lib/api";

// Pin marker screen sizes (px), kept constant at any zoom by dividing by pxPerMm.
const PIN_RADIUS_PX = 4;
const PIN_STEM_PX = 7;

/** Copper selection affordance for each selected instance (drawn in the mm
 *  fit-group): a solid copper ring around the AABB plus a copper map-pin above
 *  the top edge. Copper is the ACTION/SELECTION role, so the selection reads
 *  instantly against the neutral structure + content of the canvas. */
export function SelectionOverlay({
  instances,
  sizes,
  selected,
  dragDelta,
  rotPreview,
  pxPerMm,
}: {
  instances: BoardInstance[];
  sizes: Record<string, { w: number; h: number }>;
  selected: Set<string>;
  // Live drag offset (mm) applied to selected instances so the highlight tracks
  // the moving Groups; null/absent when idle.
  dragDelta?: { dx: number; dy: number } | null;
  // Live rotation delta (deg) applied to selected instances during a knob drag.
  rotPreview?: number | null;
  // Screen px per mm — used to keep the pin a constant size at any zoom.
  pxPerMm: number;
}) {
  // mm per screen px; 0 until the viewport is measured → skip the pin (ring only).
  const mmPerPx = pxPerMm > 0 ? 1 / pxPerMm : 0;
  const radiusMm = PIN_RADIUS_PX * mmPerPx;
  const stemMm = PIN_STEM_PX * mmPerPx;
  return (
    <>
      {instances
        .filter((i) => selected.has(i.id) && sizes[i.design_id])
        .map((i) => {
          const sz = sizes[i.design_id];
          const shift = dragDelta && selected.has(i.id) ? dragDelta : { dx: 0, dy: 0 };
          const b = instanceBounds({
            xMm: i.x_mm + shift.dx,
            yMm: i.y_mm + shift.dy,
            boardW: sz.w,
            boardH: sz.h,
            rotationDeg: i.rotation_deg + (rotPreview ?? 0),
          });
          const cx = (b.minX + b.maxX) / 2;
          // Pin sits above the top edge: a short stem up to the filled circle.
          const stemTop = b.minY - stemMm;
          const pinCy = stemTop - radiusMm;
          return (
            <Fragment key={i.id}>
              <Rect
                x={b.minX}
                y={b.minY}
                width={b.maxX - b.minX}
                height={b.maxY - b.minY}
                stroke={COPPER_STROKE}
                strokeWidth={2}
                strokeScaleEnabled={false}
                listening={false}
              />
              {mmPerPx > 0 && (
                <>
                  <Line
                    points={[cx, stemTop, cx, b.minY]}
                    stroke={COPPER_STROKE}
                    strokeWidth={1.5}
                    strokeScaleEnabled={false}
                    listening={false}
                  />
                  <Circle x={cx} y={pinCy} radius={radiusMm} fill={COPPER_STROKE} listening={false} />
                </>
              )}
            </Fragment>
          );
        })}
    </>
  );
}

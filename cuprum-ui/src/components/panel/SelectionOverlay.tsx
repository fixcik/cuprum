import { Fragment } from "react";
import { Rect } from "react-konva";
import { instanceBounds } from "@/lib/panelPlacement";
import { COPPER_STROKE } from "@/components/editor/canvasStyle";
import type { BoardInstance } from "@/lib/api";

// Corner handle screen size (px), kept constant at any zoom by dividing by pxPerMm.
const HANDLE_PX = 7;
// Canvas background — the handle's outline colour (so copper squares read on any art).
const CANVAS_BG = "#0a0c10";

/** Copper selection affordance for each selected instance (drawn in the mm
 *  fit-group): a solid copper ring around the AABB plus four square corner handles.
 *  Copper is the ACTION/SELECTION role, so the selection reads instantly against the
 *  neutral structure + content of the canvas. The top-centre is intentionally left
 *  clear for the floating selection HUD; free rotation lives on a corner knob. */
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
  // mm per screen px; 0 until the viewport is measured → skip handles (ring only).
  const mmPerPx = pxPerMm > 0 ? 1 / pxPerMm : 0;
  const handleMm = HANDLE_PX * mmPerPx;
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
          const corners = mmPerPx > 0
            ? [
                [b.minX, b.minY],
                [b.maxX, b.minY],
                [b.minX, b.maxY],
                [b.maxX, b.maxY],
              ]
            : [];
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
              {corners.map(([hx, hy], idx) => (
                <Rect
                  key={idx}
                  x={hx - handleMm / 2}
                  y={hy - handleMm / 2}
                  width={handleMm}
                  height={handleMm}
                  cornerRadius={handleMm * 0.25}
                  fill={COPPER_STROKE}
                  stroke={CANVAS_BG}
                  strokeWidth={1.5}
                  strokeScaleEnabled={false}
                  listening={false}
                />
              ))}
            </Fragment>
          );
        })}
    </>
  );
}

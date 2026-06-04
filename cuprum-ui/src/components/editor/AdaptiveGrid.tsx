import { Shape } from "react-konva";
import { GRID_MINOR_COLOR, GRID_MAJOR_COLOR } from "@/components/editor/canvasStyle";
import { gridSteps } from "@/lib/canvasTicks";

/** CAD millimetre grid over a `widthMm × heightMm` area whose step adapts to zoom
 *  via the shared `gridSteps` ladder, so the major lines coincide with the ruler
 *  labels. One Konva Shape; lines stay ~1px crisp by dividing the line width by
 *  the absolute scale, and only the lines inside the visible window are drawn so
 *  a fine step at high zoom never floods the canvas. */
export function AdaptiveGrid({ widthMm, heightMm }: { widthMm: number; heightMm: number }) {
  return (
    <Shape
      listening={false}
      sceneFunc={(ctx, shape) => {
        const scale = Math.abs(shape.getAbsoluteScale().x) || 1; // screen px per mm
        const lw = 1 / scale;
        const { minor, labelStep } = gridSteps(scale);

        // Visible window in mm (clamped to the panel) so we only emit on-screen lines.
        const stage = shape.getStage();
        let loX = 0;
        let hiX = widthMm;
        let loY = 0;
        let hiY = heightMm;
        if (stage) {
          const inv = shape.getAbsoluteTransform().copy().invert();
          const a = inv.point({ x: 0, y: 0 });
          const b = inv.point({ x: stage.width(), y: stage.height() });
          loX = Math.max(0, Math.min(a.x, b.x));
          hiX = Math.min(widthMm, Math.max(a.x, b.x));
          loY = Math.max(0, Math.min(a.y, b.y));
          hiY = Math.min(heightMm, Math.max(a.y, b.y));
        }

        const draw = (step: number) => {
          if (!(step > 0) || hiX < loX || hiY < loY) return;
          ctx.beginPath();
          for (let x = Math.ceil(loX / step) * step; x <= hiX + 1e-6; x += step) {
            ctx.moveTo(x, loY);
            ctx.lineTo(x, hiY);
          }
          for (let y = Math.ceil(loY / step) * step; y <= hiY + 1e-6; y += step) {
            ctx.moveTo(loX, y);
            ctx.lineTo(hiX, y);
          }
        };

        ctx.strokeStyle = GRID_MINOR_COLOR;
        ctx.lineWidth = lw;
        draw(minor);
        ctx.stroke();
        ctx.strokeStyle = GRID_MAJOR_COLOR;
        ctx.lineWidth = lw * 1.4;
        draw(labelStep);
        ctx.stroke();
      }}
    />
  );
}

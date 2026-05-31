import { Shape } from "react-konva";
import { GRID_MINOR, GRID_MAJOR, GRID_MINOR_COLOR, GRID_MAJOR_COLOR } from "@/components/editor/canvasStyle";

/** CAD-style millimetre grid over a `widthMm × heightMm` area. One Konva Shape;
 *  lines stay ~1px crisp at any zoom by dividing the line width by the absolute
 *  scale. */
export function CadGrid({ widthMm, heightMm }: { widthMm: number; heightMm: number }) {
  return (
    <Shape
      listening={false}
      sceneFunc={(ctx, shape) => {
        const scale = Math.abs(shape.getAbsoluteScale().x) || 1;
        const lw = 1 / scale;
        const line = (step: number) => {
          ctx.beginPath();
          for (let x = 0; x <= widthMm + 1e-3; x += step) {
            ctx.moveTo(x, 0);
            ctx.lineTo(x, heightMm);
          }
          for (let y = 0; y <= heightMm + 1e-3; y += step) {
            ctx.moveTo(0, y);
            ctx.lineTo(widthMm, y);
          }
        };
        ctx.strokeStyle = GRID_MINOR_COLOR;
        ctx.lineWidth = lw;
        line(GRID_MINOR);
        ctx.stroke();
        ctx.strokeStyle = GRID_MAJOR_COLOR;
        ctx.lineWidth = lw * 1.4;
        line(GRID_MAJOR);
        ctx.stroke();
      }}
    />
  );
}

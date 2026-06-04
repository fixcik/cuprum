import { Line } from "react-konva";
import type { GuideLine } from "@/lib/panelPlacement";

const GUIDE_STROKE = "#ff4d9d";

/** Magenta smart-guide lines drawn over the panel while dragging. Coordinates are
 *  in mm (rendered inside the canvas fit-group); the stroke is kept 1px on screen
 *  via strokeScaleEnabled=false. Purely decorative — never intercepts pointer. */
export function SnapGuides({ guides }: { guides: GuideLine[] }) {
  return (
    <>
      {guides.map((g, i) => (
        <Line
          key={i}
          points={g.axis === "x" ? [g.pos, g.from, g.pos, g.to] : [g.from, g.pos, g.to, g.pos]}
          stroke={GUIDE_STROKE}
          strokeWidth={1}
          strokeScaleEnabled={false}
          dash={[4, 3]}
          listening={false}
        />
      ))}
    </>
  );
}

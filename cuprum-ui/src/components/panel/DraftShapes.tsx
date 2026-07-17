import { Group, Circle, Line, Rect } from "react-konva";
import { DEFAULT_TOOLING_DIAMETER_MM } from "@/lib/panel";
import { ALIGN_POINT_STROKE, COPPER_STROKE } from "@/components/editor/canvasStyle";

/** Ephemeral preview shapes drawn on the panel-blank canvas while a tool is mid-gesture
 *  (placing a tooling hole, marquee-selecting, drawing a keep-out zone). All render in
 *  panel mm inside the fit-group, are non-interactive (`listening={false}`), and keep a
 *  constant screen-px stroke (`strokeScaleEnabled={false}`). */

/** Crosshair + dashed bore preview that tracks the cursor while a tooling-hole
 *  placement is armed. `pxPerMm` sizes the crosshair arms to a constant 6 screen px. */
export function ToolingGhostCrosshair({ x, y, pxPerMm }: { x: number; y: number; pxPerMm: number }) {
  const k = pxPerMm > 0 ? 1 / pxPerMm : 0;
  const arm = 6 * k;
  return (
    <Group x={x} y={y} listening={false} opacity={0.7}>
      <Circle
        radius={DEFAULT_TOOLING_DIAMETER_MM / 2}
        stroke={COPPER_STROKE}
        strokeWidth={1.5}
        strokeScaleEnabled={false}
        dash={[2, 2]}
      />
      {arm > 0 && (
        <>
          <Line points={[-arm, 0, arm, 0]} stroke={COPPER_STROKE} strokeWidth={1} strokeScaleEnabled={false} />
          <Line points={[0, -arm, 0, arm]} stroke={COPPER_STROKE} strokeWidth={1} strokeScaleEnabled={false} />
        </>
      )}
    </Group>
  );
}

/** Blue crosshair preview that tracks the cursor while the alignment-point tool
 *  is active. When the cursor is within snap range of a hole the ghost sits at
 *  the hole centre and shows its bore as a dashed ring; free positions show the
 *  cross only. Constant screen-px arms via `pxPerMm`. */
export function AlignPointGhost({
  x,
  y,
  pxPerMm,
  holeDiameterMm,
}: {
  x: number;
  y: number;
  pxPerMm: number;
  holeDiameterMm?: number;
}) {
  const k = pxPerMm > 0 ? 1 / pxPerMm : 0;
  const arm = 6 * k;
  return (
    <Group x={x} y={y} listening={false} opacity={0.8}>
      {holeDiameterMm != null && (
        <Circle
          radius={holeDiameterMm / 2}
          stroke={ALIGN_POINT_STROKE}
          strokeWidth={1.5}
          strokeScaleEnabled={false}
          dash={[2, 2]}
        />
      )}
      {arm > 0 && (
        <>
          <Line points={[-arm, 0, arm, 0]} stroke={ALIGN_POINT_STROKE} strokeWidth={1} strokeScaleEnabled={false} />
          <Line points={[0, -arm, 0, arm]} stroke={ALIGN_POINT_STROKE} strokeWidth={1} strokeScaleEnabled={false} />
        </>
      )}
    </Group>
  );
}

/** A draft rectangle defined by two opposite corners (panel mm). */
export interface DraftRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Marquee selection rectangle drawn while drag-selecting over empty canvas. */
export function MarqueeRect({ rect }: { rect: DraftRect }) {
  return (
    <Rect
      x={Math.min(rect.x0, rect.x1)}
      y={Math.min(rect.y0, rect.y1)}
      width={Math.abs(rect.x1 - rect.x0)}
      height={Math.abs(rect.y1 - rect.y0)}
      stroke="#5b9dff"
      strokeWidth={1}
      strokeScaleEnabled={false}
      dash={[4, 3]}
      fill="rgba(91,157,255,0.08)"
      listening={false}
    />
  );
}

/** Keep-out zone preview drawn while dragging in the keepout tool. */
export function KeepOutDrawRect({ rect }: { rect: DraftRect }) {
  return (
    <Rect
      x={Math.min(rect.x0, rect.x1)}
      y={Math.min(rect.y0, rect.y1)}
      width={Math.abs(rect.x1 - rect.x0)}
      height={Math.abs(rect.y1 - rect.y0)}
      stroke="rgba(99,130,190,0.8)"
      strokeWidth={1.5}
      strokeScaleEnabled={false}
      dash={[3, 2]}
      fill="rgba(99,130,190,0.12)"
      listening={false}
    />
  );
}

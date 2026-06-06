import { useLayoutEffect, useRef } from "react";
import { Group, Line, Circle, Text } from "react-konva";
import Konva from "konva";

/** Live machine-position marker, rendered INSIDE the fit-group (panel mm space)
 *  so it shares the exact stage∘fit transform as the holes — no double-applied
 *  stage transform. Visual size is kept constant on screen by dividing pixel
 *  sizes by `pxPerMm`. Tweens toward each new sample so 5 Hz polling looks smooth.
 */
export interface MachineMarkerProps {
  /** Position in panel mm (fit-group local coords). */
  xMm: number;
  yMm: number;
  /** Screen px per mm (stage scale × fit) — used to keep the marker constant-size. */
  pxPerMm: number;
  /** Work coordinates (mm) for the readout label. */
  workX: number;
  workY: number;
  /** Work Z (mm) for the readout label; omitted → not shown. */
  workZ?: number;
  color?: string;
}

const ARM_PX = 9;
const DOT_PX = 2.5;
const STROKE_PX = 1.2;
const FONT_PX = 10;
const TWEEN_S = 0.18;

export function MachineMarker({ xMm, yMm, pxPerMm, workX, workY, workZ, color = "#22d3ee" }: MachineMarkerProps) {
  const ref = useRef<Konva.Group>(null);
  const seeded = useRef(false);

  // useLayoutEffect (not useEffect): seed the position synchronously before the
  // browser paints, so the marker never flashes at the group origin (0,0) on first
  // mount before snapping to its real spot.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (!seeded.current) {
      // First appearance: snap to position, no tween.
      node.x(xMm);
      node.y(yMm);
      seeded.current = true;
      return;
    }
    // Subsequent samples: tween from the node's current (animated) position to the
    // new target so 5 Hz polling looks smooth instead of jumping. Positions are in
    // mm (fit-group local space).
    const tween = new Konva.Tween({
      node,
      x: xMm,
      y: yMm,
      duration: TWEEN_S,
      easing: Konva.Easings.Linear,
    });
    tween.play();
    return () => tween.destroy();
  }, [xMm, yMm]);

  // Constant on-screen size regardless of zoom: convert px sizes to mm.
  const k = pxPerMm > 0 ? 1 / pxPerMm : 0;
  const arm = ARM_PX * k;
  const dot = DOT_PX * k;

  return (
    <Group ref={ref} listening={false}>
      <Line points={[-arm, 0, arm, 0]} stroke={color} strokeWidth={STROKE_PX} strokeScaleEnabled={false} />
      <Line points={[0, -arm, 0, arm]} stroke={color} strokeWidth={STROKE_PX} strokeScaleEnabled={false} />
      <Circle x={0} y={0} radius={dot} fill={color} />
      <Text
        x={arm + 3 * k}
        y={-arm - 2 * k}
        text={
          `X ${workX.toFixed(1)}  Y ${workY.toFixed(1)}` +
          (workZ !== undefined ? `  Z ${workZ.toFixed(1)}` : "")
        }
        fontSize={FONT_PX * k}
        fill={color}
      />
    </Group>
  );
}

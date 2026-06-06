import { useEffect, useRef } from "react";
import { Group, Line, Circle, Text } from "react-konva";
import Konva from "konva";

/** Live machine-position marker, rendered in SCREEN space (constant size).
 *  Crosshair + dot at (screenX, screenY), with a small work-coordinate readout.
 *  Tweens toward each new sample so 5 Hz polling looks smooth. */
export interface MachineMarkerProps {
  screenX: number;
  screenY: number;
  /** Work coordinates (mm) for the readout label. */
  workX: number;
  workY: number;
  /** Work Z (mm) for the readout label; omitted → not shown. */
  workZ?: number;
  color?: string;
}

const ARM_PX = 9;
const DOT_PX = 2.5;
const TWEEN_S = 0.18;

export function MachineMarker({ screenX, screenY, workX, workY, workZ, color = "#22d3ee" }: MachineMarkerProps) {
  const ref = useRef<Konva.Group>(null);
  const seeded = useRef(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (!seeded.current) {
      // First appearance: snap to position, no tween.
      node.x(screenX);
      node.y(screenY);
      seeded.current = true;
      return;
    }
    // Subsequent samples: tween from the node's current (animated) position to
    // the new target so 5 Hz polling looks smooth instead of jumping.
    const tween = new Konva.Tween({
      node,
      x: screenX,
      y: screenY,
      duration: TWEEN_S,
      easing: Konva.Easings.Linear,
    });
    tween.play();
    return () => tween.destroy();
  }, [screenX, screenY]);

  return (
    <Group ref={ref} listening={false}>
      <Line points={[-ARM_PX, 0, ARM_PX, 0]} stroke={color} strokeWidth={1.2} />
      <Line points={[0, -ARM_PX, 0, ARM_PX]} stroke={color} strokeWidth={1.2} />
      <Circle x={0} y={0} radius={DOT_PX} fill={color} />
      <Text
        x={ARM_PX + 3}
        y={-ARM_PX - 2}
        text={
          `X ${workX.toFixed(1)}  Y ${workY.toFixed(1)}` +
          (workZ !== undefined ? `  Z ${workZ.toFixed(1)}` : "")
        }
        fontSize={10}
        fill={color}
      />
    </Group>
  );
}

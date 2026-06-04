import { Rect } from "react-konva";
import { clampZonesForHoles } from "@/lib/panelPlacement";
import { CLAMP_FILL, CLAMP_STROKE } from "@/components/editor/canvasStyle";
import type { ToolingHole } from "@/lib/api";

/** Derived clamp keep-out zones around registration/flip tooling holes — a dashed,
 *  non-interactive square per hole (side = bore diameter + 2·clamp radius). Computed
 *  from holes + the machine profile, so it follows/removes with the hole. Rendered in
 *  the mm fit-group, BELOW board instances. Empty when the clamp radius is 0. */
export function ClampZoneLayer({
  holes,
  clampRadiusMm,
}: {
  holes: ToolingHole[];
  clampRadiusMm: number;
}) {
  const zones = clampZonesForHoles(holes, clampRadiusMm);
  return (
    <>
      {zones.map(({ holeId, box }) => (
        <Rect
          key={holeId}
          x={box.minX}
          y={box.minY}
          width={box.maxX - box.minX}
          height={box.maxY - box.minY}
          fill={CLAMP_FILL}
          stroke={CLAMP_STROKE}
          strokeWidth={1}
          dash={[3, 2]}
          strokeScaleEnabled={false}
          listening={false}
        />
      ))}
    </>
  );
}

import { Group, Rect, Image as KonvaImage } from "react-konva";
import type { KonvaEventObject } from "konva/lib/Node";
import {
  INSTANCE_FILL,
  INSTANCE_STROKE,
  INSTANCE_OFF_STROKE,
  INSTANCE_OFF_FILL,
  INSTANCE_WARN_STROKE,
} from "@/components/editor/canvasStyle";
import { instanceBounds, isOffPanel, boxesOverlap } from "@/lib/panelPlacement";
import type { Severity } from "@/lib/feasibility";
import type { BoardInstance } from "@/lib/api";

/** Konva render of the board instances inside the mm fit-group. Each instance is a
 *  centre-pivoted Group (Rect + design preview image) carrying a live drag/rotate
 *  preview and severity tint. Pure presentation: all interaction callbacks live in
 *  the parent and are wired through props. Must render in the same place in the
 *  Layer tree (above keep-out zones, below the selection overlay) to preserve the
 *  Konva z-order. */
export function InstanceLayer({
  instances,
  sizes,
  selected,
  dragDelta,
  rotPreview,
  previewImages,
  byInstance,
  keepOutPreviewBox,
  tool,
  panelW,
  panelH,
  onInstanceClick,
  onInstanceContextMenu,
  onInstanceDragStart,
  onInstanceDragMove,
  onInstanceDragEnd,
}: {
  /** Instances with resolved extents (already filtered to those present in sizes). */
  instances: BoardInstance[];
  sizes: Record<string, { w: number; h: number }>;
  selected: Set<string>;
  /** Live drag delta (mm) applied to selected instances; null when idle. */
  dragDelta: { dx: number; dy: number } | null;
  /** Live rotation delta (deg) applied to selected instances; null when idle. */
  rotPreview: number | null;
  previewImages: Record<string, HTMLImageElement | undefined>;
  /** Committed worst severity per instance id from the findings source. */
  byInstance: Map<string, Severity>;
  /** Live keep-out resize preview box (mm) → real-time block tint; null when idle. */
  keepOutPreviewBox: { minX: number; minY: number; maxX: number; maxY: number } | null;
  tool: string;
  panelW: number;
  panelH: number;
  onInstanceClick: (id: string) => (e: KonvaEventObject<MouseEvent>) => void;
  onInstanceContextMenu: (id: string) => () => void;
  onInstanceDragStart: (id: string) => (e: KonvaEventObject<DragEvent>) => void;
  onInstanceDragMove: (e: KonvaEventObject<DragEvent>) => void;
  onInstanceDragEnd: (e: KonvaEventObject<DragEvent>) => void;
}) {
  return (
    <>
      {instances.map((inst) => {
        const sz = sizes[inst.design_id];
        if (!sz) return null;
        const isSelected = selected.has(inst.id);
        // Centre-pivot: place the Group at the board centre, offset by half the
        // board so local (0,0) is the unrotated top-left, then rotate about that
        // centre. Matches instanceBounds / packLayout.
        // While a drag is live, shift every selected instance by dragDelta for
        // a lock-step preview; the single commit happens on drag end.
        const shift = isSelected && dragDelta ? dragDelta : { dx: 0, dy: 0 };
        const cx = inst.x_mm + sz.w / 2 + shift.dx;
        const cy = inst.y_mm + sz.h / 2 + shift.dy;
        // Live rotation preview: spin selected instances by the snapped delta
        // (each about its own centre) until the knob is released and committed.
        const rotation = inst.rotation_deg + (isSelected && rotPreview != null ? rotPreview : 0);
        // Live off-panel check on the rendered pose (incl. drag/rotate preview)
        // so the red highlight tracks the board while it moves. This is the
        // "live" path; the committed severity from usePanelFindings is used
        // when the board is idle.
        const liveOff = isOffPanel({
          xMm: inst.x_mm + shift.dx,
          yMm: inst.y_mm + shift.dy,
          boardW: sz.w,
          boardH: sz.h,
          rotationDeg: rotation,
          panelW,
          panelH,
        });
        // Committed severity from the single findings source (covers off-panel,
        // overlap, spacing). During a live drag/rotate the committed
        // value may lag the render; fall back to liveOff for block.
        const committedSev = byInstance.get(inst.id);
        const liveZoneHit = keepOutPreviewBox
          ? boxesOverlap(
              instanceBounds({
                xMm: inst.x_mm + shift.dx,
                yMm: inst.y_mm + shift.dy,
                boardW: sz.w,
                boardH: sz.h,
                rotationDeg: rotation,
              }),
              keepOutPreviewBox,
            )
          : false;
        const isBlock = liveOff || liveZoneHit || committedSev === "block";
        const isWarn = !isBlock && committedSev === "warn";
        return (
          <Group
            key={inst.id}
            id={inst.id}
            x={cx}
            y={cy}
            offsetX={sz.w / 2}
            offsetY={sz.h / 2}
            rotation={rotation}
            listening={tool === "select"}
            draggable={tool === "select"}
            onClick={onInstanceClick(inst.id)}
            onTap={onInstanceClick(inst.id)}
            onContextMenu={onInstanceContextMenu(inst.id)}
            onDragStart={onInstanceDragStart(inst.id)}
            onDragMove={onInstanceDragMove}
            onDragEnd={onInstanceDragEnd}
          >
            <Rect
              width={sz.w}
              height={sz.h}
              fill={isBlock ? INSTANCE_OFF_FILL : INSTANCE_FILL}
              stroke={isBlock ? INSTANCE_OFF_STROKE : isWarn ? INSTANCE_WARN_STROKE : INSTANCE_STROKE}
              strokeWidth={isBlock || isWarn ? 1.5 : 1}
              strokeScaleEnabled={false}
              cornerRadius={0.3}
            />
            {previewImages[inst.design_id] && (
              <KonvaImage
                image={previewImages[inst.design_id]}
                width={sz.w}
                height={sz.h}
                listening={false}
                perfectDrawEnabled={false}
              />
            )}
          </Group>
        );
      })}
    </>
  );
}

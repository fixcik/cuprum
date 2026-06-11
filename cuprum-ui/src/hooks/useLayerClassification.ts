import { useMemo } from "react";
import type { BBox } from "@/lib/api";
import { outlinePathD } from "@/lib/boardOutline";
import type { StackLayer } from "@/components/import/LayerStack";
import {
  boardSnapPoints,
  edgeCenterlineBBox,
  featureSnapPoints,
  findEdgeLayer,
  visibleLayersInZOrder,
} from "@/lib/layerClassification";

/** Render-ready structures derived from the raw layer list, classified once per
 *  layer/extent change instead of inline in the viewer's JSX. */
export interface LayerClassification {
  /** Visible layers in painter's order (LAYER_Z, lower first). */
  visible: StackLayer[];
  /** The assigned Edge_Cuts layer, if any. */
  edgeLayer: StackLayer | undefined;
  /** Board clip path (gerber mm) from the Edge_Cuts outline, or null. */
  boardClipD: string | null;
  /** Edge_Cuts centerline bbox (true board extent), or null. */
  edgeBoxOutline: BBox | null;
  /** Effective board extent: the centerline bbox when present, else the full bbox. */
  edgeBox: BBox;
  /** Feature snap candidates from the visible layers (hole/pad centres). */
  featurePts: [number, number][];
  /** Board-frame snap candidates (corners, edge midpoints, centre). */
  boardPts: [number, number][];
}

/** Classify the layer stack into the structures the viewer renders: visible layers
 *  in z-order, the Edge_Cuts layer + its clip path and true extent, and the snap
 *  candidate sets. Each piece is memoised on the same inputs the inline code used,
 *  so toggling visibility doesn't move the camera and a cursor-only re-render
 *  doesn't rebuild the lists. `box` is the union of all layer bboxes (the fallback
 *  extent when there's no outline). */
export function useLayerClassification(layers: StackLayer[], box: BBox): LayerClassification {
  const visible = useMemo(() => visibleLayersInZOrder(layers), [layers]);

  const edgeLayer = useMemo(() => findEdgeLayer(layers), [layers]);

  const boardClipD = useMemo(
    () => (edgeLayer ? outlinePathD(edgeLayer.svgBody) : null),
    [edgeLayer],
  );

  const edgeBoxOutline = useMemo(
    () => edgeCenterlineBBox(edgeLayer?.svgBody),
    [edgeLayer],
  );

  const edgeBox = edgeBoxOutline ?? box;

  const featurePts = useMemo(() => featureSnapPoints(visible), [visible]);

  const boardPts = useMemo(() => boardSnapPoints(edgeBox), [edgeBox]);

  return { visible, edgeLayer, boardClipD, edgeBoxOutline, edgeBox, featurePts, boardPts };
}

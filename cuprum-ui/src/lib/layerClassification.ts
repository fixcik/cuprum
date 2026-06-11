import type { BBox } from "@/lib/api";
import { LAYER_Z } from "@/lib/layerColors";
import { outlineLoops } from "@/lib/boardOutline";
import type { StackLayer } from "@/components/import/LayerStack";

/** The subset of a StackLayer this module classifies over. StackLayer is
 *  structurally assignable; kept minimal so the pure layer-classification logic
 *  doesn't pull in the viewer component's render concerns. */
export interface ClassifiableLayer {
  svgBody: string;
  bbox: BBox;
  visible: boolean;
  type: StackLayer["type"];
  snap: [number, number][];
}

/** Visible layers in painter's order (lower LAYER_Z drawn first / underneath).
 *  Filters out hidden layers, then sorts a copy by z so toggling visibility never
 *  reorders the survivors. Pure: input layers are not mutated. */
export function visibleLayersInZOrder<L extends ClassifiableLayer>(layers: L[]): L[] {
  // filter() already returns a fresh array, so sort() never touches the input.
  return layers
    .filter((l) => l.visible)
    .sort((a, b) => LAYER_Z[a.type] - LAYER_Z[b.type]);
}

/** The Edge_Cuts layer, if assigned — drives the board clip path and the true
 *  board extent. */
export function findEdgeLayer<L extends ClassifiableLayer>(layers: L[]): L | undefined {
  return layers.find((l) => l.type === "edgeCuts");
}

/** True board extent = bbox of the Edge_Cuts CENTERLINE (the cut path), NOT the
 *  stroked layer bbox — the rendered outline has the gerber stroke width, so its
 *  bbox is half a line-width too big on every side. The cut follows the centre.
 *  Returns null when there's no outline or it has no finite points. */
export function edgeCenterlineBBox(edgeSvgBody: string | null | undefined): BBox | null {
  if (!edgeSvgBody) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const loop of outlineLoops(edgeSvgBody)) {
    for (const p of loop) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** Snap candidates contributed by the visible layers themselves: every feature
 *  point (hole/pad centre) of a visible layer. */
export function featureSnapPoints<L extends ClassifiableLayer>(visibleLayers: L[]): [number, number][] {
  return visibleLayers.flatMap((l) => l.snap);
}

/** Board snap candidates derived from an extent: 4 corners, 4 edge midpoints and
 *  the centre. Used so the ruler/crosshair lock onto the board frame. */
export function boardSnapPoints(bx: BBox): [number, number][] {
  return [
    [bx.minX, bx.minY], [bx.maxX, bx.minY], [bx.minX, bx.maxY], [bx.maxX, bx.maxY],
    [(bx.minX + bx.maxX) / 2, bx.minY], [(bx.minX + bx.maxX) / 2, bx.maxY],
    [bx.minX, (bx.minY + bx.maxY) / 2], [bx.maxX, (bx.minY + bx.maxY) / 2],
    [(bx.minX + bx.maxX) / 2, (bx.minY + bx.maxY) / 2],
  ];
}

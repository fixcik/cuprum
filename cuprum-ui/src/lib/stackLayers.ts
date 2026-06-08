import { colorFor } from "@/lib/layerColors";
import type { BBox, GerberFile, LayerType } from "@/lib/api";
import type { StackLayer } from "@/components/import/LayerStack";

/** The per-gerber render state this builder needs. `InspectorFile` (usePreviewData)
 *  is structurally assignable; kept minimal so lib/ doesn't depend on the hook. */
export interface StackLayerFile {
  svgBody?: string;
  bbox?: BBox;
  snap?: [number, number][];
}

export interface BuildStackLayersCtx {
  /** manifest.layer_colors — per-type colour overrides. */
  overrides?: Record<string, string>;
  /** Omit topMask/bottomMask (e.g. when the mask is rendered onto copper instead). */
  excludeMask: boolean;
  /** Whether a layer is visible at the current mode/side + manual hides. */
  isVisible: (type: LayerType, path: string) => boolean;
}

/** Build the StackLayer list for the 2D composite (LayerStack). Skips gerbers with no
 *  rendered SVG/bbox yet, and the mask layers when `excludeMask`. Pure: colour comes
 *  from `colorFor`, visibility is injected. */
export function buildStackLayers(
  gerbers: GerberFile[],
  files: (StackLayerFile | undefined)[],
  ctx: BuildStackLayersCtx,
): StackLayer[] {
  const { overrides, excludeMask, isVisible } = ctx;
  return gerbers
    .map((g, i) => ({ g, f: files[i] }))
    .filter(({ g, f }) => {
      if (!f?.svgBody || !f?.bbox) return false;
      if (excludeMask && (g.layer_type === "topMask" || g.layer_type === "bottomMask")) return false;
      return true;
    })
    .map(({ g, f }) => ({
      key: g.path,
      svgBody: f!.svgBody as string,
      bbox: f!.bbox!,
      color: colorFor(g.layer_type, overrides),
      visible: isVisible(g.layer_type, g.path),
      type: g.layer_type,
      snap: f!.snap ?? [],
    }));
}

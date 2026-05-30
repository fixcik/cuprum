import type { LayerType } from "@/lib/api";

/** Natural PCB colours (match the 3D render): ENIG-gold copper, green soldermask,
 *  white silk. Used for both the 2D and 3D previews. Overridable via
 *  manifest.layer_colors. */
export const DEFAULT_LAYER_COLORS: Record<LayerType, string> = {
  topCopper: "#caa84a", // ENIG gold
  bottomCopper: "#caa84a",
  innerCopper: "#caa84a",
  topMask: "#257d55ff", // 2D soldermask — bright vivid green
  bottomMask: "#257d55ff",
  topSilk: "#f0f0f0", // white silkscreen
  bottomSilk: "#f0f0f0",
  topPaste: "#c3c7cc",
  bottomPaste: "#c3c7cc",
  edgeCuts: "#59512c", // board edge = bare FR4 dark olive (matches the 3D substrate)
  drill: "#2a2a2a",
  other: "#8a8f98",
};

/** Human label for a layer type (Russian UI). */
export const LAYER_LABELS: Record<LayerType, string> = {
  topCopper: "Медь (верх)",
  bottomCopper: "Медь (низ)",
  innerCopper: "Медь (внутр.)",
  topMask: "Маска (верх)",
  bottomMask: "Маска (низ)",
  topSilk: "Шелк (верх)",
  bottomSilk: "Шелк (низ)",
  topPaste: "Паста (верх)",
  bottomPaste: "Паста (низ)",
  edgeCuts: "Контур",
  drill: "Сверловка",
  other: "Прочее",
};

/** Layer-panel display order: by fabrication role, building outward from the bare
 *  board — board outline first, then drilling, then the copper/mask/silk stack
 *  applied on top. Within a role the two faces sit together (bottom then top). */
export const LAYER_STACK_ORDER: LayerType[] = [
  "edgeCuts",                                 // board outline
  "drill",                                    // drilling
  "bottomCopper", "innerCopper", "topCopper", // copper
  "bottomPaste", "topPaste",                  // paste
  "bottomMask", "topMask",                    // mask
  "bottomSilk", "topSilk",                    // silkscreen
  "other",
];

/** Index of a type in the bottom→top stack order (unknown → last). */
export function stackOrder(type: LayerType): number {
  const i = LAYER_STACK_ORDER.indexOf(type);
  return i < 0 ? LAYER_STACK_ORDER.length : i;
}

/** Layer types a board MUST have to be considered valid (and previewable). The
 *  outline defines the board's size and cut path, so without it there's nothing
 *  to build — the wizard asks the user to assign it before rendering. */
export const REQUIRED_LAYERS: LayerType[] = ["edgeCuts"];

/** Required layer types not present in the current assignments (for the prompt). */
export function missingRequired(types: LayerType[]): LayerType[] {
  const present = new Set(types);
  return REQUIRED_LAYERS.filter((t) => !present.has(t));
}

export const LAYER_ORDER: LayerType[] = [
  "topCopper", "topMask", "topSilk", "topPaste",
  "bottomCopper", "bottomMask", "bottomSilk", "bottomPaste",
  "innerCopper", "edgeCuts", "drill", "other",
];

/** Painter's order for the composite preview: lower = drawn first (underneath). */
export const LAYER_Z: Record<LayerType, number> = {
  // Edge outline sits UNDER everything so the soldermask overlaps it (only the
  // thin bit outside the board shows as the cut line).
  edgeCuts: -1,
  other: 0,
  bottomCopper: 1,
  bottomMask: 2,
  bottomSilk: 3,
  bottomPaste: 4,
  innerCopper: 5,
  topCopper: 6,
  topMask: 7,
  topSilk: 8,
  topPaste: 9,
  drill: 10,
};

/** Resolve a layer's colour: manifest override wins over the default palette. */
export function colorFor(type: LayerType, overrides?: Record<string, string>): string {
  return overrides?.[type] ?? DEFAULT_LAYER_COLORS[type];
}

/** Which physical side a layer belongs to (for the Top/Bottom view). */
export function sideOf(type: LayerType): "top" | "bottom" | "both" {
  if (type.startsWith("top")) return "top";
  if (type.startsWith("bottom")) return "bottom";
  return "both"; // edgeCuts, drill, innerCopper, other
}

import type { PanelDoc, Stackup } from "@/lib/api";

/** Default stackup for a fresh blank: 1 oz copper on 1.6 mm FR4, double-sided. */
export const DEFAULT_STACKUP: Stackup = {
  copper_weight_oz: 1,
  substrate_thickness_mm: 1.6,
  double_sided: true,
};

/** Selectable copper weights (oz). */
export const COPPER_WEIGHTS = [0.5, 1, 2] as const;

/** A reusable panel-blank preset (stored globally in settings). */
export interface PanelPreset {
  id: string;
  name: string;
  widthMm: number;
  heightMm: number;
  stackup: Stackup;
}

/** Built-in starter presets, always available alongside user presets. */
export const BUILTIN_PANEL_PRESETS: PanelPreset[] = [
  { id: "builtin-100x100", name: "100 × 100 · 1oz · 1.6 mm", widthMm: 100, heightMm: 100, stackup: { copper_weight_oz: 1, substrate_thickness_mm: 1.6, double_sided: true } },
  { id: "builtin-100x150", name: "100 × 150 · 1oz · 1.6 mm", widthMm: 100, heightMm: 150, stackup: { copper_weight_oz: 1, substrate_thickness_mm: 1.6, double_sided: true } },
  { id: "builtin-200x100", name: "200 × 100 · 1oz · 1.6 mm", widthMm: 200, heightMm: 100, stackup: { copper_weight_oz: 1, substrate_thickness_mm: 1.6, double_sided: true } },
];

export const DEFAULT_TOOLING_DIAMETER_MM = 3;
export const REGISTRATION_SET_MARGIN_MM = 5;

/** Build a fresh PanelDoc at origin (0,0). */
export function newPanelDoc(widthMm: number, heightMm: number): PanelDoc {
  return { schema_version: 2, width_mm: widthMm, height_mm: heightMm, origin_x_mm: 0, origin_y_mm: 0, instances: [], tooling_holes: [] };
}

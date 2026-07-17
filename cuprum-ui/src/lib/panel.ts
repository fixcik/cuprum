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

/** Format a number for a preset label — drop trailing zeros (1.60 → "1.6"). */
function fmtNum(n: number): string {
  return String(Number(n.toFixed(3)));
}

/** Human label for a preset, mirroring the built-in format
 *  ("100 × 100 · 1oz · 1.6 mm"). Always millimetres — presets are stored in mm. */
export function panelPresetLabel(widthMm: number, heightMm: number, stackup: Stackup): string {
  return `${fmtNum(widthMm)} × ${fmtNum(heightMm)} · ${fmtNum(stackup.copper_weight_oz)}oz · ${fmtNum(stackup.substrate_thickness_mm)} mm`;
}

/** Deterministic id for a user preset, derived from its params so re-saving the
 *  same blank updates the existing preset instead of duplicating it. */
export function panelPresetId(widthMm: number, heightMm: number, stackup: Stackup): string {
  return `user-${fmtNum(widthMm)}x${fmtNum(heightMm)}-${fmtNum(stackup.copper_weight_oz)}oz-${fmtNum(stackup.substrate_thickness_mm)}mm-${stackup.double_sided ? "ds" : "ss"}`;
}

export const DEFAULT_TOOLING_DIAMETER_MM = 3;
export const REGISTRATION_SET_MARGIN_MM = 5;

/** Build a fresh PanelDoc at origin (0,0). */
export function newPanelDoc(widthMm: number, heightMm: number): PanelDoc {
  return { schema_version: 5, width_mm: widthMm, height_mm: heightMm, origin_x_mm: 0, origin_y_mm: 0, instances: [], tooling_holes: [], keep_out_zones: [], alignment_points: [], drill_class_overrides: {} };
}

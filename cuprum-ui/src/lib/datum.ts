export type DatumCorner = "bottom-left" | "bottom-right" | "top-left" | "top-right";
export const DATUM_CORNERS: DatumCorner[] = [
  "bottom-left",
  "bottom-right",
  "top-left",
  "top-right",
];

/** Panel (x, y) [editor space: Y-down, origin top-left] → machine (X right+, Y up+),
 *  origin translated to the chosen datum corner. Translation only — no mirroring.
 *
 *  For a panel of W×H mm:
 *    bottom-left  → ( x,       H − y )   [all ≥ 0 inside the panel]
 *    top-left     → ( x,           −y )   [Y ≤ 0]
 *    bottom-right → ( x − W,   H − y )   [X ≤ 0]
 *    top-right    → ( x − W,       −y )   [X ≤ 0, Y ≤ 0]
 *
 *  X never flips sign and Y always inverts once, so orientation is identical for
 *  all corners (no mirroring) — only the translation differs. */
export function machinePoint(
  x: number,
  y: number,
  datum: DatumCorner,
  wMm: number,
  hMm: number,
): [number, number] {
  const right = datum === "bottom-right" || datum === "top-right";
  const bottom = datum === "bottom-left" || datum === "bottom-right";
  return [x - (right ? wMm : 0), (bottom ? hMm : 0) - y];
}

/** Position of the datum corner in panel space (Y-down, origin top-left).
 *  Useful for positioning the route start and the canvas origin marker. */
export function datumCornerPanelPoint(
  datum: DatumCorner,
  wMm: number,
  hMm: number,
): { xMm: number; yMm: number } {
  const right = datum === "bottom-right" || datum === "top-right";
  const bottom = datum === "bottom-left" || datum === "bottom-right";
  return { xMm: right ? wMm : 0, yMm: bottom ? hMm : 0 };
}

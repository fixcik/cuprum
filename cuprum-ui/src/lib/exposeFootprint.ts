import type { BoardInstance } from "@/lib/api";

/** Axis-aligned footprint box (mm) of a placed board instance, in panel space
 *  (top-left origin, Y-down). */
export interface FootprintBox {
  xMm: number;
  yMm: number;
  wMm: number;
  hMm: number;
}

/** Compute the on-panel footprint box of an instance, matching how the panel
 *  editor draws it (InstanceLayer): the board occupies `w×h` at top-left
 *  `(x_mm, y_mm)` and rotates around its CENTRE. A 90°/270° rotation therefore
 *  swaps the visible extents AND shifts the top-left by `(w−h)/2` (the rotated
 *  bbox keeps the same centre). Drawing the swapped size at the un-shifted
 *  top-left — as a naive `x_mm, swap(w,h)` would — overlaps neighbours.
 *
 *  `size` is the design's board extent (mm); falls back to a small square when a
 *  design's metrics haven't resolved yet. */
export function footprintBoxMm(
  inst: Pick<BoardInstance, "x_mm" | "y_mm" | "rotation_deg">,
  size: { w: number; h: number } | undefined,
  fallback = 20,
): FootprintBox {
  const boardW = size?.w ?? fallback;
  const boardH = size?.h ?? fallback;
  const rotated = inst.rotation_deg === 90 || inst.rotation_deg === 270;
  const drawnW = rotated ? boardH : boardW;
  const drawnH = rotated ? boardW : boardH;
  // Centre is rotation-invariant; derive the rotated bbox top-left from it.
  const cx = inst.x_mm + boardW / 2;
  const cy = inst.y_mm + boardH / 2;
  return {
    xMm: cx - drawnW / 2,
    yMm: cy - drawnH / 2,
    wMm: drawnW,
    hMm: drawnH,
  };
}

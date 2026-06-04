export interface HudRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface HudPlacement {
  /** HUD top-left in screen px. */
  left: number;
  top: number;
  /** Whether the HUD sits above or below the board (drives caret orientation). */
  placement: "top" | "bottom";
  /** Caret X relative to the HUD's left edge (kept over the board centre). */
  caretLeft: number;
}

/** Position the selection HUD relative to a board's screen-space AABB: centred above
 *  the board, flipped below when it would collide with the top ruler band, and
 *  clamped horizontally into the viewport. Pure — unit-tested. All values in px. */
export function placeHud(opts: {
  bboxScreen: HudRect;
  viewportW: number;
  hudW: number;
  hudH: number;
  rulerTop: number;
  rulerLeft: number;
  gap?: number;
  pad?: number;
}): HudPlacement {
  const { bboxScreen, viewportW, hudW, hudH, rulerTop, rulerLeft } = opts;
  const gap = opts.gap ?? 12;
  const pad = opts.pad ?? 8;

  const centerX = (bboxScreen.left + bboxScreen.right) / 2;

  let placement: "top" | "bottom" = "top";
  let top = bboxScreen.top - gap - hudH;
  if (top < rulerTop + pad) {
    placement = "bottom";
    top = bboxScreen.bottom + gap;
  }

  const minLeft = rulerLeft + pad;
  const maxLeft = Math.max(minLeft, viewportW - hudW - pad);
  let left = centerX - hudW / 2;
  if (left < minLeft) left = minLeft;
  if (left > maxLeft) left = maxLeft;

  let caretLeft = centerX - left;
  caretLeft = Math.max(pad, Math.min(hudW - pad, caretLeft));

  return { left, top, placement, caretLeft };
}

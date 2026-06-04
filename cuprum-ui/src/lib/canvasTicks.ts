// Shared tick/grid-step math for the CAD canvases (design-preview LayerStack and
// the panel blank). Pure: no rendering, no React. Both canvases pick identical
// steps from one ladder, so a ruler label and a grid line always coincide.

/** "1-2-5" nice-number ladder (mm). Zooming in reveals finer rungs
 *  (10→5→1→0.5→0.1mm); zooming out coarsens them. */
export const STEP_LADDER = [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100, 500, 1000, 5000];

/** Finest ladder rung whose on-screen spacing is at least `minPx`. */
export function pickStep(pxPerMm: number, minPx: number): number {
  if (!(pxPerMm > 0)) return STEP_LADDER[STEP_LADDER.length - 1];
  return STEP_LADDER.find((st) => st * pxPerMm >= minPx) ?? STEP_LADDER[STEP_LADDER.length - 1];
}

export interface GridSteps {
  /** Grid step (mm) — the finest rung still ≥8px apart on screen. */
  minor: number;
  /** Labelled/major step (mm) — a coarser rung with room for the digits. */
  labelStep: number;
  /** labelStep / minor as an integer ≥1, so labelled lines coincide with grid lines. */
  labelEvery: number;
}

/** Pick the minor grid step and the coarser labelled step for a given scale.
 *  Labels appear every `labelEvery` minor lines. `labelMinPx` leaves room for the
 *  digits (44px ≈ "240" at 9px). */
export function gridSteps(pxPerMm: number, labelMinPx = 44): GridSteps {
  const minor = pickStep(pxPerMm, 8);
  const labelStep = pickStep(pxPerMm, labelMinPx);
  const labelEvery = Math.max(1, Math.round(labelStep / minor));
  return { minor, labelStep, labelEvery };
}

export interface Tick {
  /** Absolute coordinate (mm) of the tick. */
  mm: number;
  /** Value to label (mm from the anchor): `k * minor`. */
  label: number;
  /** Whether this is a labelled/major tick. */
  major: boolean;
}

/** Ticks at multiples of `minor` from `anchor`, covering [lo, hi] (mm). Every
 *  `labelEvery`-th tick is `major` (labelled). Capped to `maxCount` so a degenerate
 *  range never floods the DOM. */
export function ticksFor(
  anchor: number,
  lo: number,
  hi: number,
  minor: number,
  labelEvery: number,
  maxCount = 2000,
): Tick[] {
  const out: Tick[] = [];
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(minor > 0) || hi < lo) return out;
  const every = Math.max(1, Math.round(labelEvery));
  // Nudge the bounds by a tick-relative epsilon so float dust (e.g. 0.3/0.1 =
  // 2.9999…) never drops an on-edge tick.
  const eps = 1e-9;
  const kStart = Math.ceil((lo - anchor) / minor - eps);
  const kEnd = Math.floor((hi - anchor) / minor + eps);
  if (kEnd - kStart > maxCount) return out;
  for (let k = kStart; k <= kEnd; k++) {
    // Round to kill binary-float dust (e.g. 0.1*3) so labels read cleanly.
    const labelVal = parseFloat((k * minor).toPrecision(12));
    out.push({ mm: anchor + k * minor, label: labelVal, major: k % every === 0 });
  }
  return out;
}

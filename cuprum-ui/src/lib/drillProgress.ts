/** Fraction (0..1) of the target plunge depth currently reached.
 *  Work Z0 = material surface; the bit plunges to negative Z, so depth = -zMm.
 *  Safe Z (positive) and a non-positive target both yield 0. */
export function holeDepthFraction(zMm: number, targetDepthMm: number): number {
  if (targetDepthMm <= 0) return 0;
  const f = -zMm / targetDepthMm;
  return f <= 0 ? 0 : f > 1 ? 1 : f;
}

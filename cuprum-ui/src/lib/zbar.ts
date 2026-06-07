/** Map a vertical fraction of the Z bar (0 = bottom, 1 = top) to a machine Z
 *  within the envelope [-envZ, 0]. The fraction is clamped to [0, 1] so a click
 *  slightly past either end still resolves to a valid in-envelope target. */
export function machineZFromFraction(fracFromBottom: number, envZ: number): number {
  const f = Math.min(1, Math.max(0, fracFromBottom));
  const zMin = -Math.abs(envZ);
  return zMin + f * Math.abs(envZ);
}

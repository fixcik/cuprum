/** Copper foil thickness in microns by weight (oz). */
const COPPER_MICRONS: Record<number, number> = { 0.5: 17.5, 1: 35, 2: 70 };

/** Foil thickness (µm) for a copper weight (oz). Falls back to 35µm per oz. */
export function copperMicrons(oz: number): number {
  return COPPER_MICRONS[oz] ?? oz * 35;
}

/** Approximate finished board thickness (mm): substrate + copper on 1 or 2 sides. */
export function stackupTotalMm(substrateMm: number, copperOz: number, doubleSided: boolean): number {
  return substrateMm + ((doubleSided ? 2 : 1) * copperMicrons(copperOz)) / 1000;
}

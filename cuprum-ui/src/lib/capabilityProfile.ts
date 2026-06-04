/** The machine's manufacturing limits — the thresholds a board is judged against
 *  for DFM feasibility. Global (one machine), edited on the Settings page and
 *  persisted. Some fields (minSpaceMm, minAnnularRingMm, mask/silk) are stored
 *  now but only evaluated in Phase 2/3. */
export interface CapabilityProfile {
  // Maximum panel size (the machine's work area, independent of the copper
  // fabrication method).
  maxPanelWidthMm: number;
  maxPanelHeightMm: number;
  /** Allow trying the board rotated 90° before declaring it too big. */
  allowRotateToFit: boolean;
  // Copper
  maxCopperLayers: number;
  allowInnerLayers: boolean;
  minTraceMm: number;
  minSpaceMm: number; // P2 (geometric DRC)
  /** Ignore geometric copper/space/mask issues thinner than this (artefacts of
   *  the boolean ops — a near-zero sliver isn't a real feature). */
  ignoreBelowMm: number;
  // Drilling / Via
  minDrillMm: number; // smallest hole size you're willing to make (separate from the bit set)
  drillBitToleranceMm: number; // ± tolerance when matching a tool to a bit
  viaPlatingAvailable: boolean;
  viaWarnCount: number; // # via-sized holes above which → warn (no plating)
  viaBlockCount: number; // → block (no plating)
  viaMaxDiameterMm: number; // holes ≤ this count as "vias" for the heuristic
  // Geometry
  minAnnularRingMm: number;
  minMaskDamMm: number;
  minSilkLineMm: number;
  maxOvershootMm: number; // max allowed feature overshoot beyond the board edge
}

/** Defaults for an Elegoo Saturn 4 Ultra 16K + CNC. Max panel defaults to a round
 *  200 × 100 mm working area; all values editable in Settings. */
export const DEFAULT_PROFILE: CapabilityProfile = {
  maxPanelWidthMm: 200,
  maxPanelHeightMm: 100,
  allowRotateToFit: true,
  maxCopperLayers: 2,
  allowInnerLayers: false,
  minTraceMm: 0.15, // ~6 mil — realistic for contact UV exposure + etch
  minSpaceMm: 0.15,
  ignoreBelowMm: 0.05, // 50 µm — below this, treat as a boolean-op artefact

  minDrillMm: 0.3,
  drillBitToleranceMm: 0.05,
  viaPlatingAvailable: false, // no electroless plating at home → vias are manual
  viaWarnCount: 1,
  viaBlockCount: 200,
  viaMaxDiameterMm: 0.6,
  minAnnularRingMm: 0.15,
  minMaskDamMm: 0.1,
  minSilkLineMm: 0.15,
  maxOvershootMm: 0.2,
};

import type { MillDefaults } from "@/lib/api";

/** Factory isolation-milling cut defaults for a 3018-class machine on FR4 copper.
 *  The model is always millimetres; the UI converts for display/input. A 0.2 mm
 *  effective cut width matches a fine end-mill / engraving V-bit; one pass with a
 *  shallow ~0.04 mm depth clears 35 µm copper without biting deep into the substrate. */
export const DEFAULT_MILL_DEFAULTS: MillDefaults = {
  cutWidthMm: 0.2,
  passes: 1,
  overlap: 0.15,
  climb: true,
  cutDepthMm: 0.04,
  depthPerPassMm: null,
  feedXyMmMin: 200,
  plungeMmMin: 60,
};

/** Re-export the persisted shape so consumers can import it from one place. */
export type { MillDefaults };

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

/** Which board side an isolation-milling run targets. "bottom" mirrors the
 *  toolpaths about the panel's vertical centre (the operator flips the board
 *  left↔right), so each side gets its own pass / G-code. */
export type MillSide = "top" | "bottom";

/** Re-export the persisted shape so consumers can import it from one place. */
export type { MillDefaults };

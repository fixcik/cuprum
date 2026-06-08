/** Default breakthrough (mm) past the bottom of the substrate to ensure clean
 *  perforation. Mirrors the Rust `cuprum_drill::DEFAULT_BREAKTHROUGH_MM` — used
 *  on the frontend only to size the Z gate / depth-progress ring; the backend
 *  applies the same default when the plan input omits `breakthroughMm`. */
export const DEFAULT_BREAKTHROUGH_MM = 0.3;

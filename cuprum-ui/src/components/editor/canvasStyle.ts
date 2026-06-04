// Shared dark CAD-canvas palette and zoom limits, used by the exposure editor
// (PreviewCanvas) and the panel-blank preview (PanelBlankCanvas) so both share
// one visual language.

export const CANVAS_BG = "#0a0c10";

export const GRID_MINOR = 5;
export const GRID_MAJOR = 50;
export const GRID_MINOR_COLOR = "#191e27";
export const GRID_MAJOR_COLOR = "#283140";

export const MIN_SCALE = 0.15;
export const MAX_SCALE = 14;

// Copper is reserved for ACTION / SELECTION only (active tool, selected board
// ring + pin). It is NOT used for canvas structure or for placed-board content —
// see the neutral STRUCTURE/INSTANCE tokens below.
export const COPPER_STROKE = "#b87333";

// Neutral structure + content palette (muted-foreground ≈ #8b97a7). Konva paints
// onto a 2D context where `var(--…)` can't resolve, so these are concrete colours.
// STRUCTURE = the blank "sheet": copper-clad side is a solid neutral outline, the
// bare side a dashed one; the distinction survives, only the amber is dropped.
export const BLANK_STROKE = "rgba(139,151,167,0.4)";
export const BLANK_STROKE_BARE = "rgba(139,151,167,0.3)";
export const BLANK_FILL = "rgba(139,151,167,0.035)";
export const BLANK_LABEL = "rgba(139,151,167,0.55)";
// CONTENT = a placed board. Until the real green PCB render lands it's a neutral
// solid object that reads as content on the grid (not copper, not structure).
export const INSTANCE_FILL = "#171c24";
export const INSTANCE_STROKE = "rgba(139,151,167,0.45)";
export const INSTANCE_LABEL = "rgba(139,151,167,0.7)";

// Edge-ruler band thickness (px). Left is wider to fit the rotated vertical
// labels. Shared by the canvas (fit/centre math) and the RulersOverlay.
export const RULER_TOP = 24;
export const RULER_LEFT = 30;

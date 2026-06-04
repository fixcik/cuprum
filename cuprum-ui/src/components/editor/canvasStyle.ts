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

export const COPPER_STROKE = "#b87333";
export const COPPER_FILL = "rgba(184,115,51,0.06)";
export const NO_COPPER_STROKE = "#5a6472";

// Edge-ruler band thickness (px). Left is wider to fit the rotated vertical
// labels. Shared by the canvas (fit/centre math) and the RulersOverlay.
export const RULER_TOP = 24;
export const RULER_LEFT = 30;

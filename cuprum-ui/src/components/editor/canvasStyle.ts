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
// STRUCTURE = the blank "sheet": a solid neutral outline + faint fill.
export const BLANK_STROKE = "rgba(139,151,167,0.4)";
export const BLANK_FILL = "rgba(139,151,167,0.035)";
export const BLANK_LABEL = "rgba(139,151,167,0.55)";
// CONTENT = a placed board. Until the real green PCB render lands it's a neutral
// solid object that reads as content on the grid (not copper, not structure).
export const INSTANCE_FILL = "#171c24";
export const INSTANCE_STROKE = "rgba(139,151,167,0.45)";
export const INSTANCE_LABEL = "rgba(139,151,167,0.7)";
// OFF-PANEL / OVERLAP = a placed board with a blocking issue (off-panel or overlapping).
// Red outline + faint red fill so it reads as "fix this"; the label stays neutral for
// legibility.
export const INSTANCE_OFF_STROKE = "#e5484d";
export const INSTANCE_OFF_FILL = "rgba(229,72,77,0.12)";
// WARN = a placed board with a non-blocking issue (too close to edge / work-area).
// Amber outline only (no fill) — softer than the block red.
export const INSTANCE_WARN_STROKE = "#f59e0b";

// Edge-ruler band thickness (px). Left is wider to fit the rotated vertical
// labels. Shared by the canvas (fit/centre math) and the RulersOverlay.
export const RULER_TOP = 16;
export const RULER_LEFT = 20;

// Keep-out zone palette — muted hues distinct from INSTANCE_OFF (red) and
// INSTANCE_WARN (amber). Chosen so zones read as annotations, not errors.
// "fixture" → slate-blue; "dead" → violet-indigo; "reserved" → teal.
export const KEEPOUT_FIXTURE_FILL = "rgba(99,130,190,0.13)";
export const KEEPOUT_FIXTURE_STROKE = "rgba(99,130,190,0.7)";
export const KEEPOUT_DEAD_FILL = "rgba(140,100,200,0.13)";
export const KEEPOUT_DEAD_STROKE = "rgba(140,100,200,0.7)";
export const KEEPOUT_RESERVED_FILL = "rgba(60,170,160,0.13)";
export const KEEPOUT_RESERVED_STROKE = "rgba(60,170,160,0.7)";
export const KEEPOUT_SELECTED_STROKE = COPPER_STROKE;

// Derived clamp keep-out zone palette — muted ochre, distinct from the manual
// keep-out zones (type-tinted, hatched), from off-panel red, and from the
// slate-blue fixture tone. Applied as a dashed square around each tooling hole
// when the clamp radius is non-zero (ClampZoneLayer).
export const CLAMP_FILL = "rgba(180,150,90,0.10)";
export const CLAMP_STROKE = "rgba(180,150,90,0.75)";

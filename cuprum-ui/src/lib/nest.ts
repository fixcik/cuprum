/** Auto-placement (nesting) recipe. All lengths in mm. Lives in settingsStore as
 *  the last-used defaults and travels with the add-to-panel intent. `side` matches
 *  BoardInstance.layer_ref so it can be assigned directly. */
export interface NestSettings {
  /** Off → a single copy tucked into the corner; on → fill with an array. */
  enabled: boolean;
  /** "copies" → an explicit count; "fill" → a percentage of the panel capacity. */
  fillMode: "copies" | "fill";
  copies: number;
  /** 10..100, used when fillMode === "fill". */
  fillPct: number;
  /** Gap between boards, mm. */
  gapMm: number;
  /** Keep-out margin from the panel edge, mm. */
  marginMm: number;
  /** Rotate the board 90° to pack better. */
  rotate: boolean;
  /** Anchor corner for packing. */
  corner: "tl" | "tr" | "bl" | "br";
  /** Fill direction: row-major or column-major. */
  dir: "rows" | "cols";
  /** Snap placement to this grid step, mm (0 = off). */
  snapMm: number;
  /** Side to place on (BoardInstance.layer_ref). */
  side: "Top" | "Bottom";
  /** Re-pack the whole panel on add/remove. Stored only in Phase 2 (no behaviour
   *  yet — the interactive editor wires it). */
  repack: boolean;
}

/** Defaults from the design handoff. Single copy goes to the corner, not centre. */
export const DEFAULT_NEST: NestSettings = {
  enabled: false,
  fillMode: "copies",
  copies: 6,
  fillPct: 80,
  gapMm: 2,
  marginMm: 5,
  rotate: false,
  corner: "bl",
  dir: "rows",
  snapMm: 0,
  side: "Top",
  repack: true,
};

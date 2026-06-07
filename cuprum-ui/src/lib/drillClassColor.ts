import type { DrillClass } from "@/lib/api";

/** Canonical per-category dot colours, shared across the drill UI (selection chips,
 *  board-on-bed map dots). Mirrors the v2 handoff palette: registration=blue,
 *  pth=orange, npth=grey, mechanical=green. */
export const DRILL_CLASS_COLOR: Record<DrillClass, string> = {
  registration: "#3b9eff",
  pth: "#e8893a",
  npth: "#9aa3af",
  mechanical: "#3fbf6f",
};

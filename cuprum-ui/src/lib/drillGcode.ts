import type { PanelDrillPlan, DrillGroup, PlanHole } from "@/lib/panelDrill";
import type { CncProfile } from "@/lib/cncProfile";
import type { Tool } from "@/lib/toolLibrary";
import { orderNearest } from "@/lib/drillRoute";

/** Context for emitting a drill program: the panel height (for the Y-flip),
 *  the CNC profile (safe-Z / spindle / G-code wrappers), the tool library (rpm /
 *  plunge by id) and the substrate thickness (depth). `opts` tunes breakthrough
 *  and optional manual peck. */
export interface DrillGcodeCtx {
  panelHeightMm: number;
  profile: CncProfile;
  tools: Tool[];
  substrateThicknessMm: number;
  opts?: { breakthroughMm?: number; peckDepthMm?: number };
}

export interface DrillGcodeResult {
  gcode: string;
  /** Diameters of groups skipped because they have no matching tool. */
  skippedDiametersMm: number[];
}

/** Drill registration holes first (they set the datum), then ascending diameter. */
const CLASS_ORDER: Record<DrillGroup["class"], number> = {
  registration: 0,
  pth: 1,
  npth: 2,
  mechanical: 3,
};

const fmt = (n: number) => n.toFixed(3);

/** Panel space (Y-down, origin top-left) → machine (Y-up, origin = panel bottom-left). */
function machineXY(h: PlanHole, panelHeightMm: number): [number, number] {
  return [h.xMm, panelHeightMm - h.yMm];
}

/** Emit a GRBL drill program for the whole panel. Pure. */
export function emitDrillGcode(plan: PanelDrillPlan, ctx: DrillGcodeCtx): DrillGcodeResult {
  const { panelHeightMm, profile, tools, substrateThicknessMm } = ctx;
  const breakthrough = ctx.opts?.breakthroughMm ?? 0.3;
  const peck = ctx.opts?.peckDepthMm ?? 0;
  const safeZ = profile.safeZMm;
  const depth = substrateThicknessMm + breakthrough; // positive magnitude; drill to -depth
  const toolById = new Map(tools.map((t) => [t.id, t]));

  const lines: string[] = [];
  const skipped: number[] = [];

  const groups = [...plan.groups].sort(
    (a, b) => CLASS_ORDER[a.class] - CLASS_ORDER[b.class] || a.diameterMm - b.diameterMm,
  );

  if (profile.prependGcode.trim()) lines.push(profile.prependGcode.trim());
  lines.push("G21 G90 G94 G17");
  lines.push(`G0 Z${fmt(safeZ)}`);

  let curX = 0;
  let curY = 0;
  let firstGroup = true;

  for (const g of groups) {
    const tool = g.toolId ? toolById.get(g.toolId) : undefined;
    if (!tool) {
      skipped.push(g.diameterMm);
      lines.push(`(SKIP: no tool for D${fmt(g.diameterMm)} — ${g.holes.length} holes)`);
      continue;
    }

    // Tool change: stop spindle, retract, pause for the operator, then spin up.
    lines.push("M5");
    // The preamble already retracted to safe Z (and every hole ends at safe Z),
    // so the first group is already there; retract defensively before later ones.
    if (!firstGroup) lines.push(`G0 Z${fmt(safeZ)}`);
    firstGroup = false;
    lines.push(`(insert drill D${fmt(tool.diameterMm)} — ${tool.name})`);
    lines.push("M0");
    if (profile.spindleControllable) {
      lines.push(`M3 S${Math.round(Math.min(tool.recommendedRpm, profile.spindleMaxRpm))}`);
    } else {
      lines.push(`(set spindle ~${Math.round(tool.recommendedRpm)} rpm)`);
      lines.push("M3");
    }

    const machinePts = g.holes.map((h) => machineXY(h, panelHeightMm));
    const order = orderNearest(machinePts, curX, curY);
    const plunge = Math.round(tool.recommendedPlungeMmMin);

    for (const idx of order) {
      const [mx, my] = machinePts[idx];
      lines.push(`G0 X${fmt(mx)} Y${fmt(my)}`);
      if (peck > 0 && peck < depth) {
        // Manual peck: plunge in `peck` increments, retracting to safe Z to clear
        // chips between bites. (GRBL has no G83 canned cycle.)
        // TODO(peck): full-retract style — each bite re-plunges from safeZ through the
        // already-cut upper hole at feed rate. Safe but slow for many small increments.
        // Future: rapid down to near the previous depth, then G1 only through the new bite.
        let z = 0;
        while (z < depth - 1e-9) {
          z = Math.min(z + peck, depth);
          lines.push(`G1 Z${fmt(-z)} F${plunge}`);
          lines.push(`G0 Z${fmt(safeZ)}`);
        }
      } else {
        lines.push(`G1 Z${fmt(-depth)} F${plunge}`);
        lines.push(`G0 Z${fmt(safeZ)}`);
      }
      curX = mx;
      curY = my;
    }
  }

  lines.push("M5");
  lines.push(`G0 Z${fmt(safeZ)}`);
  if (profile.appendGcode.trim()) lines.push(profile.appendGcode.trim());
  lines.push("M2");

  return { gcode: lines.join("\n") + "\n", skippedDiametersMm: skipped };
}

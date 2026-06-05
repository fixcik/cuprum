import type { PanelDrillPlan, DrillGroup, PlanHole } from "@/lib/panelDrill";
import type { CncProfile } from "@/lib/cncProfile";
import type { Tool } from "@/lib/toolLibrary";
import type { Rect } from "@/lib/keepoutGeometry";
import { avoidZones, KEEPOUT_TRAVERSE_MARGIN_MM } from "@/lib/keepoutGeometry";
import { orderNearest } from "@/lib/drillRoute";

/** Context for emitting a drill program: the panel height (for the Y-flip),
 *  the CNC profile (safe-Z / spindle / G-code wrappers), the tool library (rpm /
 *  plunge by id) and the substrate thickness (depth). `opts` tunes breakthrough
 *  and optional manual peck. `keepOutZones` (panel-space) inserts detour waypoints
 *  in the rapid traverse between holes so the spindle avoids clamp bodies. */
export interface DrillGcodeCtx {
  panelHeightMm: number;
  profile: CncProfile;
  tools: Tool[];
  substrateThicknessMm: number;
  opts?: { breakthroughMm?: number; peckDepthMm?: number };
  keepOutZones?: Rect[];
}

export interface DrillGcodeResult {
  gcode: string;
  /** Diameters of groups skipped because they have no matching tool. */
  skippedDiametersMm: number[];
}

export interface DrillStep {
  lines: string[];                 // G-code lines streamed for this step (no trailing newline)
  kind: "preamble" | "toolchange" | "hole" | "postamble";
  pauseForToolChange?: boolean;    // toolchange step only
  toolName?: string;               // toolchange step only
  diameterMm?: number;             // toolchange step only
  holeIndex?: number;              // hole step only: index into planDrillRoute(...).pathPoints
}

export interface DrillProgramResult {
  gcode: string;            // identical to emitDrillGcode(...).gcode
  steps: DrillStep[];
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

/** Internal builder: produces both the flat lines array (for gcode text) and
 *  the structured steps array simultaneously. */
function buildDrillProgram(plan: PanelDrillPlan, ctx: DrillGcodeCtx): DrillProgramResult {
  const { panelHeightMm, profile, tools, substrateThicknessMm } = ctx;
  const breakthrough = ctx.opts?.breakthroughMm ?? 0.3;
  const peck = ctx.opts?.peckDepthMm ?? 0;
  const safeZ = profile.safeZMm;
  const depth = substrateThicknessMm + breakthrough; // positive magnitude; drill to -depth
  const toolById = new Map(tools.map((t) => [t.id, t]));

  // Pre-compute machine-space keep-out zones (Y-flip from panel to machine coords).
  // Panel: Y-down, origin top-left. Machine: Y-up, origin panel bottom-left.
  // Zone panel y-range [y, y+h] → machine y-range [panelH-(y+h), panelH-y].
  const zonesMachine = (ctx.keepOutZones ?? []).map((z) => ({
    x: z.x,
    y: panelHeightMm - (z.y + z.h),
    w: z.w,
    h: z.h,
  }));

  const allLines: string[] = [];
  const steps: DrillStep[] = [];
  const skipped: number[] = [];

  const groups = [...plan.groups].sort(
    (a, b) => CLASS_ORDER[a.class] - CLASS_ORDER[b.class] || a.diameterMm - b.diameterMm,
  );

  // --- Preamble step ---
  const preambleLines: string[] = [];
  if (profile.prependGcode.trim()) preambleLines.push(profile.prependGcode.trim());
  preambleLines.push("G21 G90 G94 G17");
  preambleLines.push(`G0 Z${fmt(safeZ)}`);
  for (const l of preambleLines) allLines.push(l);
  steps.push({ kind: "preamble", lines: preambleLines });

  let curX = 0;
  let curY = 0;
  let firstGroup = true;
  let holeCounter = 0;

  for (const g of groups) {
    const tool = g.toolId ? toolById.get(g.toolId) : undefined;
    if (!tool) {
      skipped.push(g.diameterMm);
      const skipLine = `(SKIP: no tool for D${fmt(g.diameterMm)} — ${g.holes.length} holes)`;
      allLines.push(skipLine);
      continue;
    }

    // Tool change: stop spindle, retract, pause for the operator, then spin up.
    // toolchange step lines: M5, optional G0 Z<safe>, comment — but NOT M0
    const tcLines: string[] = [];
    tcLines.push("M5");
    allLines.push("M5");

    // The preamble already retracted to safe Z (and every hole ends at safe Z),
    // so the first group is already there; retract defensively before later ones.
    if (!firstGroup) {
      tcLines.push(`G0 Z${fmt(safeZ)}`);
      allLines.push(`G0 Z${fmt(safeZ)}`);
    }
    firstGroup = false;

    const commentLine = `(insert drill D${fmt(tool.diameterMm)} — ${tool.name})`;
    tcLines.push(commentLine);
    allLines.push(commentLine);

    // M0 goes into gcode text only, not into the step lines
    allLines.push("M0");

    steps.push({
      kind: "toolchange",
      lines: tcLines,
      pauseForToolChange: true,
      toolName: tool.name,
      diameterMm: tool.diameterMm,
    });

    // Spindle-up lines: prefixed onto the FIRST hole step of this group.
    // They are NOT pushed to allLines here — they'll be pushed when building
    // the first hole step below (so they appear in the text at the right position).
    const spindleUpLines: string[] = [];
    if (profile.spindleControllable) {
      spindleUpLines.push(`M3 S${Math.round(Math.min(tool.recommendedRpm, profile.spindleMaxRpm))}`);
    } else {
      spindleUpLines.push(`(set spindle ~${Math.round(tool.recommendedRpm)} rpm)`);
      spindleUpLines.push("M3");
    }

    const machinePts = g.holes.map((h) => machineXY(h, panelHeightMm));
    const order = orderNearest(machinePts, curX, curY);
    const plunge = Math.round(tool.recommendedPlungeMmMin);

    for (let oi = 0; oi < order.length; oi++) {
      const idx = order[oi];
      const [mx, my] = machinePts[idx];

      const holeLines: string[] = [];

      // Prepend spindle-up lines onto the very first hole of this group
      if (oi === 0) {
        for (const sl of spindleUpLines) {
          holeLines.push(sl);
          allLines.push(sl);
        }
      }

      // Emit detour waypoints (XY-only rapids at safe Z) before the hole rapid.
      if (zonesMachine.length > 0) {
        const waypoints = avoidZones(
          { x: curX, y: curY },
          { x: mx, y: my },
          zonesMachine,
          KEEPOUT_TRAVERSE_MARGIN_MM,
        );
        for (const wp of waypoints) {
          const wpLine = `G0 X${fmt(wp.x)} Y${fmt(wp.y)}`;
          holeLines.push(wpLine);
          allLines.push(wpLine);
        }
      }

      holeLines.push(`G0 X${fmt(mx)} Y${fmt(my)}`);
      allLines.push(`G0 X${fmt(mx)} Y${fmt(my)}`);

      if (peck > 0 && peck < depth) {
        let z = 0;
        while (z < depth - 1e-9) {
          z = Math.min(z + peck, depth);
          holeLines.push(`G1 Z${fmt(-z)} F${plunge}`);
          allLines.push(`G1 Z${fmt(-z)} F${plunge}`);
          holeLines.push(`G0 Z${fmt(safeZ)}`);
          allLines.push(`G0 Z${fmt(safeZ)}`);
        }
      } else {
        holeLines.push(`G1 Z${fmt(-depth)} F${plunge}`);
        allLines.push(`G1 Z${fmt(-depth)} F${plunge}`);
        holeLines.push(`G0 Z${fmt(safeZ)}`);
        allLines.push(`G0 Z${fmt(safeZ)}`);
      }

      steps.push({ kind: "hole", lines: holeLines, holeIndex: holeCounter });
      holeCounter++;

      curX = mx;
      curY = my;
    }
  }

  // --- Postamble step ---
  // lines: M5, G0 Z<safe>, optional append — but NOT M2
  const postambleLines: string[] = [];
  postambleLines.push("M5");
  allLines.push("M5");
  postambleLines.push(`G0 Z${fmt(safeZ)}`);
  allLines.push(`G0 Z${fmt(safeZ)}`);
  if (profile.appendGcode.trim()) {
    postambleLines.push(profile.appendGcode.trim());
    allLines.push(profile.appendGcode.trim());
  }
  // M2 goes into gcode text only, not into step lines
  allLines.push("M2");
  steps.push({ kind: "postamble", lines: postambleLines });

  return { gcode: allLines.join("\n") + "\n", steps, skippedDiametersMm: skipped };
}

/** Emit a structured drill program with both the gcode text and run steps. */
export function emitDrillProgram(plan: PanelDrillPlan, ctx: DrillGcodeCtx): DrillProgramResult {
  return buildDrillProgram(plan, ctx);
}

/** Emit a GRBL drill program for the whole panel. Pure. */
export function emitDrillGcode(plan: PanelDrillPlan, ctx: DrillGcodeCtx): DrillGcodeResult {
  const { gcode, skippedDiametersMm } = buildDrillProgram(plan, ctx);
  return { gcode, skippedDiametersMm };
}

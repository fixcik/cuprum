import type { PanelDrillPlan, DrillGroup } from "@/lib/panelDrill";
import type { CncProfile } from "@/lib/cncProfile";
import type { Tool } from "@/lib/toolLibrary";
import type { Rect } from "@/lib/keepoutGeometry";
import { avoidZones, KEEPOUT_TRAVERSE_MARGIN_MM } from "@/lib/keepoutGeometry";
import { orderNearest } from "@/lib/drillRoute";
import { type DatumCorner, machinePoint } from "@/lib/datum";

/** Context for emitting a drill program: the panel height (for the Y-flip),
 *  the CNC profile (safe-Z / spindle / G-code wrappers), the tool library (rpm /
 *  plunge by id) and the substrate thickness (depth). `opts` tunes breakthrough
 *  and optional manual peck. `keepOutZones` (panel-space) inserts detour waypoints
 *  in the rapid traverse between holes so the spindle avoids clamp bodies.
 *  `datumCorner` selects which panel corner is machine (0,0); defaults to
 *  "bottom-left" (existing behaviour). `panelWidthMm` is required for non-left
 *  datums but unused (and may be omitted) when datum is "bottom-left". */
export interface DrillGcodeCtx {
  panelHeightMm: number;
  panelWidthMm?: number;
  datumCorner?: DatumCorner;
  profile: CncProfile;
  tools: Tool[];
  substrateThicknessMm: number;
  opts?: { breakthroughMm?: number; peckDepthMm?: number };
  keepOutZones?: Rect[];
  /** Actual machine WORK position (mm) when the run starts. Used ONLY as the
   *  origin for the first traverse's keep-out avoidance — the bit may not be
   *  parked at work zero (0,0) when the operator hits Start (after homing, a jog,
   *  or a previous pass), so planning the first move from (0,0) would route it
   *  straight through a clamp. Hole ORDER is unaffected (still ordered from the
   *  datum corner so the preview route and progress highlights stay in sync).
   *  Defaults to (0,0) — byte-identical output when omitted. */
  startMachineXY?: { x: number; y: number };
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
  // hole step only: 0-based index into the actual drilled-hole sequence (matches
  // gIdx in DrillMapCanvas). NOT an index into pathPoints, which may also contain
  // keep-out detour waypoints.
  holeIndex?: number;
}

export interface DrillProgramResult {
  gcode: string;            // identical to emitDrillGcode(...).gcode
  steps: DrillStep[];
  skippedDiametersMm: number[];
}

/** Default breakthrough (mm) past the bottom of the substrate to ensure clean perforation. */
export const DEFAULT_BREAKTHROUGH_MM = 0.3;

/** Drill registration holes first (they set the datum), then ascending diameter. */
const CLASS_ORDER: Record<DrillGroup["class"], number> = {
  registration: 0,
  pth: 1,
  npth: 2,
  mechanical: 3,
};

const fmt = (n: number) => n.toFixed(3);

/** Internal builder: produces both the flat lines array (for gcode text) and
 *  the structured steps array simultaneously. */
function buildDrillProgram(plan: PanelDrillPlan, ctx: DrillGcodeCtx): DrillProgramResult {
  const { panelHeightMm, profile, tools, substrateThicknessMm } = ctx;
  const datum: DatumCorner = ctx.datumCorner ?? "bottom-left";
  const wMm = ctx.panelWidthMm ?? 0;
  const breakthrough = ctx.opts?.breakthroughMm ?? DEFAULT_BREAKTHROUGH_MM;
  const peck = ctx.opts?.peckDepthMm ?? 0;
  const safeZ = profile.safeZMm;
  const toolChangeZ = profile.toolChangeZMm; // higher park for a manual bit swap
  const depth = substrateThicknessMm + breakthrough; // positive magnitude; drill to -depth
  const toolById = new Map(tools.map((t) => [t.id, t]));

  // Pre-compute machine-space keep-out zones using the same machinePoint transform
  // used for holes, so avoidance is consistent for any datum corner.
  // For a panel-space rect (zx, zy, zw, zh) we map its four corner extremes and
  // take the min/max to form a valid AABB regardless of coordinate sign flips.
  const zonesMachine = (ctx.keepOutZones ?? []).map((z) => {
    const [x1, y1] = machinePoint(z.x,        z.y,        datum, wMm, panelHeightMm);
    const [x2, y2] = machinePoint(z.x + z.w,  z.y + z.h, datum, wMm, panelHeightMm);
    const minX = Math.min(x1, x2);
    const minY = Math.min(y1, y2);
    return { x: minX, y: minY, w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  });

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
  // NO Z park here. In the per-tool-Z model work-Z is unbound until the first
  // tool-change probe (which runs AFTER this preamble), so a work-frame Z move
  // (`G0 Z<toolChangeZ>`) would target the stale EEPROM G54 Z offset and trip the
  // Z soft limit → ALARM:2 on start. The bit stays at its post-homing Z for the
  // first bit insertion; the first probe establishes work-Z (see DrillToolChangeCard).
  for (const l of preambleLines) allLines.push(l);
  steps.push({ kind: "preamble", lines: preambleLines });

  // Ordering cursor: starts at the datum corner (machine 0,0) so hole order
  // matches the preview route and the progress highlights stay in sync.
  let curX = 0;
  let curY = 0;
  // Travel cursor for keep-out avoidance: starts at the real machine position
  // (the bit may not be at work zero when the run starts) so the FIRST traverse
  // routes around clamps. After the first hole it tracks the bit like curX/curY.
  let travelX = ctx.startMachineXY?.x ?? 0;
  let travelY = ctx.startMachineXY?.y ?? 0;
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

    // First group: no Z retract — work-Z isn't bound yet (the first probe sets it),
    // so any work-frame Z move would be unsafe. The bit is at its post-homing Z.
    // Later groups: work-Z is bound from the previous tool's probe and every hole
    // ends at safe Z, so retract to the high tool-change Z before the swap.
    if (!firstGroup) {
      tcLines.push(`G0 Z${fmt(toolChangeZ)}`);
      allLines.push(`G0 Z${fmt(toolChangeZ)}`);
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

    const machinePts = g.holes.map((h) => machinePoint(h.xMm, h.yMm, datum, wMm, panelHeightMm));
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
          { x: travelX, y: travelY },
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
      travelX = mx;
      travelY = my;
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

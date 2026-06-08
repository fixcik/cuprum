import { api } from "@/lib/api";
import { packLayoutAvoiding, type Box, type RenestTransform } from "@/lib/panelPlacement";
import type { NestSettings } from "@/lib/nest";

/** One packed copy: footprint top-left (mm) + 90° flag. */
export type SolvedPlacement = { x: number; y: number; rotated: boolean };

export interface SolvedPack {
  placements: SolvedPlacement[];
  /** How many copies were requested (so callers can report overflow). */
  requested: number;
}

const SOLVE_BUDGET_MS = 300;

/** Build the Rust-solver request for one design, mirroring the nesting recipe.
 *  `clearanceMm` doubles as the board gap (UV/cut clearance == board gap today). */
function solverReq(opts: {
  boardW: number;
  boardH: number;
  panelW: number;
  panelH: number;
  nest: NestSettings;
  obstacles: Box[];
  clearanceMm: number;
  requested: number;
}) {
  const { boardW, boardH, panelW, panelH, nest, obstacles, clearanceMm, requested } = opts;
  return {
    boardW,
    boardH,
    panelW,
    panelH,
    requested,
    marginMm: nest.enabled ? nest.marginMm : 0,
    gapMm: clearanceMm,
    clearanceMm,
    mixRotation: nest.enabled && nest.mixRotation,
    forceRotate: nest.enabled && nest.rotate,
    obstacles,
    timeBudgetMs: SOLVE_BUDGET_MS,
  };
}

/** Greedy first (instant, neat grid for simple panels); if it falls short, ask the
 *  Rust solver for a denser pack and adopt it only when strictly better. Mirrors the
 *  real placement path so previews/counts match what "Add design" will produce. */
export async function solvePanelPlacements(opts: {
  boardW: number;
  boardH: number;
  panelW: number;
  panelH: number;
  nest: NestSettings;
  obstacles: Box[];
  clearanceMm: number;
}): Promise<SolvedPack> {
  const { boardW, boardH, panelW, panelH, nest, obstacles, clearanceMm } = opts;
  const pack = packLayoutAvoiding(boardW, boardH, panelW, panelH, nest, obstacles, clearanceMm);
  let placements: SolvedPlacement[] = pack.placements;
  if (pack.n < pack.requested && pack.requested > 0) {
    try {
      const solved = await api.packPanel(
        solverReq({ boardW, boardH, panelW, panelH, nest, obstacles, clearanceMm, requested: pack.requested }),
      );
      if (solved.length > placements.length) placements = solved;
    } catch {
      /* backend unavailable → keep greedy */
    }
  }
  return { placements, requested: pack.requested };
}

/** Re-nest a selection through the solver: pack each design group (in first-seen
 *  order) avoiding non-selected boards AND groups already placed this run. Returns
 *  the centre-pivot transforms, mirroring `renestSelection` but solver-backed. */
export async function solveRenest(opts: {
  selected: { id: string; design_id: string }[];
  sizes: Record<string, { w: number; h: number }>;
  obstacles: Box[];
  panelW: number;
  panelH: number;
  nest: NestSettings;
}): Promise<{ transforms: RenestTransform[]; requested: number; placed: number }> {
  const { selected, sizes, obstacles, panelW, panelH, nest } = opts;
  const order: string[] = [];
  const groups = new Map<string, string[]>();
  for (const s of selected) {
    if (!groups.has(s.design_id)) {
      groups.set(s.design_id, []);
      order.push(s.design_id);
    }
    groups.get(s.design_id)!.push(s.id);
  }
  const placedBoxes: Box[] = [...obstacles];
  const transforms: RenestTransform[] = [];
  let requested = 0;
  let placed = 0;
  for (const designId of order) {
    const ids = groups.get(designId)!;
    const sz = sizes[designId];
    if (!sz) continue;
    requested += ids.length;
    const solved = await api.packPanel(
      solverReq({
        boardW: sz.w,
        boardH: sz.h,
        panelW,
        panelH,
        nest: { ...nest, enabled: true },
        obstacles: placedBoxes,
        clearanceMm: nest.gapMm,
        requested: ids.length,
      }),
    );
    placed += solved.length;
    solved.forEach((p, k) => {
      const fw = p.rotated ? sz.h : sz.w;
      const fh = p.rotated ? sz.w : sz.h;
      transforms.push({
        id: ids[k],
        x_mm: p.rotated ? p.x + (sz.h - sz.w) / 2 : p.x,
        y_mm: p.rotated ? p.y + (sz.w - sz.h) / 2 : p.y,
        rotation_deg: p.rotated ? 90 : 0,
      });
      placedBoxes.push({ minX: p.x, minY: p.y, maxX: p.x + fw, maxY: p.y + fh });
    });
  }
  return { transforms, requested, placed };
}

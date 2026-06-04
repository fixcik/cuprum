import type { NestSettings } from "@/lib/nest";
import type { BoardInstance, KeepOutKind, KeepOutZone, ToolingHole, ToolingHoleRole } from "@/lib/api";

/** Axis-aligned bounding box (mm). */
export type Box = { minX: number; minY: number; maxX: number; maxY: number };

/** Result of packing a board into a panel under a nesting recipe. All mm. */
export interface PackResult {
  /** Effective board footprint after optional 90° rotation. */
  bw: number;
  bh: number;
  cols: number;
  rows: number;
  /** Maximum boards that fit (cols * rows). */
  max: number;
  /** How many were requested (1 when disabled; copies; or fill-percentage count). */
  requested: number;
  /** Actually placed = clamp(requested, 0, max). overflow = requested > max. */
  n: number;
  /** Top-left positions of each placed board, in panel mm. */
  placements: { x: number; y: number }[];
}

/** Strict AABB overlap (touching edges do not count) with a float tolerance. */
export function boxesOverlap(a: Box, b: Box, tol = 1e-6): boolean {
  return a.minX < b.maxX - tol && a.maxX > b.minX + tol && a.minY < b.maxY - tol && a.maxY > b.minY + tol;
}

/** Minimum keep-out zone side (mm). */
export const KEEPOUT_MIN_MM = 1;

/** Normalise a (possibly negative-size) zone rect to positive w/h, clamp it into
 *  [0,W]×[0,H] trimming BOTH edges, and enforce a minimum size. Authoritative
 *  geometry guard shared by add + resize of keep-out zones. */
export function clampZoneRect(
  rect: { x_mm: number; y_mm: number; width_mm: number; height_mm: number },
  panelW: number,
  panelH: number,
  minMm: number,
): { x_mm: number; y_mm: number; width_mm: number; height_mm: number } {
  const nx = rect.width_mm < 0 ? rect.x_mm + rect.width_mm : rect.x_mm;
  const ny = rect.height_mm < 0 ? rect.y_mm + rect.height_mm : rect.y_mm;
  const nw = Math.abs(rect.width_mm);
  const nh = Math.abs(rect.height_mm);
  let cx = Math.max(0, Math.min(nx, panelW));
  let cy = Math.max(0, Math.min(ny, panelH));
  let cw = Math.min(nx + nw, panelW) - cx;
  let ch = Math.min(ny + nh, panelH) - cy;
  if (cw < minMm) { cw = Math.min(minMm, panelW); cx = Math.min(cx, panelW - cw); }
  if (ch < minMm) { ch = Math.min(minMm, panelH); cy = Math.min(cy, panelH - ch); }
  return { x_mm: cx, y_mm: cy, width_mm: cw, height_mm: ch };
}

/** Like {@link packLayout}, but avoids `obstacles` (existing instances' AABBs, mm).
 *
 * - **No obstacles** → exact even grid (identical to packLayout; preserves parity).
 * - **Obstacles present** → greedy fill on a FIXED candidate lattice whose step is
 *   `nest.snapMm > 0 ? nest.snapMm : 1` mm, independent of `gap`. A larger gap can
 *   only shrink the set of feasible positions, so the placed count is monotonically
 *   non-increasing as gap grows (no phase-flip artefacts from the grid pitch).
 *   Each candidate is accepted when it fits inside the margin band, does not overlap
 *   any obstacle inflated by `clearanceMm`, and does not overlap any already-placed
 *   copy inflated by `gap`. `cols/rows/max/requested` are computed as before.
 */
export function packLayoutAvoiding(
  boardWmm: number,
  boardHmm: number,
  panelWmm: number,
  panelHmm: number,
  nest: NestSettings,
  obstacles: Box[] = [],
  clearanceMm = 0,
): PackResult {
  let bw = boardWmm;
  let bh = boardHmm;
  if (nest.enabled && nest.rotate) {
    const t = bw;
    bw = bh;
    bh = t;
  }
  const margin = nest.enabled ? nest.marginMm : 0;
  const gap = nest.enabled ? nest.gapMm : 0;
  const innerW = panelWmm - 2 * margin;
  const innerH = panelHmm - 2 * margin;
  const cols = bw + gap > 0 ? Math.max(0, Math.floor((innerW + gap) / (bw + gap))) : 0;
  const rows = bh + gap > 0 ? Math.max(0, Math.floor((innerH + gap) / (bh + gap))) : 0;
  const max = cols * rows;

  let requested: number;
  if (!nest.enabled) requested = 1;
  else if (nest.fillMode === "copies") requested = nest.copies;
  else requested = Math.floor((max * nest.fillPct) / 100);

  // Clean panel → exact even grid (unchanged; preserves packLayout parity).
  if (obstacles.length === 0) {
    const placements: { x: number; y: number }[] = [];
    for (let i = 0; i < max && placements.length < requested; i++) {
      let r: number;
      let c: number;
      if (nest.enabled && nest.dir === "cols") {
        c = Math.floor(i / Math.max(1, rows));
        r = i % Math.max(1, rows);
      } else {
        r = Math.floor(i / Math.max(1, cols));
        c = i % Math.max(1, cols);
      }
      let x =
        nest.corner === "tr" || nest.corner === "br"
          ? panelWmm - margin - (c + 1) * bw - c * gap
          : margin + c * (bw + gap);
      let y =
        nest.corner === "bl" || nest.corner === "br"
          ? panelHmm - margin - (r + 1) * bh - r * gap
          : margin + r * (bh + gap);
      if (nest.enabled && nest.snapMm > 0) {
        x = Math.round(x / nest.snapMm) * nest.snapMm;
        y = Math.round(y / nest.snapMm) * nest.snapMm;
      }
      placements.push({ x, y });
    }
    return { bw, bh, cols, rows, max, requested, n: placements.length, placements };
  }

  // Obstacles present → greedy fill on a FIXED candidate lattice (independent of gap),
  // so a larger gap can only remove feasible positions, never add (monotonic).
  const inflate = (b: Box, by: number): Box => ({
    minX: b.minX - by,
    minY: b.minY - by,
    maxX: b.maxX + by,
    maxY: b.maxY + by,
  });
  const infObstacles = obstacles.map((o) => inflate(o, clearanceMm));
  const step = nest.snapMm > 0 ? nest.snapMm : 1; // gap-independent lattice pitch (mm)
  const x0 = margin;
  const y0 = margin;
  const xEnd = panelWmm - margin - bw; // last fitting top-left x
  const yEnd = panelHmm - margin - bh; // last fitting top-left y
  // Candidate coordinates honouring the anchor corner. Generated directly in the
  // anchor direction so the corner-adjacent position (xEnd/yEnd) is always included
  // even when `step` doesn't divide the range — the first candidate sits flush to
  // the chosen corner. Order controls which cells win the `requested` cap, not the count.
  const axisCandidates = (start: number, end: number, fromEnd: boolean): number[] => {
    const out: number[] = [];
    if (fromEnd) {
      for (let v = end; v >= start - 1e-9; v -= step) out.push(v);
    } else {
      for (let v = start; v <= end + 1e-9; v += step) out.push(v);
    }
    return out;
  };
  const xs = axisCandidates(x0, xEnd, nest.corner === "tr" || nest.corner === "br");
  const ys = axisCandidates(y0, yEnd, nest.corner === "bl" || nest.corner === "br");
  const placed: Box[] = [];
  const placements: { x: number; y: number }[] = [];
  const tryCell = (x: number, y: number): void => {
    if (placements.length >= requested) return;
    const cell = { minX: x, minY: y, maxX: x + bw, maxY: y + bh };
    if (infObstacles.some((o) => boxesOverlap(cell, o))) return;
    if (placed.some((p) => boxesOverlap(cell, inflate(p, gap)))) return; // gap between copies
    placed.push(cell);
    placements.push({ x, y });
  };
  // dir "cols" → iterate columns (x outer), else rows (y outer) — mirrors the grid path.
  if (nest.dir === "cols") {
    for (const x of xs) {
      if (placements.length >= requested) break;
      for (const y of ys) {
        if (placements.length >= requested) break;
        tryCell(x, y);
      }
    }
  } else {
    for (const y of ys) {
      if (placements.length >= requested) break;
      for (const x of xs) {
        if (placements.length >= requested) break;
        tryCell(x, y);
      }
    }
  }
  return { bw, bh, cols, rows, max, requested, n: placements.length, placements };
}

/** Grid-pack `nest` copies of a board into a panel, anchored to a corner.
 *  Identical rectangles only (real heterogeneous nesting is a later task). */
export function packLayout(
  boardWmm: number,
  boardHmm: number,
  panelWmm: number,
  panelHmm: number,
  nest: NestSettings,
): PackResult {
  return packLayoutAvoiding(boardWmm, boardHmm, panelWmm, panelHmm, nest, [], 0);
}

/** Axis-aligned bounding box (mm) of a placed board. `(x, y)` is the top-left of
 *  the UNROTATED board; `rotation_deg` is an arbitrary angle about the board
 *  CENTRE (`cx = x + W/2`, `cy = y + H/2`). The four corners are rotated about the
 *  centre and min/max'd — a true rotated-quad AABB (the right-angle cases are just
 *  special values). This is the single pose model shared by packLayout, the canvas
 *  (Konva rotation about centre) and the off-panel / clamp checks. */
export function instanceBounds(opts: {
  xMm: number;
  yMm: number;
  boardW: number;
  boardH: number;
  rotationDeg: number;
}): { minX: number; minY: number; maxX: number; maxY: number } {
  const { xMm, yMm, boardW, boardH, rotationDeg } = opts;
  const cx = xMm + boardW / 2;
  const cy = yMm + boardH / 2;
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corners = [
    [xMm, yMm],
    [xMm + boardW, yMm],
    [xMm, yMm + boardH],
    [xMm + boardW, yMm + boardH],
  ];
  const xs = corners.map(([px, py]) => cx + (px - cx) * cos - (py - cy) * sin);
  const ys = corners.map(([px, py]) => cy + (px - cx) * sin + (py - cy) * cos);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** True if a placed board pokes outside the panel rectangle [0,panelW]×[0,panelH].
 *  Used to warn (not block) when shrinking the blank leaves a design hanging off
 *  the edge. The tolerance absorbs float noise so a board flush with the edge
 *  isn't flagged. All mm. */
export function isOffPanel(opts: {
  xMm: number;
  yMm: number;
  boardW: number;
  boardH: number;
  rotationDeg: number;
  panelW: number;
  panelH: number;
  tolMm?: number;
}): boolean {
  const tol = opts.tolMm ?? 1e-3;
  const b = instanceBounds(opts);
  return b.minX < -tol || b.minY < -tol || b.maxX > opts.panelW + tol || b.maxY > opts.panelH + tol;
}

/** Clamp a move delta (mm) so every supplied AABB stays within [0,panelW]×[0,panelH].
 *  Clamps each axis to the tightest bound across all boxes. */
export function clampDeltaToPanel(
  boxes: Box[],
  dxMm: number,
  dyMm: number,
  panelW: number,
  panelH: number,
): { dx: number; dy: number } {
  let dx = dxMm;
  let dy = dyMm;
  for (const b of boxes) {
    if (b.minX + dx < 0) dx = -b.minX;
    if (b.maxX + dx > panelW) dx = panelW - b.maxX;
    if (b.minY + dy < 0) dy = -b.minY;
    if (b.maxY + dy > panelH) dy = panelH - b.maxY;
  }
  return { dx, dy };
}

/** Shift a single instance pose so its (rotated) AABB sits fully inside the panel
 *  [0,panelW]×[0,panelH]; an already-inside pose is returned unchanged. Used by the
 *  numeric placement inspector so typed X/Y/rotation can't push a board off-panel
 *  (same clamp the drag/nudge paths use). Returns the corrected top-left origin. */
export function clampPoseIntoPanel(
  pose: { x_mm: number; y_mm: number; rotation_deg: number },
  boardW: number,
  boardH: number,
  panelW: number,
  panelH: number,
): { x_mm: number; y_mm: number } {
  const b = instanceBounds({ xMm: pose.x_mm, yMm: pose.y_mm, boardW, boardH, rotationDeg: pose.rotation_deg });
  const { dx, dy } = clampDeltaToPanel([b], 0, 0, panelW, panelH);
  return { x_mm: pose.x_mm + dx, y_mm: pose.y_mm + dy };
}

/** Build rotated-AABB boxes for instances whose board size is known. Instances
 *  with no resolved size are skipped (their extents are unknown). Shared by the
 *  drag, nudge and duplicate clamp paths so they agree on geometry. */
export function boxesForInstances(
  instances: { design_id: string; x_mm: number; y_mm: number; rotation_deg: number }[],
  sizes: Record<string, { w: number; h: number }>,
): Box[] {
  const boxes: Box[] = [];
  for (const i of instances) {
    const sz = sizes[i.design_id];
    if (!sz) continue;
    boxes.push(
      instanceBounds({ xMm: i.x_mm, yMm: i.y_mm, boardW: sz.w, boardH: sz.h, rotationDeg: i.rotation_deg }),
    );
  }
  return boxes;
}

/** Ids whose AABB intersects the marquee rect (mm). */
export function marqueeHits(items: { id: string; box: Box }[], rect: Box): string[] {
  return items
    .filter(({ box }) =>
      box.minX <= rect.maxX && box.maxX >= rect.minX && box.minY <= rect.maxY && box.maxY >= rect.minY,
    )
    .map(({ id }) => id);
}

/** Snap an angle (deg) to 15° (default) or 1° (fine), normalised to [0,360). */
export function snapAngle(deg: number, fine: boolean): number {
  const step = fine ? 1 : 15;
  const snapped = Math.round(deg / step) * step;
  return ((snapped % 360) + 360) % 360;
}

/** Which edge/centre the selection aligns to. Mirrors the layout store's type. */
export type AlignEdge = "left" | "hcenter" | "right" | "top" | "vmiddle" | "bottom";

export type AlignItem = { id: string; x_mm: number; y_mm: number; box: Box };
type Pose = { id: string; x_mm: number; y_mm: number };

const pose = ({ id, x_mm, y_mm }: AlignItem): Pose => ({ id, x_mm, y_mm });

/** Align ≥2 instances to their shared bounding box. Each instance's x_mm/y_mm is
 *  shifted by the delta that moves its rotated AABB edge/centre onto the target;
 *  translating the centre of rotation translates the AABB by the same amount. */
export function alignInstances(items: AlignItem[], edge: AlignEdge): Pose[] {
  if (items.length < 2) return items.map(pose);
  const minX = Math.min(...items.map((i) => i.box.minX));
  const maxX = Math.max(...items.map((i) => i.box.maxX));
  const minY = Math.min(...items.map((i) => i.box.minY));
  const maxY = Math.max(...items.map((i) => i.box.maxY));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return items.map((i) => {
    const bcx = (i.box.minX + i.box.maxX) / 2;
    const bcy = (i.box.minY + i.box.maxY) / 2;
    let dx = 0;
    let dy = 0;
    switch (edge) {
      case "left": dx = minX - i.box.minX; break;
      case "right": dx = maxX - i.box.maxX; break;
      case "hcenter": dx = cx - bcx; break;
      case "top": dy = minY - i.box.minY; break;
      case "bottom": dy = maxY - i.box.maxY; break;
      case "vmiddle": dy = cy - bcy; break;
    }
    return { id: i.id, x_mm: i.x_mm + dx, y_mm: i.y_mm + dy };
  });
}

/** A snap guide line to render while dragging. axis "x" = a vertical line at x=pos
 *  spanning y∈[from,to]; axis "y" = a horizontal line at y=pos spanning x∈[from,to].
 *  All mm. */
export type GuideLine = { axis: "x" | "y"; pos: number; from: number; to: number };

/** Magnetic alignment of a dragged selection to other boards + the panel frame.
 *  `movingBox` is the selection's AABB after the raw drag delta; `targets` are
 *  static AABBs (non-selected instances PLUS the panel box {0,0,W,H} — the panel
 *  box yields its edges and centre for free). Returns the extra delta that aligns
 *  the closest edge/centre pair within `thresholdMm` on each axis (independently),
 *  and the guide lines to draw. No match on an axis → 0 delta and no line there. */
export function computeSmartGuides(opts: {
  movingBox: Box;
  targets: Box[];
  thresholdMm: number;
}): { dx: number; dy: number; guides: GuideLine[] } {
  const { movingBox, targets, thresholdMm } = opts;
  const linesX = (b: Box) => [b.minX, (b.minX + b.maxX) / 2, b.maxX];
  const linesY = (b: Box) => [b.minY, (b.minY + b.maxY) / 2, b.maxY];
  const probesX = linesX(movingBox);
  const probesY = linesY(movingBox);

  // Best (smallest |delta|) snap on one axis across all targets.
  const bestAxis = (
    probes: number[],
    targetLines: (b: Box) => number[],
  ): { delta: number; pos: number; target: Box } | null => {
    let best: { delta: number; pos: number; target: Box } | null = null;
    for (const t of targets) {
      for (const line of targetLines(t)) {
        for (const probe of probes) {
          const d = line - probe;
          if (Math.abs(d) <= thresholdMm && (best === null || Math.abs(d) < Math.abs(best.delta))) {
            best = { delta: d, pos: line, target: t };
          }
        }
      }
    }
    return best;
  };

  const bx = bestAxis(probesX, linesX);
  const by = bestAxis(probesY, linesY);
  const dx = bx?.delta ?? 0;
  const dy = by?.delta ?? 0;

  // Span each guide across the union of the snapped moving box and the matched
  // target, so the line visibly connects the two aligned features.
  const guides: GuideLine[] = [];
  if (bx) {
    const from = Math.min(movingBox.minY + dy, bx.target.minY);
    const to = Math.max(movingBox.maxY + dy, bx.target.maxY);
    guides.push({ axis: "x", pos: bx.pos, from, to });
  }
  if (by) {
    const from = Math.min(movingBox.minX + dx, by.target.minX);
    const to = Math.max(movingBox.maxX + dx, by.target.maxX);
    guides.push({ axis: "y", pos: by.pos, from, to });
  }
  return { dx, dy, guides };
}

export type RenestTransform = { id: string; x_mm: number; y_mm: number; rotation_deg: number };

/** Re-pack a selection into tidy corner-anchored grids, one per design, each
 *  avoiding non-selected instances AND the grids already placed in this run.
 *  Mirrors addBoardInstances' centre-pivot pose for rotated copies. Only the
 *  instances that fit get a transform (placed ≤ requested). Pure. */
export function renestSelection(opts: {
  selected: { id: string; design_id: string }[];
  sizes: Record<string, { w: number; h: number }>;
  obstacles: Box[];
  panelW: number;
  panelH: number;
  nest: NestSettings;
}): { transforms: RenestTransform[]; requested: number; placed: number } {
  const { selected, sizes, obstacles, panelW, panelH, nest } = opts;
  // Group by design id, preserving first-seen order.
  const order: string[] = [];
  const groups = new Map<string, string[]>();
  for (const s of selected) {
    if (!groups.has(s.design_id)) {
      groups.set(s.design_id, []);
      order.push(s.design_id);
    }
    groups.get(s.design_id)!.push(s.id);
  }

  // groupNest forces enabled:true (re-nest always grids), so the packer swaps the
  // footprint on nest.rotate alone — the pose flip must follow the same flag, NOT
  // the raw nest.enabled (false by default → would desync pose from the packed cell).
  const rotated = nest.rotate;
  const placedBoxes: Box[] = [];
  const transforms: RenestTransform[] = [];
  let requested = 0;
  let placed = 0;

  for (const designId of order) {
    const ids = groups.get(designId)!;
    const sz = sizes[designId];
    if (!sz) continue; // unknown size → leave this group untouched
    requested += ids.length;
    const groupNest: NestSettings = {
      ...nest,
      enabled: true,
      fillMode: "copies",
      copies: ids.length,
    };
    const pack = packLayoutAvoiding(
      sz.w, sz.h, panelW, panelH,
      groupNest,
      obstacles.concat(placedBoxes),
      nest.gapMm,
    );
    placed += pack.n;
    pack.placements.forEach((p, k) => {
      transforms.push({
        id: ids[k],
        // Centre-pivot shift: footprint swapped to (h×w); unrotated origin offset
        // so the board centre lands at the same point. Mirrors addBoardInstances.
        x_mm: rotated ? p.x + (sz.h - sz.w) / 2 : p.x,
        y_mm: rotated ? p.y + (sz.w - sz.h) / 2 : p.y,
        rotation_deg: rotated ? 90 : 0,
      });
      placedBoxes.push({ minX: p.x, minY: p.y, maxX: p.x + pack.bw, maxY: p.y + pack.bh });
    });
  }
  return { transforms, requested, placed };
}

/** Axis-aligned bounding box (mm) for a tooling hole, centred on (xMm, yMm) with
 *  side length equal to the bore diameter. */
export function toolingHoleBounds(h: { xMm: number; yMm: number; diameterMm: number }): Box {
  const r = h.diameterMm / 2;
  return { minX: h.xMm - r, minY: h.yMm - r, maxX: h.xMm + r, maxY: h.yMm + r };
}

/** Keep the whole bore inside the panel. If the panel is smaller than the bore,
 *  centre the hole on the panel axis instead. `r` is the bore radius (mm). */
export function clampToolingHoleCenter(
  x: number,
  y: number,
  r: number,
  panelW: number,
  panelH: number,
): { x: number; y: number } {
  const cx = panelW >= 2 * r ? Math.min(panelW - r, Math.max(r, x)) : panelW / 2;
  const cy = panelH >= 2 * r ? Math.min(panelH - r, Math.max(r, y)) : panelH / 2;
  return { x: cx, y: cy };
}

/** Corner positions for a registration-hole set, inset from each edge by
 *  `marginMm` (clamped to half the shorter side so holes stay on the panel).
 *  `count` 4 → all corners (TL, TR, BL, BR); 2 → diagonal pair (TL, BR). All mm. */
export function registrationSetPositions(
  panelW: number,
  panelH: number,
  marginMm: number,
  count: 2 | 4 = 4,
): { x: number; y: number }[] {
  const mx = Math.min(marginMm, panelW / 2);
  const my = Math.min(marginMm, panelH / 2);
  const tl = { x: mx, y: my };
  const tr = { x: panelW - mx, y: my };
  const bl = { x: mx, y: panelH - my };
  const br = { x: panelW - mx, y: panelH - my };
  return count === 2 ? [tl, br] : [tl, tr, bl, br];
}

/** Unified placement-obstacle source: board instances + tooling holes + keep-out zones (raw AABBs).
 *  `packLayoutAvoiding` inflates every obstacle by its `clearance` arg uniformly,
 *  so the fixturing gap around a pin equals the board gap. */
export function panelObstacles(
  panel: {
    instances: BoardInstance[];
    tooling_holes: ToolingHole[];
    keep_out_zones?: KeepOutZone[];
  },
  sizes: Record<string, { w: number; h: number }>,
): Box[] {
  const boards = boxesForInstances(panel.instances, sizes);
  const holes = panel.tooling_holes.map((h) =>
    toolingHoleBounds({ xMm: h.x_mm, yMm: h.y_mm, diameterMm: h.diameter_mm }),
  );
  // Every keep-out kind forbids boards (zoneForbidsBoard === true), so all zones are
  // obstacles for the board packer. The tooling-only "dead" rule is a DFM concern,
  // not a packer one (there is no tooling auto-nester).
  const zones = (panel.keep_out_zones ?? []).map(keepOutBox);
  return [...boards, ...holes, ...zones];
}

// --- Keep-out zone helpers ---

/** True when the zone prohibits board placement. All zone kinds block boards. */
export const zoneForbidsBoard = (_kind: KeepOutKind): boolean => true;

/** True when the zone prohibits tooling holes. Only "dead" zones block tooling. */
export const zoneForbidsTooling = (kind: KeepOutKind): boolean => kind === "dead";

/** AABB of a keep-out zone (panel mm). */
export const keepOutBox = (z: Pick<KeepOutZone, "x_mm" | "y_mm" | "width_mm" | "height_mm">): Box => ({
  minX: z.x_mm,
  minY: z.y_mm,
  maxX: z.x_mm + z.width_mm,
  maxY: z.y_mm + z.height_mm,
});

/** Roles that carry a physical clamp/fixture field around the bore. */
const CLAMPED_ROLES: ToolingHoleRole[] = ["registration", "flip"];

/** Derived clamp keep-out boxes around tooling holes — NOT stored, computed from
 *  holes + the machine profile so they follow/remove with the hole. Empty when
 *  clampRadiusMm <= 0. Each box is an axis-aligned square centred on the hole,
 *  side = diameter + 2·radius. Carries the source hole id (render / DFM attribution). */
export function clampZonesForHoles(
  holes: ToolingHole[],
  clampRadiusMm: number,
): { holeId: string; box: Box }[] {
  if (!(clampRadiusMm > 0)) return [];
  const out: { holeId: string; box: Box }[] = [];
  for (const h of holes) {
    if (!CLAMPED_ROLES.includes(h.role)) continue;
    const half = h.diameter_mm / 2 + clampRadiusMm;
    out.push({
      holeId: h.id,
      box: { minX: h.x_mm - half, minY: h.y_mm - half, maxX: h.x_mm + half, maxY: h.y_mm + half },
    });
  }
  return out;
}

/** Evenly space ≥3 instances' AABB centres along an axis; the extreme two stay put. */
export function distributeInstances(items: AlignItem[], axis: "h" | "v"): Pose[] {
  if (items.length < 3) return items.map(pose);
  const centre = (i: AlignItem) =>
    axis === "h" ? (i.box.minX + i.box.maxX) / 2 : (i.box.minY + i.box.maxY) / 2;
  const sorted = [...items].sort((a, b) => centre(a) - centre(b));
  const c0 = centre(sorted[0]);
  const step = (centre(sorted[sorted.length - 1]) - c0) / (sorted.length - 1);
  const next = new Map<string, Pose>();
  sorted.forEach((i, idx) => {
    const target = c0 + step * idx;
    const delta = target - centre(i);
    next.set(i.id, { id: i.id, x_mm: i.x_mm + (axis === "h" ? delta : 0), y_mm: i.y_mm + (axis === "v" ? delta : 0) });
  });
  return items.map((i) => next.get(i.id)!);
}

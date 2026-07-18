import type { AlignmentPoint, ToolingHole } from "@/lib/api";

/** Minimum hole diameter a touch-probe stylus can centre in (mm).
 *  Keep in sync with `PROBEABLE_MIN_HOLE_DIAMETER_MM` in
 *  crates/cuprum-project/src/document/panel.rs. */
export const PROBEABLE_MIN_HOLE_DIAMETER_MM = 2.0;

/** Click-to-hole snap radius (mm): a click within this distance of a hole
 *  centre snaps the alignment point onto that hole. */
export const ALIGN_SNAP_RADIUS_MM = 2.5;

/** A snap candidate: any physical hole on the panel (tooling hole or a placed
 *  design's drill hole), in panel coordinates (mm). */
export interface HoleCandidate {
  xMm: number;
  yMm: number;
  diameterMm: number;
}

/** Resolved placement for a new/moved alignment point: the (possibly snapped)
 *  position plus the inherited hole diameter when snapped. */
export interface SnappedPlacement {
  x: number;
  y: number;
  holeDiameterMm?: number;
}

/** Snap a click (panel mm) to the nearest hole centre within `radiusMm`.
 *  Snapped points inherit the hole diameter; otherwise the raw click position
 *  is returned as a free point (no diameter). Pure. */
export function snapAlignmentPoint(
  click: { x: number; y: number },
  holes: HoleCandidate[],
  radiusMm: number = ALIGN_SNAP_RADIUS_MM,
): SnappedPlacement {
  let best: HoleCandidate | null = null;
  let bestD = radiusMm;
  for (const h of holes) {
    const d = Math.hypot(h.xMm - click.x, h.yMm - click.y);
    if (d <= bestD) {
      bestD = d;
      best = h;
    }
  }
  if (best) return { x: best.xMm, y: best.yMm, holeDiameterMm: best.diameterMm };
  return { x: click.x, y: click.y };
}

/** Whether a touch probe can centre in this point's hole. Free points (no
 *  hole) are never probeable. Mirrors Rust `AlignmentPoint::is_probeable`. */
export function isProbeable(p: Pick<AlignmentPoint, "hole_diameter_mm">): boolean {
  const d = p.hole_diameter_mm;
  return d != null && d >= PROBEABLE_MIN_HOLE_DIAMETER_MM;
}

/** An effective alignment point with its provenance for the inspector list. */
export interface EffectiveAlignmentPoint {
  point: AlignmentPoint;
  /** "registration" = derived from a registration tooling hole (auto, not
   *  removable); "user" = explicit user-placed point. */
  source: "registration" | "user";
}

/** Explicit alignment points plus registration tooling holes (each acting as a
 *  point snapped to its own hole). Registration-derived entries come first and
 *  reuse the hole id. Mirrors Rust `PanelDoc::effective_alignment_points`. */
export function effectiveAlignmentPoints(
  toolingHoles: ToolingHole[],
  alignmentPoints: AlignmentPoint[],
): EffectiveAlignmentPoint[] {
  const fromHoles: EffectiveAlignmentPoint[] = toolingHoles
    .filter((th) => th.role === "registration")
    .map((th) => ({
      point: { id: th.id, x_mm: th.x_mm, y_mm: th.y_mm, hole_diameter_mm: th.diameter_mm },
      source: "registration",
    }));
  const explicit: EffectiveAlignmentPoint[] = alignmentPoints.map((p) => ({
    point: p,
    source: "user",
  }));
  return [...fromHoles, ...explicit];
}

/** Display ordinal per point id, numbered independently per source (fiducials
 *  "1..N" and user points "1..M"). Shared by the wizard list and the drill map
 *  overlay so both label the same point identically. */
export function alignmentPointOrdinals(points: EffectiveAlignmentPoint[]): Map<string, number> {
  const m = new Map<string, number>();
  let reg = 0;
  let usr = 0;
  for (const p of points) {
    m.set(p.point.id, p.source === "registration" ? ++reg : ++usr);
  }
  return m;
}

/** Next "ap-N" id beyond the current max — stable across deletions. */
export function nextAlignmentPointId(points: AlignmentPoint[]): string {
  const max = points.reduce((m, p) => {
    const n = parseInt(p.id.replace(/^ap-/, ""), 10);
    return Number.isFinite(n) ? Math.max(m, n) : m;
  }, 0);
  return `ap-${max + 1}`;
}

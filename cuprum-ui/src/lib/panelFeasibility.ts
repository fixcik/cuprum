import type { Severity, Verdict, I18nText } from "@/lib/feasibility";
import type { PanelDoc, BoardInstance } from "@/lib/api";
import type { CapabilityProfile } from "@/lib/capabilityProfile";
import { boxesOverlap, instanceBounds, keepOutBox, toolingHoleBounds, clampZonesForHoles, type Box } from "@/lib/panelPlacement";
import { DEFAULT_CUT_GAP_MM, recommendedGapMm } from "@/lib/nest";

/** Back-compat alias; the single source is {@link recommendedGapMm} (see #436). */
export const MIN_PANEL_GAP_MM = DEFAULT_CUT_GAP_MM;

/** Spacing/edge tolerance (mm). A layout packed at exactly the recommended gap (what
 *  the "Auto" button + the solver produce) must validate clean, so we only warn when
 *  a board is closer than `minGap` by more than this — absorbing float noise from the
 *  centre-pivot transform and the solver's own epsilon. Physically negligible. */
const SPACING_TOL_MM = 1e-3;

export type PanelFindingCategory =
  | "off-panel"
  | "overlap"
  | "spacing"
  | "design"
  | "empty"
  | "keep-out"
  | "clamp";

export interface PanelFinding {
  id: string;
  category: PanelFindingCategory;
  severity: Severity;
  title: I18nText;
  detail?: I18nText;
  /** Instance ids implicated in this finding (drives highlight + dock-list focus). */
  instanceIds: string[];
  /** Tooling-hole ids implicated (keep-out finding includes tooling holes in any zone). */
  toolingHoleIds?: string[];
}

type Sized = { inst: BoardInstance; box: Box };

/** True if a rotated-AABB box extends outside the panel rectangle [0,W]×[0,H]. */
function isOffPanelBox(box: Box, panelW: number, panelH: number, tol = 1e-3): boolean {
  return box.minX < -tol || box.minY < -tol || box.maxX > panelW + tol || box.maxY > panelH + tol;
}

/** Gap between two non-overlapping AABBs (≤0 means they touch or overlap). */
function gapBetween(a: Box, b: Box): number {
  return Math.max(
    a.minX - b.maxX,
    b.minX - a.maxX,
    a.minY - b.maxY,
    b.minY - a.maxY,
  );
}

/** Evaluate panel-level placement findings.
 *  Pure function — safe to call in useMemo / tests without side effects.
 *  Instances without a resolved board size are skipped in geometry checks. */
export function evaluatePanel(opts: {
  panel: PanelDoc;
  sizes: Record<string, { w: number; h: number }>;
  profile: CapabilityProfile;
  designVerdicts: Record<string, Verdict>;
  minGapMm?: number;
}): PanelFinding[] {
  const { panel, sizes, profile, designVerdicts } = opts;
  const minGap = opts.minGapMm ?? recommendedGapMm();
  const out: PanelFinding[] = [];
  const instances = panel.instances ?? [];

  // 6) Empty panel — advisory only, never escalates.
  if (instances.length === 0) {
    out.push({
      id: "empty",
      category: "empty",
      severity: "info",
      title: { key: "feasibility:panel.empty" },
      instanceIds: [],
    });
    return out;
  }

  // Resolve sized instances — skip those whose board dimensions are not yet known.
  const sized: Sized[] = instances
    .filter((i) => !!sizes[i.design_id])
    .map((i) => {
      const sz = sizes[i.design_id];
      return {
        inst: i,
        box: instanceBounds({
          xMm: i.x_mm,
          yMm: i.y_mm,
          boardW: sz.w,
          boardH: sz.h,
          rotationDeg: i.rotation_deg,
        }),
      };
    });

  // 1) Off-panel (block) — rotated AABB pokes outside the blank rectangle.
  const offIds = sized
    .filter(({ box }) => isOffPanelBox(box, panel.width_mm, panel.height_mm))
    .map(({ inst }) => inst.id);
  if (offIds.length) {
    out.push({
      id: "off-panel",
      category: "off-panel",
      severity: "block",
      title: { key: "feasibility:panel.offPanel", params: { count: offIds.length } },
      instanceIds: offIds,
    });
  }

  // 2) Overlap (block) + 4) Spacing (warn): pairwise on AABBs.
  const overlapIds = new Set<string>();
  const spacingIds = new Set<string>();
  for (let i = 0; i < sized.length; i++) {
    for (let j = i + 1; j < sized.length; j++) {
      const a = sized[i].box;
      const b = sized[j].box;
      if (boxesOverlap(a, b)) {
        overlapIds.add(sized[i].inst.id);
        overlapIds.add(sized[j].inst.id);
      } else if (gapBetween(a, b) < minGap - SPACING_TOL_MM) {
        spacingIds.add(sized[i].inst.id);
        spacingIds.add(sized[j].inst.id);
      }
    }
  }
  // Edge margin (warn): board inside panel but within minGap of any panel edge.
  // Skip off-panel (already block) and overlapping boards (already block) so a
  // single instance is never flagged both block and warn.
  for (const { inst, box } of sized) {
    if (offIds.includes(inst.id) || overlapIds.has(inst.id)) continue;
    const margin = Math.min(
      box.minX,
      box.minY,
      panel.width_mm - box.maxX,
      panel.height_mm - box.maxY,
    );
    if (margin >= 0 && margin < minGap - SPACING_TOL_MM) spacingIds.add(inst.id);
  }
  if (overlapIds.size) {
    out.push({
      id: "overlap",
      category: "overlap",
      severity: "block",
      title: { key: "feasibility:panel.overlap", params: { count: overlapIds.size } },
      instanceIds: [...overlapIds],
    });
  }
  if (spacingIds.size) {
    out.push({
      id: "spacing",
      category: "spacing",
      severity: "warn",
      title: { key: "feasibility:panel.spacing", params: { count: spacingIds.size } },
      instanceIds: [...spacingIds],
    });
  }

  // 5) Design verdicts (inherit): every placed instance carries its design's own verdict.
  const byVerdict: Record<"block" | "warn", string[]> = { block: [], warn: [] };
  for (const i of instances) {
    const v = designVerdicts[i.design_id];
    if (v === "block") byVerdict.block.push(i.id);
    else if (v === "warn") byVerdict.warn.push(i.id);
  }
  if (byVerdict.block.length) {
    out.push({
      id: "design-block",
      category: "design",
      severity: "block",
      title: { key: "feasibility:panel.designBlock", params: { count: byVerdict.block.length } },
      instanceIds: byVerdict.block,
    });
  }
  if (byVerdict.warn.length) {
    out.push({
      id: "design-warn",
      category: "design",
      severity: "warn",
      title: { key: "feasibility:panel.designWarn", params: { count: byVerdict.warn.length } },
      instanceIds: byVerdict.warn,
    });
  }

  // 7) Keep-out (block): a board AABB or tooling-hole AABB intersects ANY keep-out zone.
  //    All zones are uniformly forbidden for both boards and tooling holes.
  const zones = panel.keep_out_zones ?? [];
  if (zones.length) {
    const zoneBoxes = zones.map((z) => keepOutBox(z));
    const koIds = new Set<string>();
    for (const s of sized) {
      if (zoneBoxes.some((zb) => boxesOverlap(s.box, zb))) {
        koIds.add(s.inst.id);
      }
    }
    const koHoleIds: string[] = [];
    for (const h of panel.tooling_holes ?? []) {
      const hb = toolingHoleBounds({ xMm: h.x_mm, yMm: h.y_mm, diameterMm: h.diameter_mm });
      if (zoneBoxes.some((zb) => boxesOverlap(hb, zb))) koHoleIds.push(h.id);
    }
    const totalCount = koIds.size + koHoleIds.length;
    if (totalCount > 0) {
      out.push({
        id: "keep-out",
        category: "keep-out",
        severity: "block",
        title: { key: "feasibility:panel.keepOut", params: { count: totalCount } },
        instanceIds: [...koIds],
        toolingHoleIds: koHoleIds.length > 0 ? koHoleIds : undefined,
      });
    }
  }

  // 9) Clamp zones (block): a board AABB overlaps a derived clamp zone around a
  //    registration/flip tooling hole (profile-driven; empty when radius 0).
  const clampBoxes = clampZonesForHoles(panel.tooling_holes ?? [], profile.toolingClampRadiusMm);
  if (clampBoxes.length) {
    const ids = new Set<string>();
    for (const s of sized) {
      if (clampBoxes.some((c) => boxesOverlap(s.box, c.box))) ids.add(s.inst.id);
    }
    if (ids.size) {
      out.push({
        id: "clamp",
        category: "clamp",
        severity: "block",
        title: { key: "feasibility:panel.clamp", params: { count: ids.size } },
        instanceIds: [...ids],
      });
    }
  }

  return out;
}

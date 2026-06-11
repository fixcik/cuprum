import type { Finding, FindingCategory, I18nText, ProblemType } from "@/lib/feasibility";
import { problemTypeOf } from "@/lib/feasibility";
import type { DrcMarkerInput, ProjectedMarker } from "@/components/preview/DrcMarkers";

/** Findings whose hotspots are holes — drawn as a ring around the bore. */
const CIRCLE_FINDINGS = new Set(["drill.minHole", "via.plating", "drill.bitSnap"]);
/** Findings whose hotspots mark a thin feature (drawn as a box). */
const BOX_FINDINGS = new Set<string>([]);
/** Findings whose hotspots are the actual failing strokes — colour-highlighted as
 *  lines at their width. Silk is split per side, so match the `silk.line.*` family
 *  by prefix. */
const isLineFinding = (id: string) => id.startsWith("silk.line") || id.startsWith("copper.thinTrace");

/** The marker shape a finding's hotspots are drawn as. */
export type DrcMarkerShape = "circle" | "box" | "line" | "dim";

/** Pick the marker shape for a finding id. Exported for tests / reuse. */
export function markerShapeFor(id: string): DrcMarkerShape {
  if (CIRCLE_FINDINGS.has(id)) return "circle";
  if (BOX_FINDINGS.has(id)) return "box";
  if (isLineFinding(id)) return "line";
  return "dim";
}

/** i18n/unit formatters injected from the React layer (useFindingText / useUnitFormat). */
export interface DrcText {
  resolveText: (text?: I18nText) => string;
  trLen: (text: I18nText | undefined, lenStr: string) => string;
  fmtLen: (mm: number) => string;
  fmtLenPair: (values: number[]) => string[];
}

export interface BuildDrcMarkersCtx {
  /** Problem types hidden from the overlay (does not affect the verdict). */
  hiddenTypes?: Set<ProblemType>;
  /** Currently focused hotspot, so the matching marker reads as focused. */
  focus: { fid: string; hi: number } | null;
  /** Whether a marker for this category/side is on a currently-visible layer. */
  markerVisible: (category: FindingCategory, hside: "top" | "bottom" | "both") => boolean;
  text: DrcText;
}

/** Flatten every finding's hotspots (and hover boxes) into preview markers in board
 *  mm. Pure: visibility and i18n/unit formatting are injected via `ctx`. */
export function buildDrcMarkers(findings: Finding[], ctx: BuildDrcMarkersCtx): DrcMarkerInput[] {
  const { hiddenTypes, focus, markerVisible, text } = ctx;
  const { resolveText, trLen, fmtLen, fmtLenPair } = text;
  return findings.flatMap((f) => {
    // Drop a problem-type the user hid in the filter (overlay only, not verdict).
    if (hiddenTypes) {
      const tp = problemTypeOf(f.id);
      if (tp && hiddenTypes.has(tp)) return [];
    }
    const shape = markerShapeFor(f.id);
    const visual = (f.hotspots ?? [])
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => markerVisible(f.category, h.side))
      .map(({ h, i }) => {
        const l = f.limit?.params?.len;
        const [vs, ls2] = typeof l === "number" ? fmtLenPair([h.v, l]) : [fmtLen(h.v), ""];
        const limitStr = typeof l === "number" ? trLen(f.limit, ls2) : resolveText(f.limit);
        return {
          key: `${f.id}#${i}`,
          a: h.a,
          b: h.b,
          value: vs,
          label: resolveText(f.label),
          limit: limitStr,
          detail: resolveText(f.detail) || undefined,
          severity: f.severity,
          focused: shape !== "line" && focus?.fid === f.id && focus?.hi === i,
          shape,
          widthMm: shape === "line" ? h.v : undefined,
          lineColor: shape === "line" && f.category === "copper" ? "hsl(var(--destructive))" : undefined,
        };
      });
    const hovers = (f.hoverBoxes ?? [])
      .filter((h) => markerVisible(f.category, h.side))
      .map((h, i) => {
        const l = f.limit?.params?.len;
        const [valueStr, limitStr] =
          typeof l === "number"
            ? (() => { const [vs, ls] = fmtLenPair([h.v, l]); return [vs, trLen(f.limit, ls)]; })()
            : [fmtLen(h.v), resolveText(f.limit)];
        return {
          key: `${f.id}~hover#${i}`,
          a: h.a,
          b: h.b,
          value: valueStr,
          label: resolveText(f.label),
          limit: limitStr,
          detail: resolveText(f.detail) || undefined,
          severity: f.severity,
          focused: focus?.fid === f.id && focus?.hi === i,
          shape: "hover" as const,
        };
      });
    return [...visual, ...hovers];
  });
}

/** The live 2D view transform handed to the marker projection: board mm → screen
 *  px. `s` is px/mm; `(tx,ty)` is the screen-space origin. `mirrored` flips X
 *  across the board extent (the real back-of-board bottom view); both axes pivot
 *  on the board extent so the gerber Y-up data lands right-side-up on screen. */
export interface MarkerViewport {
  /** Scale in px/mm. */
  s: number;
  /** Screen-space translation (px). */
  tx: number;
  ty: number;
  /** Board extent corners (mm) — the projection pivots on their sums. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** X-flip across the board extent (bottom view, no see-through mirror). */
  mirrored: boolean;
}

/** Project DRC markers from board mm to screen px with the live view transform.
 *  Pure: same `markers`+`viewport` always give the same `ProjectedMarker[]`, so a
 *  cursor-only re-render can memoise on it instead of rebuilding the (up to
 *  ~500-hotspot) overlay every frame. `widthMm` projects to `widthPx` at scale. */
export function projectMarkers(markers: DrcMarkerInput[], viewport: MarkerViewport): ProjectedMarker[] {
  const { s, tx, ty, minX, minY, maxX, maxY, mirrored } = viewport;
  const mY = minY + maxY;
  const mX = minX + maxX;
  const toScr = (g: [number, number]): [number, number] => {
    const dx = mirrored ? mX - g[0] : g[0];
    const dy = mY - g[1];
    return [tx + s * dx, ty + s * dy];
  };
  return markers.map((m) => {
    const [ax, ay] = toScr(m.a);
    const [bx, by] = toScr(m.b);
    const [mx, my] = toScr([(m.a[0] + m.b[0]) / 2, (m.a[1] + m.b[1]) / 2]);
    return { ...m, ax, ay, bx, by, mx, my, widthPx: m.widthMm != null ? m.widthMm * s : undefined };
  });
}

/** Order markers for paint: "line" highlights first (so the dimension lines, ticks
 *  and boxes for other shapes draw over them). Stable, non-mutating. */
export function markerPaintOrder(markers: ProjectedMarker[]): ProjectedMarker[] {
  return [...markers].sort((a, b) => (a.shape === "line" ? 0 : 1) - (b.shape === "line" ? 0 : 1));
}

/** A placed rectangle in screen px: top-left corner + size, plus the centre and a
 *  label anchor (just past the top-right corner). Shared by the "box", "hover" and
 *  "circle"-label placements so the value label sits consistently. */
export interface BoxPlacement {
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  /** Label anchor (px): 5px right of the box's right edge, at its top. */
  labelX: number;
  labelY: number;
}

/** Box geometry for a marker's a..b bbox: pad it, enforce a minimum on-screen size,
 *  and centre the (clamped) box on the padded bbox centre. `pad`/`minSize` are
 *  screen px. Used by both the "box" (pad 6, min 16) and focused "hover" (pad 6,
 *  min 16) shapes. */
export function boxPlacement(m: ProjectedMarker, pad: number, minSize: number): BoxPlacement {
  const x0 = Math.min(m.ax, m.bx) - pad;
  const y0 = Math.min(m.ay, m.by) - pad;
  const x1 = Math.max(m.ax, m.bx) + pad;
  const y1 = Math.max(m.ay, m.by) + pad;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const w = Math.max(x1 - x0, minSize);
  const h = Math.max(y1 - y0, minSize);
  return { x: cx - w / 2, y: cy - h / 2, w, h, cx, cy, labelX: cx + w / 2 + 5, labelY: cy - h / 2 };
}

/** A placed ring in screen px: centre + radius, plus the label anchor (past the
 *  top-right of the ring). */
export interface CirclePlacement {
  cx: number;
  cy: number;
  r: number;
  labelX: number;
  labelY: number;
}

/** Ring geometry around a hole whose a..b is its bbox: centre on the bbox, radius =
 *  half the larger bbox side, floored at `minR` px so a tiny hole still reads. */
export function circlePlacement(m: ProjectedMarker, minR: number): CirclePlacement {
  const cx = (m.ax + m.bx) / 2;
  const cy = (m.ay + m.by) / 2;
  const r = Math.max(Math.max(Math.abs(m.bx - m.ax), Math.abs(m.by - m.ay)) / 2, minR);
  return { cx, cy, r, labelX: cx + r + 5, labelY: cy - r };
}

/** Tick geometry for a dimension marker: the perpendicular unit vector of the a→b
 *  line, scaled to the tick half-length, for the end caps. `len` is the on-screen
 *  a→b length (≥1 to avoid a divide-by-zero on a zero-length marker). */
export interface DimTicks {
  len: number;
  /** Perpendicular unit · tick half-length (px), as an (x,y) offset. */
  tx: number;
  ty: number;
}

/** Perpendicular tick offset for a dimension line's end caps. `tick` is the tick
 *  half-length in screen px. */
export function dimTicks(m: ProjectedMarker, tick: number): DimTicks {
  const len = Math.hypot(m.bx - m.ax, m.by - m.ay) || 1;
  const px = -(m.by - m.ay) / len;
  const py = (m.bx - m.ax) / len;
  return { len, tx: px * tick, ty: py * tick };
}

/** A placed hover hitbox in screen px: centre + size. Covers the marker's whole
 *  a..b bbox (padded, floored at a minimum) so a long box/line is hoverable along
 *  its full length even when its centre is off-screen. */
export interface HitboxPlacement {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/** Hover hitbox over a marker's a..b bbox: pad each side by `pad` px, floor the
 *  size at `minSize` px, centred on the (unpadded) bbox centre. */
export function hitboxPlacement(m: ProjectedMarker, pad: number, minSize: number): HitboxPlacement {
  const x0 = Math.min(m.ax, m.bx);
  const y0 = Math.min(m.ay, m.by);
  const x1 = Math.max(m.ax, m.bx);
  const y1 = Math.max(m.ay, m.by);
  return {
    cx: (x0 + x1) / 2,
    cy: (y0 + y1) / 2,
    w: Math.max(x1 - x0 + pad * 2, minSize),
    h: Math.max(y1 - y0 + pad * 2, minSize),
  };
}

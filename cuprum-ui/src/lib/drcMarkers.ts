import type { Finding, FindingCategory, I18nText, ProblemType } from "@/lib/feasibility";
import { problemTypeOf } from "@/lib/feasibility";
import type { DrcMarkerInput } from "@/components/preview/DrcMarkers";

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

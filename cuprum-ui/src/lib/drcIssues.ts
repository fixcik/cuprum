import type { Finding, FindingCategory, I18nText, ProblemType } from "@/lib/feasibility";
import { problemTypeOf } from "@/lib/feasibility";
import type { DrcIssue } from "@/components/preview/PreviewPane";

export interface BuildDrcIssuesCtx {
  /** Problem types hidden from the stepper (does not affect the verdict). */
  hiddenTypes?: Set<ProblemType>;
  /** Whether an issue for this category/side is on a currently-visible layer. */
  markerVisible: (category: FindingCategory, hside: "top" | "bottom" | "both") => boolean;
  resolveText: (text?: I18nText) => string;
  fmtLen: (mm: number) => string;
}

/** Flat list of navigable problems for the on-preview stepper. Pure: visibility and
 *  i18n/unit formatting are injected via `ctx`. A `highlightAll` finding contributes
 *  one entry per hover box (or a single summary entry when it has none). */
export function buildDrcIssues(findings: Finding[], ctx: BuildDrcIssuesCtx): DrcIssue[] {
  const { hiddenTypes, markerVisible, resolveText, fmtLen } = ctx;
  return findings.flatMap((f) => {
    const hs = f.hotspots ?? [];
    if (hs.length === 0) return [];
    if (hiddenTypes) {
      const tp = problemTypeOf(f.id);
      if (tp && hiddenTypes.has(tp)) return [];
    }
    if (f.highlightAll) {
      const boxes = f.hoverBoxes ?? [];
      if (boxes.length > 0) {
        return boxes.flatMap((h, i) =>
          markerVisible(f.category, h.side)
            ? [{ fid: f.id, hi: i, label: resolveText(f.label), value: fmtLen(h.v), severity: f.severity }]
            : [],
        );
      }
      return markerVisible(f.category, hs[0].side)
        ? [{ fid: f.id, hi: 0, label: resolveText(f.label), value: resolveText(f.measured), severity: f.severity }]
        : [];
    }
    return hs.flatMap((h, i) =>
      markerVisible(f.category, h.side)
        ? [{ fid: f.id, hi: i, label: resolveText(f.label), value: fmtLen(h.v), severity: f.severity }]
        : [],
    );
  });
}

import { CheckCircle2, AlertTriangle, XCircle, Info } from "lucide-react";
import type { Severity } from "@/lib/feasibility";

/** Single source of truth for how a DFM severity is visualised across the app:
 *  its lucide icon, foreground/background Tailwind classes, the small dot class,
 *  and a raw CSS colour (HSL via design tokens) for canvas/SVG drawing where a
 *  class can't be applied. Previously copied verbatim in VerdictBadge, FeasibilityTab,
 *  DrcMarkers and PreviewPane — keep them in sync here. */
export interface SeverityStyle {
  Icon: typeof CheckCircle2;
  /** Foreground colour class (text-…). */
  fg: string;
  /** Tinted background pill class (bg-…/15). */
  bg: string;
  /** Solid dot class (bg-…), for the stepper marker. */
  dot: string;
  /** Raw CSS colour for SVG/canvas strokes & fills. */
  hsl: string;
}

export const SEVERITY: Record<Severity, SeverityStyle> = {
  ok: { Icon: CheckCircle2, fg: "text-success", bg: "bg-success/15", dot: "bg-success", hsl: "hsl(var(--success))" },
  warn: { Icon: AlertTriangle, fg: "text-warning", bg: "bg-warning/15", dot: "bg-warning", hsl: "hsl(var(--warning))" },
  block: {
    Icon: XCircle,
    fg: "text-destructive",
    bg: "bg-destructive/15",
    dot: "bg-destructive",
    hsl: "hsl(var(--destructive))",
  },
  info: {
    Icon: Info,
    fg: "text-muted-foreground",
    bg: "bg-muted-foreground/15",
    dot: "bg-muted-foreground",
    hsl: "hsl(var(--muted-foreground))",
  },
};

/** Severity ordering, worst-last — for picking the worst across a set of findings. */
export const SEV_RANK: Record<Severity, number> = { ok: 0, info: 1, warn: 2, block: 3 };

/** The worse of two severities (`a` may be undefined = nothing seen yet). */
export const worseSeverity = (a: Severity | undefined, b: Severity): Severity =>
  a === undefined || SEV_RANK[b] > SEV_RANK[a] ? b : a;

import type { Verdict } from "@/lib/feasibility";
import { SEVERITY } from "@/lib/severity";

/** A small status dot coloured by DFM verdict — `null` (not yet evaluated) shows
 *  a muted dot. The compact counterpart to {@link VerdictBadge} (card corner,
 *  picker row, tab icon). Pass size/position via `className`. */
export function VerdictDot({ verdict, className = "" }: { verdict: Verdict | null; className?: string }) {
  const color = verdict ? SEVERITY[verdict].dot : "bg-muted-foreground/40";
  return <span className={`rounded-full ${color} ${className}`} aria-hidden />;
}

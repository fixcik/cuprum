import { CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { type Verdict, VERDICT_LABEL } from "@/lib/feasibility";

const STYLES: Record<Verdict, { color: string; bg: string; Icon: typeof CheckCircle2 }> = {
  ok: { color: "text-success", bg: "bg-success/15", Icon: CheckCircle2 },
  warn: { color: "text-warning", bg: "bg-warning/15", Icon: AlertTriangle },
  block: { color: "text-destructive", bg: "bg-destructive/15", Icon: XCircle },
};

/** Compact pill summarising the overall DFM verdict. */
export function VerdictBadge({ verdict, className = "" }: { verdict: Verdict; className?: string }) {
  const { color, bg, Icon } = STYLES[verdict];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium ${bg} ${color} ${className}`}
    >
      <Icon className="size-3.5" />
      {VERDICT_LABEL[verdict]}
    </span>
  );
}

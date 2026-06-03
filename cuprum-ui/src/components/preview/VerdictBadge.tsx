import { useTranslation } from "react-i18next";
import { type Verdict, VERDICT_KEY } from "@/lib/feasibility";
import { SEVERITY } from "@/lib/severity";

/** Compact pill summarising the overall DFM verdict. */
export function VerdictBadge({ verdict, className = "" }: { verdict: Verdict; className?: string }) {
  const { t } = useTranslation();
  const { fg, bg, Icon } = SEVERITY[verdict];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium ${bg} ${fg} ${className}`}
    >
      <Icon className="size-3.5" />
      {t(VERDICT_KEY[verdict])}
    </span>
  );
}

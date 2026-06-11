import { useTranslation } from "react-i18next";
import type { MillEstimate } from "@/lib/api";
import { formatDuration } from "@/lib/formatDuration";
import { useUnitFormat } from "@/i18n/useUnitFormat";

export interface MillPreflightSummaryProps {
  /** Backend-computed motion-time estimate + cut/travel lengths + path count. */
  estimate: MillEstimate;
  /** Number of passes (cut depth repeats), surfaced as a stat. */
  passes: number;
}

/** 2×2 grid of preflight stat cards for the isolation-milling run: cut length,
 *  estimated motion time, path count, passes. Mirrors DrillPreflightSummary. */
export function MillPreflightSummary({ estimate, passes }: MillPreflightSummaryProps) {
  const { t } = useTranslation("mill");
  const { fmtLen } = useUnitFormat();

  const timeFmt = formatDuration(
    estimate.motionSec,
    t("preflight.minAbbr"),
    t("preflight.secAbbr"),
  );

  const cells: { label: string; value: string; sub: string }[] = [
    {
      label: t("preflight.cutLen"),
      value: fmtLen(estimate.cutLenMm),
      sub: t("preflight.cutLenSub"),
    },
    {
      label: t("preflight.time"),
      value: timeFmt,
      sub: t("preflight.timeSub"),
    },
    {
      label: t("preflight.paths"),
      value: String(estimate.pathCount),
      sub: t("preflight.pathsSub"),
    },
    {
      label: t("preflight.passes"),
      value: String(passes),
      sub: t("preflight.passesSub"),
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 px-4 pb-3">
      {cells.map((cell) => (
        <div key={cell.label} className="rounded-lg border border-border bg-card/40 p-2.5">
          <div className="text-[11px] text-muted-foreground">{cell.label}</div>
          <div className="mt-0.5 text-sm font-semibold tabular-nums text-slate-100">
            {cell.value}
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground/70">{cell.sub}</div>
        </div>
      ))}
    </div>
  );
}

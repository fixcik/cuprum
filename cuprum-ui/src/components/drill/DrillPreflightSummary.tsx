import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { DrillRoute } from "@/lib/drillRoute";
import type { Tool } from "@/lib/toolLibrary";
import type { CncProfile } from "@/lib/cncProfile";
import { estimateDrill } from "@/lib/drillEstimate";

export interface DrillPreflightSummaryProps {
  route: DrillRoute;
  tools: Tool[];
  cncProfile: CncProfile;
  substrateThicknessMm: number;
}

/** 2×2 grid of preflight stat cards: holes, estimated time, jog distance, tool changes. */
export function DrillPreflightSummary({
  route,
  tools,
  cncProfile,
  substrateThicknessMm,
}: DrillPreflightSummaryProps) {
  const { t } = useTranslation("drill");

  const est = useMemo(
    () => estimateDrill(route, tools, cncProfile, substrateThicknessMm),
    [route, tools, cncProfile, substrateThicknessMm],
  );

  // Format timeSec as "Xм Yс" / "Yс"
  const timeFmt = (() => {
    const m = Math.floor(est.timeSec / 60);
    const s = est.timeSec % 60;
    return m > 0 ? `${m}м ${s}с` : `${s}с`;
  })();

  const cells: { label: string; value: string }[] = [
    {
      label: t("preflight.holes"),
      value: String(route.totalHoles),
    },
    {
      label: t("preflight.time"),
      value: `~${timeFmt}`,
    },
    {
      label: t("preflight.travel"),
      value: `${est.travelMm.toFixed(0)} мм`,
    },
    {
      label: t("preflight.changes"),
      value: String(est.toolChanges),
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 px-4 pb-3">
      {cells.map((cell) => (
        <div
          key={cell.label}
          className="rounded-lg border border-border bg-card/40 p-2.5"
        >
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {cell.label}
          </div>
          <div className="mt-1 text-sm font-semibold tabular-nums text-slate-100">
            {cell.value}
          </div>
        </div>
      ))}
    </div>
  );
}

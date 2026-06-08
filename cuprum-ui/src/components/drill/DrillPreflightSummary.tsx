import { useTranslation } from "react-i18next";
import type { DrillRoute } from "@/lib/drillRoute";
import type { DrillEstimate } from "@/lib/api";
import { useUnitFormat } from "@/i18n/useUnitFormat";

export interface DrillPreflightSummaryProps {
  route: DrillRoute;
  /** Backend-computed motion-time estimate (movement only; tool changes counted,
   *  not timed). Comes from `api.drill.plan(...).estimate`. */
  estimate: DrillEstimate;
}

/** 2×2 grid of preflight stat cards: holes, estimated motion time, jog distance,
 *  tool changes. The time is movement-only (the backend no longer folds the
 *  ~30 s/swap operator overhead in); the swaps are surfaced as a separate count. */
export function DrillPreflightSummary({
  route,
  estimate,
}: DrillPreflightSummaryProps) {
  const { t } = useTranslation("drill");
  const { fmtLen } = useUnitFormat();

  const est = estimate;
  const motionSec = Math.round(est.motionSec);

  // Format motion seconds as "X мин YY с" / "Y с" with localised abbreviations;
  // seconds are zero-padded to two digits once there's a minutes part.
  const timeFmt = (() => {
    const m = Math.floor(motionSec / 60);
    const s = motionSec % 60;
    const sec = `${String(s).padStart(m > 0 ? 2 : 1, "0")} ${t("preflight.secAbbr")}`;
    return m > 0 ? `${m} ${t("preflight.minAbbr")} ${sec}` : sec;
  })();

  // Distinct categories in the selected run (for the holes sub-caption).
  const categoryCount = new Set(route.groups.map((g) => g.class)).size;

  const cells: { label: string; value: string; sub: string }[] = [
    {
      label: t("preflight.holes"),
      value: String(route.totalHoles),
      sub: t("preflight.holesSub", { count: categoryCount }),
    },
    {
      label: t("preflight.time"),
      value: timeFmt,
      sub: t("preflight.timeSub"),
    },
    {
      label: t("preflight.travel"),
      value: fmtLen(est.travelMm),
      sub: t("preflight.travelSub"),
    },
    {
      label: t("preflight.changes"),
      value: String(est.toolChanges),
      sub: t("preflight.changesSub"),
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 px-4 pb-3">
      {cells.map((cell) => (
        <div
          key={cell.label}
          className="rounded-lg border border-border bg-card/40 p-2.5"
        >
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

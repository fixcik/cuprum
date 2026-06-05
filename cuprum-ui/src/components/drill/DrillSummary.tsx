import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import type { PanelDrillPlan } from "@/lib/panelDrill";
import type { DrillRoute, RouteGroup } from "@/lib/drillRoute";
import { useUnitFormat } from "@/i18n/useUnitFormat";

/** Palette colours mirroring DrillMapCanvas — must stay in sync. */
const GROUP_PALETTE = [
  "#4f9cf9",
  "#f97316",
  "#22c55e",
  "#a855f7",
  "#f43f5e",
  "#eab308",
  "#06b6d4",
  "#84cc16",
  "#ec4899",
  "#8b5cf6",
];

function groupColor(index: number): string {
  return GROUP_PALETTE[index % GROUP_PALETTE.length];
}

const CLASS_LABEL: Record<RouteGroup["class"], string> = {
  registration: "drill:class.registration",
  pth: "drill:class.pth",
  npth: "drill:class.npth",
  mechanical: "drill:class.mechanical",
};

export interface DrillSummaryProps {
  plan: PanelDrillPlan;
  route: DrillRoute;
}

/** Summary sidebar: total holes/tools count, per-group list, and unmatched warnings. */
export function DrillSummary({ plan, route }: DrillSummaryProps) {
  const { t } = useTranslation("drill");
  const { fmtLen } = useUnitFormat();

  const hasUnmatched = plan.unmatchedDiametersMm.length > 0;
  const hasSkippedInKeepout = plan.skippedInKeepout > 0;
  const hasRegistrationInKeepout = plan.registrationInKeepout > 0;

  return (
    <div className="flex flex-col gap-3 p-4 text-sm text-slate-300 overflow-y-auto">
      {/* Total summary line */}
      <p className="font-medium text-slate-100">
        {t("summary.holes", { count: route.totalHoles })}
        {" · "}
        {t("summary.tools", { count: route.toolCount })}
      </p>

      {/* Per-group list */}
      <ul className="flex flex-col gap-1.5">
        {route.groups.map((g, gi) => {
          const color = groupColor(gi);
          return (
            <li key={gi} className="flex items-center gap-2">
              {/* Colour chip */}
              <span
                className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: color }}
              />
              {/* Diameter */}
              <span className="text-slate-100 tabular-nums">{fmtLen(g.diameterMm)}</span>
              {/* Class */}
              <span className="text-slate-400">{t(CLASS_LABEL[g.class])}</span>
              {/* "no drill" for groups with no matching tool */}
              {!g.toolId && (
                <span className="text-amber-400 text-xs">{t("summary.noTool")}</span>
              )}
              {/* Hole count */}
              <span className="ml-auto text-slate-500 tabular-nums text-xs">
                {g.orderedHoles.length}
              </span>
            </li>
          );
        })}
      </ul>

      {/* Unmatched diameter warning */}
      {hasUnmatched && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {t("summary.unmatchedWarning", {
              diameters: plan.unmatchedDiametersMm.map((d) => fmtLen(d)).join(", "),
            })}
          </span>
        </div>
      )}

      {/* Keep-out skipped holes warning (amber) */}
      {hasSkippedInKeepout && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t("summary.keepoutSkipped", { count: plan.skippedInKeepout })}</span>
        </div>
      )}

      {/* Registration holes in keep-out — loud red banner */}
      {hasRegistrationInKeepout && (
        <div className="flex items-start gap-2 rounded-md border border-rose-500/60 bg-rose-500/15 px-3 py-2 text-rose-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t("summary.registrationInKeepout", { count: plan.registrationInKeepout })}</span>
        </div>
      )}
    </div>
  );
}

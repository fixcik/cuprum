import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import type { PanelDrillPlan } from "@/lib/panelDrill";
import { useUnitFormat } from "@/i18n/useUnitFormat";

export interface DrillWarningsProps {
  plan: PanelDrillPlan;
}

/** Amber/red warning banners for unmatched diameters, keepout-skipped holes,
 *  and registration holes inside a keepout zone. Renders nothing when all clear. */
export function DrillWarnings({ plan }: DrillWarningsProps) {
  const { t } = useTranslation("drill");
  const { fmtLen } = useUnitFormat();

  const hasUnmatched = plan.unmatchedDiametersMm.length > 0;
  const hasSkippedInKeepout = plan.skippedInKeepout > 0;
  const hasRegistrationInKeepout = plan.registrationInKeepout > 0;

  if (!hasUnmatched && !hasSkippedInKeepout && !hasRegistrationInKeepout) return null;

  return (
    <div className="flex flex-col gap-2 px-4 pb-3">
      {/* Unmatched diameter warning */}
      {hasUnmatched && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-300 text-sm">
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
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-300 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t("summary.keepoutSkipped", { count: plan.skippedInKeepout })}</span>
        </div>
      )}

      {/* Registration holes in keep-out — loud red banner */}
      {hasRegistrationInKeepout && (
        <div className="flex items-start gap-2 rounded-md border border-rose-500/60 bg-rose-500/15 px-3 py-2 text-rose-300 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {t("summary.registrationInKeepout", { count: plan.registrationInKeepout })}
          </span>
        </div>
      )}
    </div>
  );
}

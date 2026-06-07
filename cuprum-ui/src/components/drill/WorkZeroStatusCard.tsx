import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronRight, Crosshair, CheckCircle2 } from "lucide-react";
import type { DatumCorner } from "@/lib/datum";
import type { XYGateResult } from "@/lib/xyGate";

export interface WorkZeroStatusCardProps {
  /** Whether the work zero has been bound (MPos captured). */
  isSet: boolean;
  /** The active datum corner — shown in the "set" sub-status. */
  datum: DatumCorner;
  /** XY gate result — a bound-but-overrunning zero flips the card to a warning. */
  xyGate: XYGateResult;
  /** Open the zero-binding inspector mode. */
  onOpen: () => void;
}

/** Compact plan-mode card-button for the work zero. Shows the bind status
 *  (not set / set · corner / warning when the bound zero overruns the travel)
 *  and opens the dedicated zero-binding inspector mode. The jog/Z/bind controls
 *  live in that mode, not here. */
export function WorkZeroStatusCard({ isSet, datum, xyGate, onOpen }: WorkZeroStatusCardProps) {
  const { t } = useTranslation("drill");

  const warn = isSet && xyGate.valid === false && xyGate.reason === "out-of-bounds";

  // Card / tile colouring by state: warning > set > unset.
  const cardCls = warn
    ? "border-amber-500/40 bg-amber-500/[0.06] hover:border-amber-500/60"
    : isSet
      ? "border-primary/40 bg-primary/5 hover:border-primary/60"
      : "border-border bg-card/40 hover:border-primary/50";
  const tileCls = warn
    ? "bg-amber-500/15 text-amber-300"
    : isSet
      ? "bg-primary/15 text-primary"
      : "bg-muted text-muted-foreground";
  const Icon = warn ? AlertTriangle : isSet ? CheckCircle2 : Crosshair;

  const subStatus = warn
    ? t("workzero.statusOverrun")
    : isSet
      ? t("workzero.statusSet", { corner: t(`datum.${datum}`) })
      : t("workzero.statusNotSet");

  return (
    <div className="px-4 py-3">
      <button
        type="button"
        onClick={onOpen}
        className={
          "flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2.5 text-left transition-colors cursor-pointer " +
          cardCls
        }
      >
        <div className={"grid size-9 shrink-0 place-items-center rounded-lg " + tileCls}>
          <Icon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-foreground">{t("workzero.cardTitle")}</div>
          <div className={"text-[11px] " + (warn ? "text-amber-300" : "text-muted-foreground")}>
            {subStatus}
          </div>
        </div>
        <span className="flex shrink-0 items-center gap-0.5 text-[12px] text-primary">
          {t("workzero.openSettings")}
          <ChevronRight className="size-4" />
        </span>
      </button>
    </div>
  );
}

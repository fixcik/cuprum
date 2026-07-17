import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronRight, Crosshair } from "lucide-react";
import type { WorkZeroCardState } from "@/lib/workZeroMethods";

export interface WorkZeroStatusCardProps {
  /** Resolved presentation state (see lib/workZeroMethods.cardState). */
  state: WorkZeroCardState;
  /** Open the method-selection screen. */
  onOpen: () => void;
  /** Forget the bound work zero. */
  onReset: () => void;
}

/** Plan-mode "Work zero" status card. Shows the bind status (not set / set via
 *  method N with an RMS-quality chip / disconnected) and opens the registration
 *  method-selection screen. The jog/bind controls live in the method flows, not
 *  here. Actions are locked while the machine is disconnected. */
export function WorkZeroStatusCard({ state, onOpen, onReset }: WorkZeroStatusCardProps) {
  const { t } = useTranslation("drill");

  const disabled = state.kind === "disconnected";
  const isSet = state.kind === "set";

  // Card border tinted by registration quality (good / bad); neutral otherwise.
  const borderCls =
    state.quality === "good"
      ? "border-success/35"
      : state.quality === "bad"
        ? "border-destructive/50"
        : "border-border";

  const tileCls = isSet ? "bg-primary/[0.18] text-primary" : "bg-muted text-muted-foreground";

  const subStatus = disabled
    ? t("zeroMethod.card.disconnected")
    : isSet
      ? t("zeroMethod.card.statusSet", { method: t(`zeroMethod.methodName.${state.method ?? 1}`) })
      : t("workzero.statusNotSet");

  // RMS chip: severity colour for methods 2–3; neutral "no estimate" for method 1.
  const chipCls =
    state.quality === "good"
      ? "bg-success/[0.14] text-success"
      : state.quality === "warn"
        ? "bg-warning/[0.14] text-warning"
        : state.quality === "bad"
          ? "bg-destructive/[0.14] text-destructive"
          : "bg-muted text-muted-foreground";

  // Note next to the chip: skew warning for method 1, rotation compensation for
  // 2–3 (when the angle is known), recapture advice on a bad fit.
  const note =
    state.quality === "bad"
      ? t("zeroMethod.card.noteBad")
      : state.method === 1
        ? t("zeroMethod.card.noteSkew")
        : state.angleDeg != null
          ? t("zeroMethod.card.noteRotation", { deg: state.angleDeg.toFixed(2) })
          : null;

  return (
    <div className="px-4 py-3">
      <div className={"rounded-xl border bg-card p-3.5 " + borderCls}>
        {/* Status row — clickable, opens the method-selection screen */}
        <button
          type="button"
          onClick={onOpen}
          disabled={disabled}
          className={
            "flex w-full items-center gap-2.5 text-left " +
            (disabled ? "cursor-not-allowed" : "cursor-pointer")
          }
        >
          <div className={"grid size-10 shrink-0 place-items-center rounded-[10px] " + tileCls}>
            <Crosshair className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-foreground">{t("workzero.cardTitle")}</div>
            <div className="text-xs text-muted-foreground">{subStatus}</div>
          </div>
          <span
            className={
              "flex shrink-0 items-center gap-0.5 text-[12px] font-semibold " +
              (disabled ? "text-muted-foreground/50" : "text-primary")
            }
          >
            {isSet ? t("zeroMethod.card.change") : t("zeroMethod.card.configure")}
            <ChevronRight className="size-4" />
          </span>
        </button>

        {/* Quality row — only when a zero is bound */}
        {isSet && (
          <div className="mt-2.5 flex items-center gap-2 border-t border-border pt-2.5">
            <span
              className={
                "shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold tabular-nums " + chipCls
              }
            >
              {state.rmsMm != null
                ? t("zeroMethod.card.rmsChip", { value: state.rmsMm.toFixed(2) })
                : t("zeroMethod.card.noEstimate")}
            </span>
            {note && <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{note}</span>}
            <button
              type="button"
              onClick={onReset}
              className="ml-auto shrink-0 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {t("zeroMethod.card.reset")}
            </button>
          </div>
        )}

        {/* XY-gate overrun — the bound zero puts holes outside the machine travel */}
        {isSet && state.overrun && (
          <div className="mt-2.5 flex items-start gap-1.5 rounded-lg bg-warning/[0.13] px-2.5 py-1.5 text-[11.5px] text-warning">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>{t("zeroMethod.card.overrun")}</span>
          </div>
        )}
      </div>
    </div>
  );
}

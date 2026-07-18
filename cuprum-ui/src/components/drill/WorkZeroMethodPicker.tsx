import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronLeft, ChevronRight, Info } from "lucide-react";
import type { MethodAvailability, WorkZeroMethod } from "@/lib/workZeroMethods";
import { PROBEABLE_MIN_HOLE_DIAMETER_MM } from "@/lib/alignmentPoints";

export interface WorkZeroMethodPickerProps {
  /** Back to the plan inspector. */
  onBack: () => void;
  /** Enter a method flow (only called for available methods; phase B wires 1). */
  onPickMethod: (m: WorkZeroMethod) => void;
  /** Availability verdict per method (lib/workZeroMethods.methodAvailability). */
  availability: Record<WorkZeroMethod, MethodAvailability>;
  /** Effective alignment-point count (method 2 fact chip). */
  pointCount: number;
  /** Probeable point/hole count (method 3 fact chip). */
  probeableCount: number;
}

/** One method card: number-in-circle, name, description, fact chips, chevron.
 *  Unavailable cards are dimmed and show an inline reason plate instead of
 *  navigating. */
function MethodCard({
  method,
  availability,
  chips,
  onPick,
  reasonPlate,
}: {
  method: WorkZeroMethod;
  availability: MethodAvailability;
  chips: string[];
  onPick: () => void;
  reasonPlate: ReactNode | null;
}) {
  const { t } = useTranslation("drill");
  const available = availability.available;

  return (
    <div
      className={
        "rounded-xl border border-border bg-card p-3.5 " + (available ? "" : "opacity-55")
      }
    >
      <button
        type="button"
        disabled={!available}
        onClick={onPick}
        className={
          "flex w-full items-start gap-2.5 text-left " +
          (available ? "cursor-pointer" : "cursor-not-allowed")
        }
      >
        <span className="grid size-[22px] shrink-0 place-items-center rounded-full bg-primary/[0.18] text-[11px] font-bold text-primary">
          {method}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-semibold text-foreground">
            {t(`zeroMethod.methodTitle.${method}`)}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {t(`zeroMethod.methodDesc.${method}`)}
          </span>
          <span className="mt-2 flex flex-wrap gap-1">
            {chips.map((c) => (
              <span
                key={c}
                className="rounded-md bg-muted px-2 py-0.5 text-[10.5px] tabular-nums text-muted-foreground"
              >
                {c}
              </span>
            ))}
          </span>
        </span>
        {available && <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
      </button>
      {reasonPlate}
    </div>
  );
}

/** Inspector mode: pick one of the three work-zero registration methods.
 *  Phase B: method 1 opens the existing corner-datum flow; methods 2–3 render
 *  as unavailable (wizards land in the next phase). */
export function WorkZeroMethodPicker({
  onBack,
  onPickMethod,
  availability,
  pointCount,
  probeableCount,
}: WorkZeroMethodPickerProps) {
  const { t } = useTranslation("drill");

  // Amber reason plate for an unavailable method. The wizard-pending case is a
  // neutral (muted) notice — nothing is wrong with the setup, the feature just
  // isn't shipped yet.
  const plate = (m: WorkZeroMethod): ReactNode | null => {
    const reason = availability[m].reason;
    if (reason === null || reason === "disconnected") return null;
    if (reason === "wizardPending") {
      return (
        <div className="mt-2.5 flex items-start gap-1.5 rounded-lg bg-muted px-2.5 py-1.5 text-[11.5px] text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <span>{t("zeroMethod.unavailable.wizardPending")}</span>
        </div>
      );
    }
    return (
      <div className="mt-2.5 rounded-lg bg-warning/[0.13] px-2.5 py-1.5 text-[11.5px] text-warning">
        <div className="flex items-start gap-1.5">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {reason === "noProbeableHoles"
              ? t("zeroMethod.unavailable.noProbeableHoles", { dia: PROBEABLE_MIN_HOLE_DIAMETER_MM })
              : t(`zeroMethod.unavailable.${reason}`)}
          </span>
        </div>
      </div>
    );
  };

  const disconnected = availability[1].reason === "disconnected";

  return (
    <>
      {/* Mode header: back to plan + title */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 shrink-0">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          {t("zeroMethod.back")}
        </button>
        <span className="text-sm font-semibold text-foreground">{t("zeroMethod.title")}</span>
      </div>

      <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          {t("zeroMethod.sectionLabel")}
        </p>

        {disconnected && (
          <div className="flex items-start gap-1.5 rounded-lg bg-warning/[0.13] px-2.5 py-1.5 text-[11.5px] text-warning">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>{t("zeroMethod.card.disconnected")}</span>
          </div>
        )}

        <MethodCard
          method={1}
          availability={availability[1]}
          chips={[
            t("zeroMethod.chip.offsetOnly"),
            t("zeroMethod.chip.eyeAccuracy"),
            t("zeroMethod.chip.noPrep"),
          ]}
          onPick={() => onPickMethod(1)}
          reasonPlate={plate(1)}
        />
        <MethodCard
          method={2}
          availability={availability[2]}
          chips={[
            t("zeroMethod.chip.offsetRotation"),
            t("zeroMethod.chip.eyeAccuracy"),
            t("zeroMethod.chip.points", { count: pointCount }),
          ]}
          onPick={() => onPickMethod(2)}
          reasonPlate={plate(2)}
        />
        <MethodCard
          method={3}
          availability={availability[3]}
          chips={[
            t("zeroMethod.chip.offsetRotation"),
            t("zeroMethod.chip.probeAccuracy"),
            t("zeroMethod.chip.holes", { count: probeableCount }),
          ]}
          onPick={() => onPickMethod(3)}
          reasonPlate={plate(3)}
        />

        <p className="text-[11.5px] text-muted-foreground">{t("zeroMethod.explainFooter")}</p>
      </div>
    </>
  );
}

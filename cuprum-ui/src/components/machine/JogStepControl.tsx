import { Infinity as InfinityIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { JogStep } from "@/hooks/useJog";

interface JogStepControlProps {
  steps: number[];
  step: JogStep;
  setStep: (s: JogStep) => void;
  continuous: boolean;
  /** Called before the step is changed — callers use this to halt an in-flight
   *  continuous move before switching steps. */
  onBeforeChange?: () => void;
}

/** Segmented step selector: numeric step buttons + a continuous (∞) toggle.
 *  Presentational only — all state lives in the parent via props. */
export function JogStepControl({ steps, step, setStep, continuous, onBeforeChange }: JogStepControlProps) {
  const { t } = useTranslation("machine");

  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-muted-foreground">{t("jog.stepMm")}</span>
      <div className="inline-flex overflow-hidden rounded-md border border-border">
        {steps.map((s) => {
          const on = step === s;
          return (
            <button
              key={s}
              type="button"
              onClick={() => {
                onBeforeChange?.(); // halt any in-flight continuous move first
                setStep(s);
              }}
              className={`px-2.5 py-1 text-[12px] tabular-nums transition-colors ${
                on
                  ? "bg-primary font-semibold text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {s}
            </button>
          );
        })}
        <button
          type="button"
          title={t("jog.continuousHint")}
          onClick={() => setStep("cont")}
          className={`grid place-items-center px-2.5 py-1 text-[12px] transition-colors ${
            continuous
              ? "bg-primary font-semibold text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <InfinityIcon className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, Ruler, Hand, ScanLine } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useUnitFormat } from "@/i18n/useUnitFormat";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";
import { useJog } from "@/hooks/useJog";
import { JogStepControl } from "@/components/machine/JogStepControl";
import { api } from "@/lib/api";

/** Probe parameters threaded from the machine profile. */
export interface ProbeConfig {
  maxDistMm: number;
  feedMmMin: number;
  offsetMm: number;
  safeZMm: number;
}

export interface DrillToolChangeCardProps {
  toolName: string;
  diameterMm: number;
  nextColor: string;
  /** Whether a Z-probe is available (shows the «Щупом» tab + makes it default). */
  hasProbe: boolean;
  probe: ProbeConfig;
  /** Z bound for the current bit — gates the confirm button. */
  zBound: boolean;
  /** Called after a successful probe / manual touch-off (dispatches the gate). */
  onZBound: () => void;
  /** Resume the run (already gated by zBound at the call site). */
  onConfirm: () => void;
}

export function DrillToolChangeCard({
  toolName,
  diameterMm,
  nextColor,
  hasProbe,
  probe,
  zBound,
  onZBound,
  onConfirm,
}: DrillToolChangeCardProps) {
  const { t } = useTranslation("drill");
  const { fmtLen } = useUnitFormat();

  const [method, setMethod] = useState<"probe" | "manual">(hasProbe ? "probe" : "manual");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Connectivity self-test: latches once the probe pin is seen active (operator
  // taps the clip to the bit). Guards "забыли подключить щуп" before any motion.
  const [probeTested, setProbeTested] = useState(false);

  // Live probe pin (Pn:P) — drives the self-test latch and the shorted pre-check.
  const probeActive = useMachine((s) => s.status.pins?.probe ?? false);
  useEffect(() => {
    if (probeActive) setProbeTested(true);
  }, [probeActive]);

  // Manual Z jog (step jog only — reuse the shared controller + step selector).
  const steps = useSettings((s) => s.cncProfile.jogStepsMm);
  const { enabled, step, setStep, continuous, go } = useJog();

  const runProbe = async () => {
    if (probeActive) {
      setError(t("toolChange.probeShorted"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.machine.probeZ(probe.maxDistMm, probe.feedMmMin, probe.offsetMm, probe.safeZMm);
      onZBound();
    } catch {
      setError(t("toolChange.probeFail"));
    } finally {
      setBusy(false);
    }
  };

  const bindManual = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.machine.setZero(false, false, true);
      onZBound();
    } catch {
      setError(t("toolChange.probeFail"));
    } finally {
      setBusy(false);
    }
  };

  const tabBtn = (m: "probe" | "manual", label: string, Icon: typeof ScanLine) => (
    <button
      type="button"
      onClick={() => {
        setMethod(m);
        setError(null);
      }}
      className={
        "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-[12px] transition-colors " +
        (method === m
          ? "bg-amber-500/25 font-semibold text-amber-100"
          : "text-amber-200/70 hover:text-amber-100")
      }
    >
      <Icon className="size-3.5" />
      {label}
    </button>
  );

  return (
    <div className="mx-4 mb-3 flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
      <p className="text-[13px] font-semibold text-amber-300">{t("toolChange.title")}</p>

      <div className="flex items-center gap-2">
        <span className="inline-block h-3 w-3 shrink-0 rounded-sm" style={{ backgroundColor: nextColor }} />
        <span className="text-xs text-amber-200">
          {t("toolChange.install", { diameter: fmtLen(diameterMm) })}
        </span>
        {toolName && (
          <span className="ml-auto max-w-[120px] truncate text-[11px] text-amber-300/70">{toolName}</span>
        )}
      </div>

      {/* --- Z touch-off block --- */}
      <div className="mt-1 flex flex-col gap-2 rounded-md border border-amber-500/30 bg-background/30 p-2">
        <div className="flex items-center gap-1.5">
          <Ruler className="size-3.5 text-amber-300" />
          <span className="text-[12px] font-medium text-amber-200">{t("toolChange.zTitle")}</span>
          {zBound && (
            <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-emerald-400">
              <Check className="size-3" />
              {t("toolChange.zBound")}
            </span>
          )}
        </div>

        {hasProbe && (
          <div className="inline-flex rounded-md border border-amber-500/30 p-0.5">
            {tabBtn("probe", t("toolChange.tabProbe"), ScanLine)}
            {tabBtn("manual", t("toolChange.tabManual"), Hand)}
          </div>
        )}

        {method === "probe" ? (
          <>
            <p className="text-[11px] text-amber-200/70">
              {probeTested ? t("toolChange.probeOk") : t("toolChange.probeTest")}
            </p>
            <Button
              size="sm"
              className="w-full border-amber-500/40 bg-amber-500/20 text-amber-100 hover:bg-amber-500/30"
              disabled={!enabled || busy || !probeTested}
              onClick={() => void runProbe()}
            >
              {busy ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="size-3.5 animate-spin" />
                  {t("toolChange.probing")}
                </span>
              ) : (
                t("toolChange.probeBtn")
              )}
            </Button>
          </>
        ) : (
          <>
            <p className="text-[11px] text-amber-200/70">{t("toolChange.manualHint")}</p>
            <div className="flex items-center justify-between gap-2">
              <div className="flex gap-1.5">
                <Button size="sm" variant="outline" disabled={!enabled} onClick={() => go(0, 0, 1)}>
                  Z+
                </Button>
                <Button size="sm" variant="outline" disabled={!enabled} onClick={() => go(0, 0, -1)}>
                  Z−
                </Button>
              </div>
              <JogStepControl steps={steps} step={step} setStep={setStep} continuous={continuous} />
            </div>
            <Button
              size="sm"
              className="w-full border-amber-500/40 bg-amber-500/20 text-amber-100 hover:bg-amber-500/30"
              disabled={!enabled || busy}
              onClick={() => void bindManual()}
            >
              {t("toolChange.manualBind")}
            </Button>
          </>
        )}

        {error && <p className="text-[11px] text-red-400">{error}</p>}
      </div>

      {/* Checklist */}
      <ol className="flex list-inside list-decimal flex-col gap-1 text-[11px] text-amber-200/80">
        <li>{t("toolChange.step1")}</li>
        <li>{t("toolChange.step2")}</li>
        <li>{t("toolChange.step3")}</li>
      </ol>

      {/* Confirm — gated by zBound */}
      <Button
        size="sm"
        className="mt-1 w-full border-amber-500/40 bg-amber-500/20 text-amber-200 hover:bg-amber-500/30"
        disabled={!zBound}
        title={zBound ? undefined : t("toolChange.confirmHint")}
        onClick={onConfirm}
      >
        {t("toolChange.confirm")}
      </Button>
      {!zBound && <p className="text-center text-[10px] text-amber-200/60">{t("toolChange.confirmHint")}</p>}
    </div>
  );
}

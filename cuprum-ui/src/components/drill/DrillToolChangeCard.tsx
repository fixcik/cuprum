import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowDownToLine,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Hand,
  Loader2,
  Pause,
  Play,
  PlugZap,
  ScanLine,
} from "lucide-react";
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
  /** Probe seek distance (mm) for the FIRST tool change, where no work-Z exists
   *  yet so the fast «high park → rapid to safe-Z → short probe» can't run. Here
   *  G38.2 descends the full distance from the current (post-homing) Z to find the
   *  surface. Typically the Z work envelope. */
  firstMaxDistMm: number;
}

export interface DrillToolChangeCardProps {
  diameterMm: number;
  nextColor: string;
  /** Holes the upcoming bit will drill — shown as «N отв.» on the card. */
  holesAhead: number;
  /** Whether a Z-probe is available (shows the «Щупом» tab + makes it default). */
  hasProbe: boolean;
  /** The very first tool change of the run (work-Z not bound yet). On the first
   *  change the probe must NOT rapid to a work-frame safe-Z (it's a stale offset →
   *  unsafe); G38.2 descends from the current Z instead. Also drives the card title
   *  («Старт · привязка Z» vs «Пауза · смените сверло») and the checklist wording. */
  firstToolChange: boolean;
  probe: ProbeConfig;
  /** Z bound for the current bit — gates the confirm/resume button. */
  zBound: boolean;
  /** Probe circuit tested THIS session (once per run). When true the probe path
   *  skips «step 1 · circuit test» and goes straight to «set Z by probe». */
  probeChecked: boolean;
  /** Called after a successful probe / manual touch-off (dispatches the Z gate). */
  onZBound: () => void;
  /** Called once the probe circuit is confirmed closed (latches `probeChecked`). */
  onProbeChecked: () => void;
  /** Resume the run (already gated by zBound at the call site). */
  onConfirm: () => void;
}

// Solid amber action button (probe step 2 / manual confirm / resume). Dark text
// on amber per the design tokens — never the muted translucent brown.
const SOLID_WARNING =
  "flex w-full items-center justify-center gap-2 rounded-lg bg-warning py-2.5 text-[13px] font-semibold text-[hsl(38_60%_12%)] transition-opacity hover:opacity-90 disabled:opacity-50";

export function DrillToolChangeCard({
  diameterMm,
  nextColor,
  holesAhead,
  hasProbe,
  firstToolChange,
  probe,
  zBound,
  probeChecked,
  onZBound,
  onProbeChecked,
  onConfirm,
}: DrillToolChangeCardProps) {
  const { t } = useTranslation("drill");
  const { fmtLen } = useUnitFormat();

  const [method, setMethod] = useState<"probe" | "manual">(hasProbe ? "probe" : "manual");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live probe pin (Pn:P) — drives the circuit self-test and the shorted pre-check.
  const probeActive = useMachine((s) => s.status.pins?.probe ?? false);

  // Auto-advance step 1 → step 2 the moment the operator touches the probe to the
  // bit (pin latches). The explicit button below is the affordance/fallback.
  useEffect(() => {
    if (probeActive && !probeChecked) onProbeChecked();
  }, [probeActive, probeChecked, onProbeChecked]);

  // Manual Z jog (step jog only — reuse the shared controller + step selector).
  const steps = useSettings((s) => s.cncProfile.jogStepsMm);
  const { enabled, step, setStep, continuous, go } = useJog();

  // Step 1 (probe): confirm the circuit is closed. The pin is active only WHILE the
  // operator touches the bit, so check the live pin on click; the effect above also
  // latches it automatically on touch.
  const checkCircuit = () => {
    if (probeActive) {
      onProbeChecked();
      setError(null);
    } else {
      setError(t("toolChange.probeOpen"));
    }
  };

  // Step 2 (probe): the actual G38.2 plunge down to the copper.
  const runProbe = async () => {
    if (probeActive) {
      setError(t("toolChange.probeShorted"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // First tool change: work-Z is unbound, so there is no valid safe-Z to rapid
      // to — descend the full distance from the current (post-homing) Z with G38.2
      // and no work-frame approach. Later changes: the previous tool's work-Z is
      // bound, so rapid down to safe-Z first, then a short probe.
      const approachZ = firstToolChange ? undefined : probe.safeZMm;
      const maxDist = firstToolChange ? probe.firstMaxDistMm : probe.maxDistMm;
      await api.machine.probeZ(maxDist, probe.feedMmMin, probe.offsetMm, probe.safeZMm, approachZ);
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
      setError(t("toolChange.manualFail"));
    } finally {
      setBusy(false);
    }
  };

  const methodToggle = (
    <div className="flex gap-0.5 rounded-lg bg-card/60 p-0.5">
      {(
        [
          { id: "probe", icon: <ScanLine className="size-3.5" />, label: t("toolChange.tabProbe") },
          { id: "manual", icon: <Hand className="size-3.5" />, label: t("toolChange.tabManual") },
        ] as const
      ).map((opt) => (
        <button
          key={opt.id}
          type="button"
          onClick={() => {
            setMethod(opt.id);
            setError(null);
          }}
          className={
            "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors " +
            (method === opt.id
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground")
          }
        >
          {opt.icon}
          {opt.label}
        </button>
      ))}
    </div>
  );

  const probeBlock = !probeChecked ? (
    // Step 1 · circuit test
    <div className="rounded-lg border border-warning/30 bg-warning/[0.05] px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-warning">
        <PlugZap className="size-3.5" />
        {t("toolChange.probeStep1Title")}
      </div>
      <div className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
        {t("toolChange.probeStep1Hint")}
      </div>
      <button
        type="button"
        onClick={checkCircuit}
        className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-warning/50 bg-warning/10 py-2 text-[12px] font-semibold text-warning transition-colors hover:bg-warning/15"
      >
        <Hand className="size-4" />
        {t("toolChange.probeStep1Btn")}
      </button>
    </div>
  ) : (
    // Step 2 · set Z by probe (circuit already verified this session)
    <>
      <div className="mb-2 flex items-center gap-1.5 rounded-md bg-primary/10 px-2 py-1.5 text-[10.5px] font-medium text-primary">
        <CheckCircle2 className="size-3.5" />
        {t("toolChange.probeReady")}
      </div>
      <button type="button" className={SOLID_WARNING} disabled={!enabled || busy} onClick={() => void runProbe()}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <ScanLine className="size-4" />}
        {busy ? t("toolChange.probing") : t("toolChange.probeStep2Btn")}
      </button>
      <div className="mt-1.5 text-center text-[10px] text-muted-foreground">
        {t("toolChange.probeStep2Hint")}
      </div>
    </>
  );

  const manualBlock = (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t("toolChange.manualHint")}</p>
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-1.5">
          <button
            type="button"
            disabled={!enabled}
            onClick={() => go(0, 0, -1)}
            title="Z−"
            className="grid h-9 w-12 place-items-center rounded-md border border-border bg-card text-foreground transition-colors hover:border-primary/40 hover:bg-foreground/5 disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronDown className="size-4" />
          </button>
          <button
            type="button"
            disabled={!enabled}
            onClick={() => go(0, 0, 1)}
            title="Z+"
            className="grid h-9 w-12 place-items-center rounded-md border border-border bg-card text-foreground transition-colors hover:border-primary/40 hover:bg-foreground/5 disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronUp className="size-4" />
          </button>
        </div>
        <JogStepControl steps={steps} step={step} setStep={setStep} continuous={continuous} />
      </div>
      <button type="button" className={SOLID_WARNING} disabled={!enabled || busy} onClick={() => void bindManual()}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowDownToLine className="size-4" />}
        {t("toolChange.manualConfirm")}
      </button>
    </div>
  );

  // Checklist marker: ✓ once Z is bound, else the step number.
  const mark = (n: number) =>
    zBound ? <span className="text-primary">✓</span> : <span className="text-foreground/60">{n}.</span>;

  return (
    <div className="mx-3 mb-3 overflow-hidden rounded-xl border border-warning/40 bg-warning/[0.06]">
      {/* Card header */}
      <div className="flex items-center gap-2 border-b border-warning/20 bg-warning/10 px-3 py-2 text-[12px] font-semibold text-warning">
        <Pause className="size-4" />
        {firstToolChange ? t("toolChange.titleFirstZ") : t("toolChange.titleChange")}
      </div>

      <div className="px-3 py-3">
        {/* Bit summary */}
        <div className="mb-3 flex items-center gap-3">
          <div
            className="grid size-11 place-items-center rounded-lg"
            style={{ background: `${nextColor}22` }}
          >
            <span className="size-3.5 rounded-full" style={{ background: nextColor }} />
          </div>
          <div className="min-w-0">
            <div className="text-[11px] text-muted-foreground">{t("toolChange.bitLabel")}</div>
            <div className="truncate text-[17px] font-semibold tabular-nums text-foreground">
              {fmtLen(diameterMm)}
            </div>
          </div>
          <div className="ml-auto text-right">
            <div className="text-[10px] text-muted-foreground">
              {firstToolChange ? t("toolChange.holesFirst") : t("toolChange.holesNext")}
            </div>
            <div className="text-[12px] tabular-nums text-foreground">
              {t("toolChange.holesShort", { n: holesAhead })}
            </div>
          </div>
        </div>

        {/* Checklist */}
        <ol className="mb-3 flex flex-col gap-1 text-[11px] text-muted-foreground">
          <li className="flex gap-2">
            {mark(1)}
            <span>
              {firstToolChange
                ? t("toolChange.ck1First", { diameter: fmtLen(diameterMm) })
                : t("toolChange.ck1Change", { diameter: fmtLen(diameterMm) })}
            </span>
          </li>
          <li className="flex gap-2">
            {mark(2)}
            <span>{method === "probe" ? t("toolChange.ck2Probe") : t("toolChange.ck2Manual")}</span>
          </li>
          <li className="flex gap-2">
            <span className="text-foreground/60">3.</span>
            <span>{firstToolChange ? t("toolChange.ck3First") : t("toolChange.ck3Change")}</span>
          </li>
        </ol>

        {/* Action: resume once Z is bound, else the Z touch-off flow */}
        {zBound ? (
          <button type="button" className={SOLID_WARNING} onClick={onConfirm}>
            <Play className="size-4" />
            {firstToolChange ? t("toolChange.resumeFirst") : t("toolChange.resumeMore")}
          </button>
        ) : (
          <>
            {hasProbe && <div className="mb-2">{methodToggle}</div>}
            {method === "probe" ? probeBlock : manualBlock}
            {error && <p className="mt-2 text-[11px] text-red-400">{error}</p>}
          </>
        )}
      </div>
    </div>
  );
}

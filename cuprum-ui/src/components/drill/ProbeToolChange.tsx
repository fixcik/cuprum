import { useTranslation } from "react-i18next";
import { CheckCircle2, Hand, Loader2, PlugZap, ScanLine } from "lucide-react";

// Solid amber action button (probe step 2). Dark text on amber per the design
// tokens — never the muted translucent brown. Kept identical to the manual tab's
// button so the resume/confirm affordances read the same.
const SOLID_WARNING =
  "flex w-full items-center justify-center gap-2 rounded-lg bg-warning py-2.5 text-[13px] font-semibold text-[hsl(38_60%_12%)] transition-opacity hover:opacity-90 disabled:opacity-50";

/** Probe (G38.2) Z touch-off tab of the tool-change card. Two steps: (1) confirm
 *  the probe circuit is closed, then (2) run the actual probe plunge. The parent
 *  owns the shared state (`probeChecked`, `busy`, `enabled`) and the side effects
 *  (circuit latch, the G38.2 call) — this is a pure presentation of the step. */
export function ProbeToolChange({
  probeChecked,
  enabled,
  busy,
  onCheckCircuit,
  onRunProbe,
}: {
  /** Probe circuit already verified this session → show step 2 directly. */
  probeChecked: boolean;
  /** Motion allowed (connected + idle) — gates the step-2 plunge button. */
  enabled: boolean;
  /** A probe/manual action is in flight. */
  busy: boolean;
  /** Step 1: confirm the circuit reads closed (latches `probeChecked`). */
  onCheckCircuit: () => void;
  /** Step 2: run the G38.2 plunge down to the copper. */
  onRunProbe: () => void;
}) {
  const { t } = useTranslation("drill");

  return !probeChecked ? (
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
        onClick={onCheckCircuit}
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
      <button type="button" className={SOLID_WARNING} disabled={!enabled || busy} onClick={onRunProbe}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <ScanLine className="size-4" />}
        {busy ? t("toolChange.probing") : t("toolChange.probeStep2Btn")}
      </button>
      <div className="mt-1.5 text-center text-[10px] text-muted-foreground">
        {t("toolChange.probeStep2Hint")}
      </div>
    </>
  );
}

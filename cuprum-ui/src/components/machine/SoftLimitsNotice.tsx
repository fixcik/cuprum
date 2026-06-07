import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";
import { api } from "@/lib/api";

/** How far GRBL's reported max travel may differ from the configured work
 *  envelope before we flag a mismatch (mm). */
const TRAVEL_TOL_MM = 0.5;

/** Soft warning shown while connected when GRBL soft limits are off or its
 *  max-travel ($130/$131/$132) does not match the configured work envelope.
 *  "Configure soft limits" writes the envelope into the firmware ($20, $13x,
 *  $22) and re-queries settings. Hidden while the state is still unknown
 *  (softLimitsEnabled === null) so a freshly-connected machine doesn't flash a
 *  warning before its $$ reply arrives. */
export function SoftLimitsNotice() {
  const { t } = useTranslation("machine");
  const connected = useMachine((s) => s.connected);
  const softLimitsEnabled = useMachine((s) => s.softLimitsEnabled);
  const maxTravelMm = useMachine((s) => s.maxTravelMm);
  const env = useSettings((s) => s.cncProfile.workEnvelopeMm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!connected || softLimitsEnabled === null) return null;

  // Travel mismatch: any reported axis off the envelope by more than tolerance.
  const travelMismatch =
    !!maxTravelMm &&
    (Math.abs(maxTravelMm[0] - env.x) > TRAVEL_TOL_MM ||
      Math.abs(maxTravelMm[1] - env.y) > TRAVEL_TOL_MM ||
      Math.abs(maxTravelMm[2] - env.z) > TRAVEL_TOL_MM);

  if (softLimitsEnabled && !travelMismatch) return null;

  const message = !softLimitsEnabled ? t("softLimits.disabled") : t("softLimits.mismatch");

  // Push the configured work envelope into the firmware as soft limits, one line
  // at a time and BLOCKING on each `ok`, so a dropped/rejected write can't be
  // mistaken for success (a blind fire-and-forget send never reaches EEPROM yet
  // the warning would clear, then return on the next reconnect). The envelope is
  // the per-machine source of truth — no hard-coded sizes. After every line is
  // acknowledged, re-query $$ so the local soft-limit state refreshes and the
  // warning clears for good.
  const configure = async () => {
    setBusy(true);
    setError(null);
    const writes = [
      "$20=1",
      `$130=${env.x.toFixed(3)}`,
      `$131=${env.y.toFixed(3)}`,
      `$132=${env.z.toFixed(3)}`,
      "$22=1",
    ];
    try {
      for (const line of writes) {
        await api.machine.sendAwaitOk(line);
      }
      await api.machine.send("$$");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="anim-in flex flex-col gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-2 text-[12px] text-amber-500">
      <div className="flex items-center gap-2.5">
        <ShieldAlert className="size-4 shrink-0" />
        <span className="flex-1 font-medium">{message}</span>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          className="border-amber-500/40 text-amber-500 hover:bg-amber-500/20"
          onClick={() => void configure()}
        >
          {busy ? t("softLimits.configuring") : t("softLimits.configure")}
        </Button>
      </div>
      {error && (
        <span className="pl-[26px] text-[11px] text-red-400">
          {t("softLimits.error", { error })}
        </span>
      )}
    </div>
  );
}

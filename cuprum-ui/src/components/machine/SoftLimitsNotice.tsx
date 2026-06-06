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

  if (!connected || softLimitsEnabled === null) return null;

  // Travel mismatch: any reported axis off the envelope by more than tolerance.
  const travelMismatch =
    !!maxTravelMm &&
    (Math.abs(maxTravelMm[0] - env.x) > TRAVEL_TOL_MM ||
      Math.abs(maxTravelMm[1] - env.y) > TRAVEL_TOL_MM ||
      Math.abs(maxTravelMm[2] - env.z) > TRAVEL_TOL_MM);

  if (softLimitsEnabled && !travelMismatch) return null;

  const message = !softLimitsEnabled ? t("softLimits.disabled") : t("softLimits.mismatch");

  // Push the work envelope into the firmware as soft limits, then re-query to
  // refresh the local state. Sent one line at a time so each setting is
  // acknowledged before the next; failures are logged but don't abort the rest.
  const configure = async () => {
    const lines = [
      "$20=1",
      `$130=${env.x.toFixed(3)}`,
      `$131=${env.y.toFixed(3)}`,
      `$132=${env.z.toFixed(3)}`,
      "$22=1",
      "$$",
    ];
    for (const line of lines) {
      try {
        await api.machine.send(line);
      } catch (e) {
        console.error(`soft-limits: failed to send ${line}`, e);
      }
    }
  };

  return (
    <div className="anim-in flex items-center gap-2.5 rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-2 text-[12px] text-amber-500">
      <ShieldAlert className="size-4 shrink-0" />
      <span className="flex-1 font-medium">{message}</span>
      <Button
        variant="outline"
        size="sm"
        className="border-amber-500/40 text-amber-500 hover:bg-amber-500/20"
        onClick={() => void configure()}
      >
        {t("softLimits.configure")}
      </Button>
    </div>
  );
}

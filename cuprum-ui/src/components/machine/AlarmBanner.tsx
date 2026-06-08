import { useTranslation } from "react-i18next";
import { TriangleAlert } from "lucide-react";
import { useMachine } from "@/machineStore";
import { useUnlockSuppressed } from "@/hooks/useUnlockSuppressed";
import { AlarmActions } from "@/components/machine/AlarmActions";

/** Banner shown while the machine is in alarm: explains the state and offers a
 *  one-click unlock ($X). Renders nothing in other states. Hides at once when
 *  unlock is pressed in any window (optimistic), reappearing only if the alarm
 *  outlives the grace window. */
export function AlarmBanner() {
  const { t } = useTranslation("machine");
  const state = useMachine((s) => s.status.state);
  const pins = useMachine((s) => s.status.pins);
  const unlockSuppressed = useUnlockSuppressed();
  if (state !== "alarm" || unlockSuppressed) return null;
  // A stuck limit switch needs the dedicated recovery flow (plain $X can't move
  // off an engaged switch with hard limits on) — defer to LimitRecoveryNotice.
  if (pins?.x || pins?.y || pins?.z) return null;

  return (
    <div className="anim-in flex items-center gap-2.5 rounded-lg border border-destructive/40 bg-destructive/15 px-3 py-2 text-[12px] text-destructive">
      <TriangleAlert className="size-4 shrink-0" />
      <span className="flex-1 font-medium">{t("alarm")}</span>
      <AlarmActions />
    </div>
  );
}

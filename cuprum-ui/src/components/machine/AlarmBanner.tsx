import { useTranslation } from "react-i18next";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useMachine } from "@/machineStore";
import { api } from "@/lib/api";

/** Banner shown while the machine is in alarm: explains the state and offers a
 *  one-click unlock ($X). Renders nothing in other states. */
export function AlarmBanner() {
  const { t } = useTranslation("machine");
  const state = useMachine((s) => s.status.state);
  const pins = useMachine((s) => s.status.pins);
  if (state !== "alarm") return null;
  // A stuck limit switch needs the dedicated recovery flow (plain $X can't move
  // off an engaged switch with hard limits on) — defer to LimitRecoveryNotice.
  if (pins?.x || pins?.y || pins?.z) return null;

  return (
    <div className="anim-in flex items-center gap-2.5 rounded-lg border border-destructive/40 bg-destructive/15 px-3 py-2 text-[12px] text-destructive">
      <TriangleAlert className="size-4 shrink-0" />
      <span className="flex-1 font-medium">{t("alarm")}</span>
      <Button
        variant="outline"
        size="sm"
        className="border-destructive/40 text-destructive hover:bg-destructive/20"
        onClick={() => void api.machine.unlock()}
      >
        {t("controls.unlock")}
      </Button>
    </div>
  );
}

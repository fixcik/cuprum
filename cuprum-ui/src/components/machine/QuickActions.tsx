import { useTranslation } from "react-i18next";
import { Home, Pause, Play, RotateCcw, Unlock } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useMachine } from "@/machineStore";
import { api } from "@/lib/api";
import { canMove } from "@/lib/machineControls";
import { cn } from "@/lib/utils";

/** Control-command buttons: home (gated by homing support), unlock, feed-hold,
 *  resume (cycle-start) and soft reset. Wraps to fit the column width. */
export function QuickActions({ className }: { className?: string }) {
  const { t } = useTranslation("machine");
  const connected = useMachine((s) => s.connected);
  const state = useMachine((s) => s.status.state);
  const homingAvailable = useMachine((s) => s.homingAvailable);
  const homing = useMachine((s) => s.homing);
  const runHoming = useMachine((s) => s.runHoming);
  const movable = canMove(state, connected);
  const isHold = state === "hold";
  // Feed-hold only makes sense while the machine is actively moving.
  const canHold = state === "run" || state === "jog" || state === "home";

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <Button
        variant="warn"
        disabled={!movable || !homingAvailable || homing}
        onClick={() => void runHoming()}
      >
        <Home />
        {t("controls.home")}
      </Button>
      <Button variant="outline" disabled={!connected} onClick={() => void api.machine.unlock()}>
        <Unlock />
        {t("controls.unlock")}
      </Button>
      <Button
        variant="outline"
        disabled={!connected || !canHold}
        onClick={() => void api.machine.feedHold()}
      >
        <Pause />
        {t("controls.feedHold")}
      </Button>
      <Button
        variant="outline"
        disabled={!connected || !isHold}
        onClick={() => void api.machine.cycleStart()}
      >
        <Play />
        {t("controls.cycleStart")}
      </Button>
      <Button variant="secondary" disabled={!connected} onClick={() => void api.machine.softReset()}>
        <RotateCcw />
        {t("controls.softReset")}
      </Button>
    </div>
  );
}

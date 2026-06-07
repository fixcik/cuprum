import { useTranslation } from "react-i18next";
import { Home, Pause, Play, RotateCcw, Unlock } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useMachine } from "@/machineStore";
import { api } from "@/lib/api";
import { canMove } from "@/lib/machineControls";
import { cn } from "@/lib/utils";

/** Control-command buttons for the toolbar: home (gated by homing support),
 *  unlock, feed-hold, resume (cycle-start) and soft reset. Compact icon buttons;
 *  labels appear only on wide widths (2xl) and otherwise live in the tooltip, so
 *  the row never crowds out the status pill / E-Stop. */
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

  const label = (key: string) => <span className="hidden 2xl:inline">{t(key)}</span>;

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <Button
        variant="warn"
        size="sm"
        title={t("controls.home")}
        disabled={!movable || !homingAvailable || homing}
        onClick={() => void runHoming()}
      >
        <Home />
        {label("controls.home")}
      </Button>
      <Button
        variant="outline"
        size="sm"
        title={t("controls.unlock")}
        disabled={!connected}
        onClick={() => void api.machine.unlock()}
      >
        <Unlock />
        {label("controls.unlock")}
      </Button>
      <Button
        variant="outline"
        size="sm"
        title={t("controls.feedHold")}
        disabled={!connected || !canHold}
        onClick={() => void api.machine.feedHold()}
      >
        <Pause />
        {label("controls.feedHold")}
      </Button>
      <Button
        variant="outline"
        size="sm"
        title={t("controls.cycleStart")}
        disabled={!connected || !isHold}
        onClick={() => void api.machine.cycleStart()}
      >
        <Play />
        {label("controls.cycleStart")}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        title={t("controls.softReset")}
        disabled={!connected}
        onClick={() => void api.machine.softReset()}
      >
        <RotateCcw />
        {label("controls.softReset")}
      </Button>
    </div>
  );
}

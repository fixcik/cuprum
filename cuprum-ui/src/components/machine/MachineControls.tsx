import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { useMachine } from "@/machineStore";
import { api } from "@/lib/api";
import { canMove } from "@/lib/machineControls";

export function MachineControls() {
  const { t } = useTranslation("machine");
  const connected = useMachine((s) => s.connected);
  const state = useMachine((s) => s.status.state);
  const canHome = canMove(state, connected);

  return (
    <div className="flex flex-wrap gap-2">
      <Button disabled={!canHome} onClick={() => void api.machine.home()}>{t("controls.home")}</Button>
      <Button variant="secondary" disabled={!connected} onClick={() => void api.machine.unlock()}>{t("controls.unlock")}</Button>
      <Button variant="secondary" disabled={!connected} onClick={() => void api.machine.feedHold()}>{t("controls.feedHold")}</Button>
      <Button variant="secondary" disabled={!connected} onClick={() => void api.machine.cycleStart()}>{t("controls.cycleStart")}</Button>
      <Button variant="destructive" disabled={!connected} onClick={() => void api.machine.softReset()}>{t("controls.softReset")}</Button>
    </div>
  );
}

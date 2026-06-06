import { useTranslation } from "react-i18next";
import { ConnectionBar } from "@/components/machine/ConnectionBar";
import { Dro } from "@/components/machine/Dro";
import { JogPad } from "@/components/machine/JogPad";
import { SpindleControl } from "@/components/machine/SpindleControl";
import { MachineControls } from "@/components/machine/MachineControls";
import { Console } from "@/components/machine/Console";
import { useMachine } from "@/machineStore";

/** Live machine control surface: connection bar, alarm banner, the DRO/jog/
 *  spindle/control stack, and the console. Operates on the single current
 *  connection. Reusable as a page body or as a tab inside the equipment editor. */
export function MachineControlPanel() {
  const { t } = useTranslation("machine");
  const state = useMachine((s) => s.status.state);
  const connected = useMachine((s) => s.connected);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ConnectionBar />
      {connected && state === "alarm" && (
        <div className="bg-destructive/15 px-4 py-1.5 text-xs text-destructive">{t("alarm")}</div>
      )}
      <div className="flex min-h-0 flex-1 gap-4 p-4">
        <div className="flex flex-col gap-4">
          <Dro />
          <JogPad />
          <SpindleControl />
          <MachineControls />
        </div>
        <Console />
      </div>
    </div>
  );
}

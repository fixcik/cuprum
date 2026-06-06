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
      {/* Narrow panes (e.g. the equipment editor in a small window) stack the
       *  controls above the console and scroll vertically; wide panes lay them
       *  out side by side and fill the height. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4 lg:flex-row lg:overflow-hidden">
        <div className="flex shrink-0 flex-col gap-4">
          <Dro />
          <JogPad />
          <SpindleControl />
          <MachineControls />
        </div>
        <div className="flex min-h-[16rem] flex-col lg:min-h-0 lg:flex-1">
          <Console />
        </div>
      </div>
    </div>
  );
}

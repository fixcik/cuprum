import { useTranslation } from "react-i18next";
import { useSettings } from "@/settingsStore";
import { NumberField } from "@/components/settings/fields";
import { CncMachineFields } from "@/components/settings/CncMachineFields";
import type { Machine } from "@/lib/machine";

/** Right detail pane of the equipment section: the editor for the selected
 *  machine, dispatched by kind. Empty state when nothing is selected. */
export function MachineEditor({ machine }: { machine: Machine | null }) {
  const { t } = useTranslation("settings");
  const update = useSettings((s) => s.updateMachine);

  if (machine === null) {
    return <p className="text-[12px] text-muted-foreground">{t("equipment.empty")}</p>;
  }

  return (
    <div>
      <h3 className="mb-3 text-[13px] font-semibold text-foreground">{machine.name}</h3>
      {machine.kind === "cnc" && <CncMachineFields machine={machine} />}
      {machine.kind === "uvlcd" && (
        <div className="divide-y divide-border/60">
          <NumberField
            label={t("equipment.screenWidth")}
            value={machine.screenWidthMm}
            dim="coarse"
            onChange={(screenWidthMm) => update(machine.id, { screenWidthMm })}
          />
          <NumberField
            label={t("equipment.screenHeight")}
            value={machine.screenHeightMm}
            dim="coarse"
            onChange={(screenHeightMm) => update(machine.id, { screenHeightMm })}
          />
        </div>
      )}
    </div>
  );
}

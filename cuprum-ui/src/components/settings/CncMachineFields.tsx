import { useTranslation } from "react-i18next";
import { useSettings } from "@/settingsStore";
import { NumberField, BoolField } from "@/components/settings/fields";
import type { CncMachine } from "@/lib/machine";

/** Field editor for a single CNC machine. Reads/writes the machine directly via
 *  `updateMachine`. Exposes the persistent configuration fields; runtime-tunable
 *  jog settings (jogFeedMmMin / jogStepsMm) are edited in-context in the jog pad. */
export function CncMachineFields({ machine }: { machine: CncMachine }) {
  const { t } = useTranslation("settings");
  const update = useSettings((s) => s.updateMachine);
  return (
    <div className="divide-y divide-border/60">
      <NumberField
        label={t("cnc.envX")}
        value={machine.workEnvelopeMm.x}
        dim="coarse"
        onChange={(x) => update(machine.id, { workEnvelopeMm: { ...machine.workEnvelopeMm, x } })}
      />
      <NumberField
        label={t("cnc.envY")}
        value={machine.workEnvelopeMm.y}
        dim="coarse"
        onChange={(y) => update(machine.id, { workEnvelopeMm: { ...machine.workEnvelopeMm, y } })}
      />
      <NumberField
        label={t("cnc.envZ")}
        value={machine.workEnvelopeMm.z}
        dim="coarse"
        onChange={(z) => update(machine.id, { workEnvelopeMm: { ...machine.workEnvelopeMm, z } })}
      />
      <NumberField
        label={t("cnc.spindleMaxRpm")}
        value={machine.spindleMaxRpm}
        step="100"
        suffix={t("cnc.unitRpm")}
        onChange={(spindleMaxRpm) => update(machine.id, { spindleMaxRpm })}
      />
      <BoolField
        label={t("cnc.spindleControllable")}
        value={machine.spindleControllable}
        onChange={(spindleControllable) => update(machine.id, { spindleControllable })}
      />
      <BoolField
        label={t("cnc.spindleHasPwm")}
        value={machine.spindleHasPwm}
        onChange={(spindleHasPwm) => update(machine.id, { spindleHasPwm })}
      />
      <NumberField
        label={t("cnc.safeZ")}
        value={machine.safeZMm}
        dim="coarse"
        help={t("cnc.safeZHelp")}
        onChange={(safeZMm) => update(machine.id, { safeZMm })}
      />
      <NumberField
        label={t("cnc.machineSafeZ")}
        value={machine.machineSafeZMm}
        dim="coarse"
        help={t("cnc.machineSafeZHelp")}
        onChange={(machineSafeZMm) => update(machine.id, { machineSafeZMm })}
      />
      <NumberField
        label={t("cnc.runout")}
        value={machine.runoutMm}
        dim="fine"
        onChange={(runoutMm) => update(machine.id, { runoutMm })}
      />
      <NumberField
        label={t("cnc.backlashX")}
        value={machine.backlashMm.x}
        dim="fine"
        onChange={(x) => update(machine.id, { backlashMm: { ...machine.backlashMm, x } })}
      />
      <NumberField
        label={t("cnc.backlashY")}
        value={machine.backlashMm.y}
        dim="fine"
        onChange={(y) => update(machine.id, { backlashMm: { ...machine.backlashMm, y } })}
      />
      <NumberField
        label={t("cnc.backlashZ")}
        value={machine.backlashMm.z}
        dim="fine"
        onChange={(z) => update(machine.id, { backlashMm: { ...machine.backlashMm, z } })}
      />
      <NumberField
        label={t("cnc.baud")}
        value={machine.baud}
        step="1"
        onChange={(baud) => update(machine.id, { baud })}
      />
      <label className="flex items-center justify-between gap-4 py-2">
        <span className="text-[12px] text-foreground">{t("cnc.dialect")}</span>
        <span className="rounded px-2 py-0.5 text-[11px] text-muted-foreground">GRBL 1.1</span>
      </label>
      <label className="flex flex-col gap-1 py-2">
        <span className="text-[12px] text-foreground">{t("cnc.prepend")}</span>
        <textarea
          value={machine.prependGcode}
          onChange={(e) => update(machine.id, { prependGcode: e.target.value })}
          rows={2}
          className="rounded-md border border-border bg-card px-2 py-1 font-mono text-[11px]"
        />
      </label>
      <label className="flex flex-col gap-1 py-2">
        <span className="text-[12px] text-foreground">{t("cnc.append")}</span>
        <textarea
          value={machine.appendGcode}
          onChange={(e) => update(machine.id, { appendGcode: e.target.value })}
          rows={2}
          className="rounded-md border border-border bg-card px-2 py-1 font-mono text-[11px]"
        />
      </label>
    </div>
  );
}

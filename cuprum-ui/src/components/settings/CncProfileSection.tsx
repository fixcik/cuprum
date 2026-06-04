import { useTranslation } from "react-i18next";
import { useSettings } from "@/settingsStore";
import { NumberField, BoolField } from "@/components/settings/fields";

export function CncProfileSection() {
  const { t } = useTranslation("settings");
  const cnc = useSettings((s) => s.cncProfile);
  const setCnc = useSettings((s) => s.setCncProfile);
  return (
    <div className="divide-y divide-border/60">
      <NumberField
        label={t("cnc.envX")}
        value={cnc.workEnvelopeMm.x}
        dim="coarse"
        onChange={(x) => setCnc({ workEnvelopeMm: { ...cnc.workEnvelopeMm, x } })}
      />
      <NumberField
        label={t("cnc.envY")}
        value={cnc.workEnvelopeMm.y}
        dim="coarse"
        onChange={(y) => setCnc({ workEnvelopeMm: { ...cnc.workEnvelopeMm, y } })}
      />
      <NumberField
        label={t("cnc.envZ")}
        value={cnc.workEnvelopeMm.z}
        dim="coarse"
        onChange={(z) => setCnc({ workEnvelopeMm: { ...cnc.workEnvelopeMm, z } })}
      />
      <NumberField
        label={t("cnc.spindleMaxRpm")}
        value={cnc.spindleMaxRpm}
        step="100"
        onChange={(spindleMaxRpm) => setCnc({ spindleMaxRpm })}
      />
      <BoolField
        label={t("cnc.spindleControllable")}
        value={cnc.spindleControllable}
        onChange={(spindleControllable) => setCnc({ spindleControllable })}
      />
      <BoolField
        label={t("cnc.spindleHasPwm")}
        value={cnc.spindleHasPwm}
        onChange={(spindleHasPwm) => setCnc({ spindleHasPwm })}
      />
      <NumberField
        label={t("cnc.safeZ")}
        value={cnc.safeZMm}
        dim="coarse"
        onChange={(safeZMm) => setCnc({ safeZMm })}
      />
      <NumberField
        label={t("cnc.runout")}
        value={cnc.runoutMm}
        dim="fine"
        onChange={(runoutMm) => setCnc({ runoutMm })}
      />
      <NumberField
        label={t("cnc.backlashX")}
        value={cnc.backlashMm.x}
        dim="fine"
        onChange={(x) => setCnc({ backlashMm: { ...cnc.backlashMm, x } })}
      />
      <NumberField
        label={t("cnc.backlashY")}
        value={cnc.backlashMm.y}
        dim="fine"
        onChange={(y) => setCnc({ backlashMm: { ...cnc.backlashMm, y } })}
      />
      <NumberField
        label={t("cnc.backlashZ")}
        value={cnc.backlashMm.z}
        dim="fine"
        onChange={(z) => setCnc({ backlashMm: { ...cnc.backlashMm, z } })}
      />
      <NumberField
        label={t("cnc.baud")}
        value={cnc.baud}
        step="1"
        onChange={(baud) => setCnc({ baud })}
      />
      <label className="flex items-center justify-between gap-4 py-2">
        <span className="text-[12px] text-foreground">{t("cnc.dialect")}</span>
        <span className="rounded px-2 py-0.5 text-[11px] text-muted-foreground">GRBL 1.1</span>
      </label>
      <label className="flex flex-col gap-1 py-2">
        <span className="text-[12px] text-foreground">{t("cnc.prepend")}</span>
        <textarea
          value={cnc.prependGcode}
          onChange={(e) => setCnc({ prependGcode: e.target.value })}
          rows={2}
          className="rounded-md border border-border bg-card px-2 py-1 font-mono text-[11px]"
        />
      </label>
      <label className="flex flex-col gap-1 py-2">
        <span className="text-[12px] text-foreground">{t("cnc.append")}</span>
        <textarea
          value={cnc.appendGcode}
          onChange={(e) => setCnc({ appendGcode: e.target.value })}
          rows={2}
          className="rounded-md border border-border bg-card px-2 py-1 font-mono text-[11px]"
        />
      </label>
    </div>
  );
}

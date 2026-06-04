import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { UnitField } from "@/components/ui/settings/UnitField";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { DEFAULT_TOOLING_DIAMETER_MM, REGISTRATION_SET_MARGIN_MM } from "@/lib/panel";

export interface RegistrationSetOptions {
  count: 2 | 4;
  marginMm: number;
  diameterMm: number;
  replace: boolean;
}

/** Small caption group (mirrors RenestDialog style). */
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">{children}</div>
    </div>
  );
}

/** Parameterised generator for a registration-hole set. Asks for layout (2
 *  diagonal / 4 corners), edge margin and diameter; when holes already exist it
 *  also offers add-vs-replace. Pure dialog — placement is delegated to onApply. */
export function RegistrationSetDialog({
  open,
  onClose,
  hasExisting,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  hasExisting: boolean;
  onApply: (opts: RegistrationSetOptions) => void;
}) {
  const { t } = useTranslation(["project", "common"]);
  const [count, setCount] = useState<"2" | "4">("4");
  const [marginMm, setMarginMm] = useState(REGISTRATION_SET_MARGIN_MM);
  const [diameterMm, setDiameterMm] = useState(DEFAULT_TOOLING_DIAMETER_MM);
  const [mode, setMode] = useState<"add" | "replace">("add");

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("panel.regset.title")}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("panel.renest.cancel")}
          </Button>
          <Button
            onClick={() => {
              onApply({
                count: count === "2" ? 2 : 4,
                marginMm,
                diameterMm,
                replace: hasExisting && mode === "replace",
              });
              onClose();
            }}
          >
            {t("panel.regset.apply")}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4 text-[12px]">
        <Group title={t("panel.regset.placement")}>
          <SegmentedControl<"2" | "4">
            value={count}
            onChange={setCount}
            options={[
              { value: "4", label: t("panel.regset.placement4") },
              { value: "2", label: t("panel.regset.placement2") },
            ]}
          />
        </Group>

        <Group title={t("panel.regset.params")}>
          <label className="flex items-center gap-1.5 text-muted-foreground">
            {t("panel.regset.margin")}
            <UnitField value={marginMm} onChange={setMarginMm} dim="fine" step="0.5" />
          </label>
          <label className="flex items-center gap-1.5 text-muted-foreground">
            {t("panel.tooling.diameter")}
            <UnitField value={diameterMm} onChange={setDiameterMm} dim="fine" step="0.5" />
          </label>
        </Group>

        {hasExisting && (
          <Group title={t("panel.regset.existing")}>
            <SegmentedControl<"add" | "replace">
              value={mode}
              onChange={setMode}
              options={[
                { value: "add", label: t("panel.regset.existingAdd") },
                { value: "replace", label: t("panel.regset.existingReplace") },
              ]}
            />
          </Group>
        )}
      </div>
    </Modal>
  );
}

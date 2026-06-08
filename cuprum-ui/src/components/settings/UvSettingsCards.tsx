import { useTranslation } from "react-i18next";
import { Monitor } from "lucide-react";
import { useSettings } from "@/settingsStore";
import { Card } from "@/components/ui/Card";
import { Row } from "@/components/ui/Row";
import { NumberInput } from "@/components/settings/fields";
import { WorkZone } from "@/components/settings/WorkZone";
import { matchesQuery } from "@/components/settings/SettingsToolbar";
import { useUnitFormat } from "@/i18n/useUnitFormat";
import type { UvLcdMachine } from "@/lib/machine";

/** Card-based config editor for a UV LCD machine: a single "Экран" card with the
 *  screen WorkZone viz + width/height editors. Live-persists via updateMachine.
 *  The dirty set is computed once in the parent and passed down. */
export function UvSettingsCards({
  machine,
  query,
  dirty,
}: {
  machine: UvLcdMachine;
  query: string;
  dirty: Set<string>;
}) {
  const { t } = useTranslation("settings");
  const update = useSettings((s) => s.updateMachine);
  const { toDisplay, unitLabel } = useUnitFormat();

  const title = t("equipment.cards.screen");
  const labels = [t("equipment.screenWidth"), t("equipment.screenHeight")];
  const cardVisible = matchesQuery(title, query) || labels.some((l) => matchesQuery(l, query));
  if (!cardVisible) return <div className="mx-auto max-w-[1180px]" />;
  const rowVisible = (label: string) => matchesQuery(title, query) || matchesQuery(label, query);

  return (
    <div className="mx-auto grid max-w-[1180px] grid-cols-12 gap-4">
      <div className="col-span-12 lg:col-span-5">
        <Card
          icon={Monitor}
          title={title}
          accent
          headerRight={
            <span className="rounded-md bg-muted px-2 py-1 text-[10px] tabular-nums text-muted-foreground">
              {toDisplay(machine.screenWidthMm, "coarse")} × {toDisplay(machine.screenHeightMm, "coarse")}{" "}
              {unitLabel("coarse")}
            </span>
          }
        >
          <WorkZone screenOnly x={machine.screenWidthMm} y={machine.screenHeightMm} z={0} />
          <div className="mt-3 divide-y divide-border/50">
            {rowVisible(t("equipment.screenWidth")) && (
              <Row label={t("equipment.screenWidth")}>
                <NumberInput
                  value={machine.screenWidthMm}
                  dim="coarse"
                  dirty={dirty.has("screenWidthMm")}
                  onChange={(screenWidthMm) => update(machine.id, { screenWidthMm })}
                />
              </Row>
            )}
            {rowVisible(t("equipment.screenHeight")) && (
              <Row label={t("equipment.screenHeight")}>
                <NumberInput
                  value={machine.screenHeightMm}
                  dim="coarse"
                  dirty={dirty.has("screenHeightMm")}
                  onChange={(screenHeightMm) => update(machine.id, { screenHeightMm })}
                />
              </Row>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

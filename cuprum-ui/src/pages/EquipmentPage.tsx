import { useTranslation } from "react-i18next";
import { EquipmentSection } from "@/components/settings/EquipmentSection";

/** Full-screen equipment registry: the machine library plus the selected
 *  machine's editor (master-detail). Moved out of Settings into the nav rail. */
export function EquipmentPage() {
  const { t } = useTranslation("nav");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center border-b border-border px-3 py-2.5">
        <h1 className="text-[12px] text-foreground">{t("equipment")}</h1>
      </div>
      <EquipmentSection />
    </div>
  );
}

import { EquipmentSection } from "@/components/settings/EquipmentSection";

/** Full-screen equipment registry: the machine library plus the selected
 *  machine's editor (master-detail). Moved out of Settings into the nav rail.
 *  No page-level title bar — the device-list sidebar header ("Оборудование")
 *  is the section title, matching the design (a separate page title duplicated it). */
export function EquipmentPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <EquipmentSection />
    </div>
  );
}

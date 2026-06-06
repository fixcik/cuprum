import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useSettings } from "@/settingsStore";
import { MachineList } from "@/components/settings/MachineList";
import { MachineEditor } from "@/components/settings/MachineEditor";

/** Master-detail equipment settings: the machine library on the left, the
 *  selected machine's editor on the right. The library sidebar collapses to a
 *  rail of type icons; its expanded/collapsed state persists in localStorage. */
export function EquipmentSection() {
  const { t } = useTranslation("settings");
  const machines = useSettings((s) => s.machines);
  const activeCncMachineId = useSettings((s) => s.activeCncMachineId);
  const activeUvMachineId = useSettings((s) => s.activeUvMachineId);
  const setActiveCncMachineId = useSettings((s) => s.setActiveCncMachineId);
  const setActiveUvMachineId = useSettings((s) => s.setActiveUvMachineId);
  const [selectedId, setSelectedId] = useState<string | null>(
    () => activeCncMachineId ?? activeUvMachineId ?? machines[0]?.id ?? null,
  );
  // Sidebar collapse state — persisted, defaults to expanded.
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("cnc.equip") === "0",
  );
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem("cnc.equip", next ? "0" : "1");
      return next;
    });
  };

  // Selecting a machine also records it as the "last selected" per kind, so the
  // cncProfile shim and UV consumers (exposure) follow the user's latest choice.
  // Read the live store list (not the render-snapshot `machines`) so a machine
  // just added by MachineList — not yet in this render's closure — is found.
  const handleSelect = (id: string | null) => {
    setSelectedId(id);
    const machine = id
      ? useSettings.getState().machines.find((m) => m.id === id)
      : null;
    if (!machine) return;
    if (machine.kind === "cnc") setActiveCncMachineId(id);
    else setActiveUvMachineId(id);
  };

  // The selected machine, or null if its id was deleted out from under us.
  const selected = machines.find((m) => m.id === selectedId) ?? null;
  // Re-derive a valid selection when the current one disappears (e.g. deleted in
  // another window). Done during render — no effect needed since we read it below.
  const effectiveSelected = selected ?? machines[0] ?? null;

  return (
    <div className="flex min-h-0 flex-1">
      <div
        className="flex shrink-0 flex-col overflow-hidden border-r border-border bg-panel transition-[width] duration-200 ease-out"
        style={{ width: collapsed ? 60 : 224 }}
      >
        <div
          className={`flex h-10 shrink-0 items-center border-b border-border ${
            collapsed ? "justify-center px-1" : "px-3"
          }`}
        >
          {!collapsed && (
            <span className="text-[13px] font-semibold text-foreground">
              {t("equipment.title")}
            </span>
          )}
          <button
            type="button"
            onClick={toggleCollapsed}
            title={collapsed ? t("equipment.expand") : t("equipment.collapse")}
            className="ml-auto grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4" />
            ) : (
              <PanelLeftClose className="size-4" />
            )}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <MachineList
            selectedId={effectiveSelected?.id ?? null}
            onSelect={handleSelect}
            collapsed={collapsed}
          />
        </div>
      </div>
      {/* The pane only lays out flex height; scroll + padding live INSIDE each
       *  editor tab so the control tab (console/jog) can fill the height. */}
      <div className="flex min-h-0 flex-1 flex-col">
        <MachineEditor key={effectiveSelected?.id ?? "none"} machine={effectiveSelected} />
      </div>
    </div>
  );
}

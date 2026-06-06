import { useState } from "react";
import { useSettings } from "@/settingsStore";
import { MachineList } from "@/components/settings/MachineList";
import { MachineEditor } from "@/components/settings/MachineEditor";

/** Master-detail equipment settings: the machine library on the left, the
 *  selected machine's editor on the right. */
export function EquipmentSection() {
  const machines = useSettings((s) => s.machines);
  const activeCncMachineId = useSettings((s) => s.activeCncMachineId);
  const setActiveCncMachineId = useSettings((s) => s.setActiveCncMachineId);
  const setActiveUvMachineId = useSettings((s) => s.setActiveUvMachineId);
  const [selectedId, setSelectedId] = useState<string | null>(
    () => activeCncMachineId ?? machines[0]?.id ?? null,
  );

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
      <div className="w-56 shrink-0 overflow-auto border-r border-border bg-panel">
        <MachineList selectedId={effectiveSelected?.id ?? null} onSelect={handleSelect} />
      </div>
      {/* The pane only lays out flex height; scroll + padding live INSIDE each
       *  editor tab so the control tab (console/jog) can fill the height. */}
      <div className="flex min-h-0 flex-1 flex-col">
        <MachineEditor key={effectiveSelected?.id ?? "none"} machine={effectiveSelected} />
      </div>
    </div>
  );
}

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
  const handleSelect = (id: string | null) => {
    setSelectedId(id);
    const machine = id ? machines.find((m) => m.id === id) : null;
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
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <MachineEditor machine={effectiveSelected} />
      </div>
    </div>
  );
}

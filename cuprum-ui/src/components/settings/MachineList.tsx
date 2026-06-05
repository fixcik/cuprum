import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSettings } from "@/settingsStore";
import { EditableText } from "@/components/ui/EditableText";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { newCncMachine, newUvMachine, type Machine } from "@/lib/machine";

/** Left master pane of the equipment section: the machine library.
 *  Lists every machine with an "active per kind" radio, an inline-editable name,
 *  and a delete button; the bottom holds two dashed add-buttons. */
export function MachineList({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { t } = useTranslation("settings");
  const machines = useSettings((s) => s.machines);
  const activeCncMachineId = useSettings((s) => s.activeCncMachineId);
  const activeUvMachineId = useSettings((s) => s.activeUvMachineId);
  const addMachine = useSettings((s) => s.addMachine);
  const removeMachine = useSettings((s) => s.removeMachine);
  const updateMachine = useSettings((s) => s.updateMachine);
  const setActiveCncMachineId = useSettings((s) => s.setActiveCncMachineId);
  const setActiveUvMachineId = useSettings((s) => s.setActiveUvMachineId);

  // The machine queued for deletion (drives the confirm dialog).
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const isActive = (m: Machine) =>
    (m.kind === "cnc" ? activeCncMachineId : activeUvMachineId) === m.id;
  const setActive = (m: Machine) =>
    m.kind === "cnc" ? setActiveCncMachineId(m.id) : setActiveUvMachineId(m.id);

  const confirmDelete = () => {
    if (!deleteId) return;
    removeMachine(deleteId);
    if (selectedId === deleteId) {
      const next = machines.find((m) => m.id !== deleteId);
      onSelect(next?.id ?? null);
    }
    setDeleteId(null);
  };

  const addCnc = () => {
    const mc = newCncMachine(machines);
    addMachine(mc);
    onSelect(mc.id);
    if (activeCncMachineId == null) setActiveCncMachineId(mc.id);
  };
  const addUv = () => {
    const mc = newUvMachine(machines);
    addMachine(mc);
    onSelect(mc.id);
    if (activeUvMachineId == null) setActiveUvMachineId(mc.id);
  };

  return (
    <div className="flex flex-col gap-1 p-2">
      {machines.map((m) => (
        <div
          key={m.id}
          role="button"
          tabIndex={0}
          onClick={() => onSelect(m.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSelect(m.id);
            }
          }}
          className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
            selectedId === m.id ? "bg-primary/15" : "hover:bg-foreground/5"
          }`}
        >
          <input
            type="radio"
            checked={isActive(m)}
            onChange={() => setActive(m)}
            onClick={(e) => e.stopPropagation()}
            aria-label={t("equipment.active")}
            className="shrink-0"
          />
          <span className="shrink-0 rounded bg-foreground/10 px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
            {t(`equipment.type.${m.kind}`)}
          </span>
          <EditableText
            value={m.name}
            onCommit={(name) => updateMachine(m.id, { name })}
            ariaLabel={m.name}
            className="min-w-0 flex-1 text-[12px] text-foreground"
          />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setDeleteId(m.id);
            }}
            aria-label={t("equipment.delete")}
            className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      ))}

      <button
        type="button"
        onClick={addCnc}
        className="mt-1 flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-2 text-[12px] text-muted-foreground hover:text-foreground"
      >
        <Plus className="size-4" /> {t("equipment.addCnc")}
      </button>
      <button
        type="button"
        onClick={addUv}
        className="flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-2 text-[12px] text-muted-foreground hover:text-foreground"
      >
        <Plus className="size-4" /> {t("equipment.addUv")}
      </button>

      <ConfirmDialog
        open={deleteId !== null}
        onClose={() => setDeleteId(null)}
        onConfirm={confirmDelete}
        title={t("equipment.confirmDelete.title")}
        message={t("equipment.confirmDelete.message")}
        confirmLabel={t("equipment.delete")}
        cancelLabel={t("equipment.cancel")}
      />
    </div>
  );
}

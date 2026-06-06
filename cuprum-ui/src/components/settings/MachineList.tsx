import { useState } from "react";
import { Cpu, Plus, Printer, Trash2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSettings } from "@/settingsStore";
import { EditableText } from "@/components/ui/EditableText";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { newCncMachine, newUvMachine } from "@/lib/machine";
import type { Machine } from "@/lib/machine";

/** Icon per machine kind, shared by the expanded badges and the collapsed rail. */
const KIND_ICON: Record<Machine["kind"], LucideIcon> = { cnc: Cpu, uvlcd: Printer };

/** Left master pane of the equipment section: the machine library.
 *  Expanded — each machine is a row with a type badge, an inline-editable name,
 *  and a delete button, plus two dashed add-buttons. Collapsed — a centred rail
 *  of type icons (rename/delete are expanded-only) with a single dashed add. */
export function MachineList({
  selectedId,
  onSelect,
  collapsed = false,
}: {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  collapsed?: boolean;
}) {
  const { t } = useTranslation("settings");
  const machines = useSettings((s) => s.machines);
  const addMachine = useSettings((s) => s.addMachine);
  const removeMachine = useSettings((s) => s.removeMachine);
  const updateMachine = useSettings((s) => s.updateMachine);

  // The machine queued for deletion (drives the confirm dialog).
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const confirmDelete = () => {
    if (!deleteId) return;
    // Pick the next selection from the post-deletion list: prefer the machine
    // that was after the deleted one (same index), else the previous, else none.
    if (selectedId === deleteId) {
      const idx = machines.findIndex((m) => m.id === deleteId);
      const remaining = machines.filter((m) => m.id !== deleteId);
      const next = remaining[idx] ?? remaining[idx - 1] ?? null;
      onSelect(next?.id ?? null);
    }
    removeMachine(deleteId);
    setDeleteId(null);
  };

  const addCnc = () => {
    const mc = newCncMachine(machines);
    addMachine(mc);
    onSelect(mc.id);
  };
  const addUv = () => {
    const mc = newUvMachine(machines);
    addMachine(mc);
    onSelect(mc.id);
  };

  const deleteDialog = (
    <ConfirmDialog
      open={deleteId !== null}
      onClose={() => setDeleteId(null)}
      onConfirm={confirmDelete}
      title={t("equipment.confirmDelete.title")}
      message={t("equipment.confirmDelete.message")}
      confirmLabel={t("equipment.delete")}
      cancelLabel={t("equipment.cancel")}
    />
  );

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1.5 p-2">
        {machines.map((m) => {
          const Icon = KIND_ICON[m.kind];
          const active = selectedId === m.id;
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => onSelect(m.id)}
              title={`${t(`equipment.type.${m.kind}`)} · ${m.name}`}
              className={`grid size-11 place-items-center rounded-md border transition-colors ${
                active
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-transparent text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
              }`}
            >
              <Icon className="size-5" />
            </button>
          );
        })}
        <div className="my-1 h-px w-7 bg-border" />
        <button
          type="button"
          onClick={addCnc}
          title={t("equipment.addCnc")}
          className="grid size-11 place-items-center rounded-md border border-dashed border-border text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
        >
          <Plus className="size-5" />
        </button>
        {deleteDialog}
      </div>
    );
  }

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

      {deleteDialog}
    </div>
  );
}

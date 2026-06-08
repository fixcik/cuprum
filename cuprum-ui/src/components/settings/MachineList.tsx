import { useState } from "react";
import { Cpu, Plus, Printer, Trash2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSettings } from "@/settingsStore";
import { EditableText } from "@/components/ui/EditableText";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { Machine } from "@/lib/machine";

/** Icon per machine kind, shared by the expanded badges and the collapsed rail. */
const KIND_ICON: Record<Machine["kind"], LucideIcon> = { cnc: Cpu, uvlcd: Printer };

/** Left master pane of the equipment section: the machine library.
 *  Expanded — each machine is a row with a type badge, an inline-editable name,
 *  and a delete button, plus one dashed add-button. Collapsed — a centred rail
 *  of type icons (rename/delete are expanded-only) with a single dashed add.
 *  The add affordance routes to the add-device screen via `onAdd`. */
export function MachineList({
  selectedId,
  onSelect,
  onAdd,
  collapsed = false,
}: {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onAdd: () => void;
  collapsed?: boolean;
}) {
  const { t } = useTranslation("settings");
  const machines = useSettings((s) => s.machines);
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
              className={`grid size-11 place-items-center rounded-md border border-transparent transition-colors ${
                active
                  ? "bg-primary/20 text-primary"
                  : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
              }`}
            >
              <Icon className="size-5" />
            </button>
          );
        })}
        <div className="my-1 h-px w-7 bg-border" />
        <button
          type="button"
          onClick={onAdd}
          title={t("equipment.addDevice")}
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
      {machines.map((m) => {
        const active = selectedId === m.id;
        return (
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
            className={`group flex items-center gap-2 rounded-lg border px-2.5 py-2.5 text-left transition-colors ${
              active ? "border-primary/40 bg-primary/10" : "border-transparent hover:bg-foreground/5"
            }`}
          >
            <span
              className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${
                active ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
              }`}
            >
              {t(`equipment.type.${m.kind}`)}
            </span>
            <EditableText
              value={m.name}
              onCommit={(name) => updateMachine(m.id, { name })}
              ariaLabel={m.name}
              className="min-w-0 flex-1 text-[13px] font-medium text-foreground"
            />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setDeleteId(m.id);
              }}
              aria-label={t("equipment.delete")}
              className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground/0 transition-colors group-hover:text-muted-foreground focus-visible:text-muted-foreground hover:text-red-400!"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        );
      })}

      <button
        type="button"
        onClick={onAdd}
        className="mt-1 flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-2 text-[12px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
      >
        <Plus className="size-4" /> {t("equipment.addDevice")}
      </button>

      {deleteDialog}
    </div>
  );
}

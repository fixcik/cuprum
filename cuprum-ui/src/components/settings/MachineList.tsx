import { Cpu, Plus, Printer } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSettings } from "@/settingsStore";
import type { Machine } from "@/lib/machine";

/** Icon per machine kind, shared by the expanded badges and the collapsed rail. */
const KIND_ICON: Record<Machine["kind"], LucideIcon> = { cnc: Cpu, uvlcd: Printer };

/** Left master pane of the equipment section: the machine library. Rows are
 *  select-only — renaming and deleting moved to the always-visible editor (so
 *  they're reachable even when the rail is collapsed). Expanded — a type badge +
 *  name per row, plus one dashed add-button. Collapsed — a centred rail of type
 *  icons + a dashed add. The add affordance routes to the add-device screen. */
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
              className={`grid size-9 place-items-center rounded-lg transition-colors ${
                active
                  ? "bg-primary/20 text-primary"
                  : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
              }`}
            >
              <Icon className="size-5" />
            </button>
          );
        })}
        <button
          type="button"
          onClick={onAdd}
          title={t("equipment.addDevice")}
          className="grid size-9 place-items-center rounded-lg border border-dashed border-border text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
        >
          <Plus className="size-5" />
        </button>
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
            className={`flex items-center gap-2 rounded-lg border px-2.5 py-2.5 text-left transition-colors ${
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
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{m.name}</span>
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
    </div>
  );
}

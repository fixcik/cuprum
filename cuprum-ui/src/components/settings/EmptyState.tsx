import { useTranslation } from "react-i18next";
import { Boxes, Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";

/** Empty state shown when no machines exist: a dashed icon plate, a short pitch,
 *  and a single primary "add equipment" button that routes to the add screen. */
export function EmptyState({ onAdd }: { onAdd: () => void }) {
  const { t } = useTranslation("settings");
  return (
    <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-8">
      <div className="flex max-w-[420px] flex-col items-center text-center">
        <div className="relative grid size-24 place-items-center rounded-2xl border border-dashed border-border bg-card/40">
          <Boxes className="size-10 text-muted-foreground" />
          <span className="absolute -bottom-1.5 -right-1.5 grid size-7 place-items-center rounded-full bg-primary text-primary-foreground">
            <Plus className="size-4" />
          </span>
        </div>
        <h2 className="mt-6 text-[18px] font-semibold text-foreground">
          {t("equipment.empty.title")}
        </h2>
        <p className="mt-2 text-[13px] leading-snug text-muted-foreground">
          {t("equipment.empty.desc")}
        </p>
        <Button onClick={onAdd} className="mt-6">
          <Plus className="size-4" /> {t("equipment.empty.add")}
        </Button>
      </div>
    </div>
  );
}

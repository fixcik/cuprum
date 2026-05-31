import { useState } from "react";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { DesignCard } from "./DesignCard";
import { DesignInspector } from "./DesignInspector";
import { useShell } from "@/shellStore";

export function DesignsGallery() {
  const { t } = useTranslation("project");
  const manifest = useShell((s) => s.currentManifest);
  const addDesignsFromZips = useShell((s) => s.addDesignsFromZips);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (!manifest) return null;
  const selected =
    selectedId && manifest.designs.some((d) => d.id === selectedId) ? selectedId : null;

  if (selected) return <DesignInspector designId={selected} onBack={() => setSelectedId(null)} />;

  return (
    <div className="h-full overflow-auto p-4">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
        {manifest.designs.map((d) => (
          <DesignCard key={d.id} design={d} onOpen={() => setSelectedId(d.id)} />
        ))}
        <button
          type="button"
          onClick={addDesignsFromZips}
          className="flex aspect-[4/3] flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
        >
          <Plus className="size-6" />
          <span className="text-[12px] font-medium">{t("designs.addDesign")}</span>
        </button>
      </div>
      {manifest.designs.length === 0 && (
        <p className="mt-4 text-center text-[12px] text-muted-foreground">{t("designs.emptyDesc")}</p>
      )}
    </div>
  );
}

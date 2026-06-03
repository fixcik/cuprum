import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { DesignCard } from "./DesignCard";
import { DashedAddTile } from "@/components/ui/DashedAddTile";
import { useShell } from "@/shellStore";
import { api } from "@/lib/api";

export function DesignsGallery() {
  const { t } = useTranslation("project");
  const manifest = useShell((s) => s.currentManifest);
  const addDesignsFromZips = useShell((s) => s.addDesignsFromZips);
  const addDesignsFromPaths = useShell((s) => s.addDesignsFromPaths);
  const removeDesign = useShell((s) => s.removeDesign);
  const [dragOver, setDragOver] = useState(false);

  // OS drag-and-drop: drop .zip fab packages straight onto the gallery. The
  // webview event is window-global, but DesignsGallery is only mounted while the
  // Designs tab is active, so the drop target is effectively this view.
  useEffect(() => {
    const pending = getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === "enter" || e.payload.type === "over") {
        setDragOver(true);
      } else if (e.payload.type === "leave") {
        setDragOver(false);
      } else if (e.payload.type === "drop") {
        setDragOver(false);
        const zips = e.payload.paths.filter((p) => p.toLowerCase().endsWith(".zip"));
        if (zips.length > 0) void addDesignsFromPaths(zips);
      }
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, [addDesignsFromPaths]);

  if (!manifest) return null;

  return (
    <div className="relative h-full overflow-auto p-4">
      {dragOver && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/10 text-[13px] font-medium text-primary">
          {t("designs.dropHint")}
        </div>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
        {manifest.designs.map((d) => (
          <DesignCard
            key={d.id}
            design={d}
            onOpen={() => void api.openInspectorWindow(d.id)}
            onDelete={() => removeDesign(d.id)}
          />
        ))}
        {/* No fixed aspect: the grid row stretches this tile to match a real card
            (thumbnail + footer); min-h keeps it sensible when it's the only tile. */}
        <DashedAddTile
          onClick={addDesignsFromZips}
          icon={<Plus className="size-6" />}
          title={t("designs.addDesign")}
          subtitle={t("designs.dropHintShort")}
          className="min-h-[200px]"
        />
      </div>
      {manifest.designs.length === 0 && (
        <p className="mt-4 text-center text-[12px] text-muted-foreground">{t("designs.emptyDesc")}</p>
      )}
    </div>
  );
}

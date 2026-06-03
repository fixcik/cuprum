import { useState } from "react";
import { Settings, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PcbPreviewPlaceholder } from "@/components/home/PcbPreviewPlaceholder";
import { RecentSettingsModal } from "@/components/home/RecentSettingsModal";
import { type RecentProject } from "@/lib/api";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { cn } from "@/lib/utils";
import { useShell } from "@/shellStore";

type RecentTileLayout = "grid" | "list";

function PreviewThumb({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border border-border bg-pcb-preview transition group-hover:border-primary group-hover:ring-1 group-hover:ring-primary/30",
        className,
      )}
    >
      <PcbPreviewPlaceholder />
    </div>
  );
}

export function RecentTile({
  project,
  layout,
}: {
  project: RecentProject;
  layout: RecentTileLayout;
}) {
  const { t, i18n } = useTranslation("home");
  const openByPath = useShell((s) => s.openProjectByPath);
  const removeRecent = useShell((s) => s.removeRecent);
  const [editing, setEditing] = useState(false);
  const when = formatRelativeTime(project.last_opened_at, i18n.language);

  if (!project.exists) {
    if (layout === "list") {
      return (
        <div className="flex items-center gap-3 rounded-md bg-panel/50 px-2 py-1.5 opacity-50">
          <PreviewThumb className="aspect-[4/3] w-12 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-semibold text-foreground">{project.name}</div>
            <button
              type="button"
              onClick={() => removeRecent(project.path)}
              className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
              {t("fileNotFound")}
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="opacity-40">
        <PreviewThumb className="aspect-[4/3] w-full" />
        <div className="mt-1.5 truncate text-[12px] font-semibold text-foreground">{project.name}</div>
        <button
          type="button"
          onClick={() => removeRecent(project.path)}
          className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
        >
          <X className="size-3" />
          {t("fileNotFound")}
        </button>
      </div>
    );
  }

  // Overlay actions (edit + remove): siblings of the open-button, not nested — a
  // button inside a button is invalid HTML. Edit opens a name/description dialog;
  // remove drops the project from the recents catalog only (the .cuprum file on
  // disk is left untouched).
  const actions = (
    <div className="flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={t("editRecent")}
        title={t("editRecent")}
        className="cursor-pointer rounded-md bg-card/90 p-1 text-muted-foreground shadow-sm transition-colors hover:text-foreground"
      >
        <Settings className="size-4" />
      </button>
      <button
        type="button"
        onClick={() => removeRecent(project.path)}
        aria-label={t("removeRecent")}
        title={t("removeRecent")}
        className="cursor-pointer rounded-md bg-card/90 p-1 text-muted-foreground shadow-sm transition-colors hover:text-destructive"
      >
        <Trash2 className="size-4" />
      </button>
    </div>
  );

  if (layout === "list") {
    return (
      <div className="group relative">
        <button
          type="button"
          onClick={() => openByPath(project.path)}
          className="flex w-full items-center gap-3 rounded-md bg-panel px-2 py-1.5 text-left transition hover:bg-muted"
          title={project.path}
        >
          <PreviewThumb className="aspect-[4/3] w-12 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-semibold text-foreground">{project.name}</div>
            <div className="truncate text-[10px] text-muted-foreground">{project.path}</div>
          </div>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{when}</span>
        </button>
        <div className="absolute right-2 top-1/2 -translate-y-1/2">{actions}</div>
        <RecentSettingsModal open={editing} onClose={() => setEditing(false)} project={project} />
      </div>
    );
  }

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => openByPath(project.path)}
        className="w-full text-left"
        title={project.path}
      >
        <PreviewThumb className="aspect-[4/3] w-full" />
        <div className="mt-1.5 truncate text-[12px] font-semibold text-foreground">{project.name}</div>
        <div className="text-[10px] tabular-nums text-muted-foreground">{when}</div>
      </button>
      <div className="absolute left-2 top-2">{actions}</div>
      <RecentSettingsModal open={editing} onClose={() => setEditing(false)} project={project} />
    </div>
  );
}

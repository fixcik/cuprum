import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PcbPreviewPlaceholder } from "@/components/home/PcbPreviewPlaceholder";
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
  const { t } = useTranslation("home");
  const openByPath = useShell((s) => s.openProjectByPath);
  const removeRecent = useShell((s) => s.removeRecent);
  const when = formatRelativeTime(project.last_opened_at);

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

  if (layout === "list") {
    return (
      <button
        type="button"
        onClick={() => openByPath(project.path)}
        className="group flex w-full items-center gap-3 rounded-md bg-panel px-2 py-1.5 text-left transition hover:bg-muted"
        title={project.path}
      >
        <PreviewThumb className="aspect-[4/3] w-12 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-semibold text-foreground">{project.name}</div>
          <div className="truncate text-[10px] text-muted-foreground">{project.path}</div>
        </div>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{when}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => openByPath(project.path)}
      className="group w-full text-left"
      title={project.path}
    >
      <PreviewThumb className="aspect-[4/3] w-full" />
      <div className="mt-1.5 truncate text-[12px] font-semibold text-foreground">{project.name}</div>
      <div className="text-[10px] tabular-nums text-muted-foreground">{when}</div>
    </button>
  );
}

import { useState } from "react";
import { Settings, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ProjectThumb } from "@/components/home/ProjectThumb";
import { RecentSettingsModal } from "@/components/home/RecentSettingsModal";
import { type RecentProject } from "@/lib/api";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { useUnitFormat } from "@/i18n/useUnitFormat";
import { useShell } from "@/shellStore";

type RecentTileLayout = "grid" | "list";

export function RecentTile({
  project,
  layout,
}: {
  project: RecentProject;
  layout: RecentTileLayout;
}) {
  const { t, i18n } = useTranslation("home");
  const { fmtLen } = useUnitFormat();
  const openByPath = useShell((s) => s.openProjectByPath);
  const removeRecent = useShell((s) => s.removeRecent);
  const [editing, setEditing] = useState(false);
  const when = formatRelativeTime(project.last_opened_at, i18n.language);

  // Context line: "N designs · W × H". Dimensions only once the panel blank is
  // configured (until then width/height are null). Verdict is a panel property,
  // computed elsewhere later — fixed to "ok" (green) for now.
  const designs = t("designsCount", { count: project.design_count });
  const dims =
    project.width_mm != null && project.height_mm != null
      ? `${fmtLen(project.width_mm)} × ${fmtLen(project.height_mm)}`
      : null;
  const meta = dims ? `${designs} · ${dims}` : designs;

  if (!project.exists) {
    if (layout === "list") {
      return (
        <div className="anim-in flex items-center gap-3 rounded-lg bg-panel/50 px-2.5 py-2 opacity-50">
          <ProjectThumb
            name={project.name}
            verdict="none"
            variant="list"
            className="aspect-[4/3] w-16 shrink-0 rounded-md"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-foreground">{project.name}</div>
            <button
              type="button"
              onClick={() => removeRecent(project.path)}
              className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
              {t("fileNotFound")}
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="anim-in opacity-40">
        <div className="overflow-hidden rounded-xl border border-border">
          <ProjectThumb name={project.name} verdict="none" className="aspect-[4/3]" />
        </div>
        <div className="mt-1.5 truncate text-[13px] font-semibold text-foreground">
          {project.name}
        </div>
        <button
          type="button"
          onClick={() => removeRecent(project.path)}
          className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
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
  // Both actions sit on ONE opaque pill so the busy preview/row behind never
  // shows through the gap between the icons.
  const actions = (
    <div className="flex gap-0.5 rounded-md bg-card/95 p-0.5 opacity-0 shadow-sm transition-opacity focus-within:opacity-100 group-hover:opacity-100">
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={t("editRecent")}
        title={t("editRecent")}
        className="grid size-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
      >
        <Settings className="size-4" />
      </button>
      <button
        type="button"
        onClick={() => removeRecent(project.path)}
        aria-label={t("removeRecent")}
        title={t("removeRecent")}
        className="grid size-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted/60 hover:text-destructive"
      >
        <Trash2 className="size-4" />
      </button>
    </div>
  );

  if (layout === "list") {
    return (
      <div className="group relative anim-in">
        <button
          type="button"
          onClick={() => openByPath(project.path)}
          className="flex w-full items-center gap-3 rounded-lg border border-border bg-card px-2.5 py-2 text-left transition-colors hover:border-primary/50"
          title={project.path}
        >
          <ProjectThumb
            name={project.name}
            variant="list"
            className="aspect-[4/3] w-16 shrink-0 rounded-md"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-foreground">{project.name}</div>
            <div className="truncate text-[11px] tabular-nums text-muted-foreground">{meta}</div>
          </div>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{when}</span>
        </button>
        <div className="absolute right-2 top-1/2 -translate-y-1/2">{actions}</div>
        <RecentSettingsModal open={editing} onClose={() => setEditing(false)} project={project} />
      </div>
    );
  }

  return (
    <div className="group relative anim-in">
      <button
        type="button"
        onClick={() => openByPath(project.path)}
        className="flex w-full flex-col overflow-hidden rounded-xl border border-border bg-card text-left transition-colors hover:border-primary/50"
        title={project.path}
      >
        <ProjectThumb name={project.name} className="aspect-[4/3]" />
        <div className="flex flex-col gap-0.5 p-3">
          <div className="truncate text-[13px] font-semibold text-foreground">{project.name}</div>
          <div className="truncate text-[11px] tabular-nums text-muted-foreground">{meta}</div>
          <div className="text-[11px] tabular-nums text-muted-foreground/70">{when}</div>
        </div>
      </button>
      <div className="absolute right-2 top-2">{actions}</div>
      <RecentSettingsModal open={editing} onClose={() => setEditing(false)} project={project} />
    </div>
  );
}

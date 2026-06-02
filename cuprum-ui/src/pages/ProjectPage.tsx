import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LayoutGrid, Layers, ListChecks, Settings, Undo2, Redo2, Save, History, type LucideIcon } from "lucide-react";
import { DesignsGallery } from "@/components/project/DesignsGallery";
import { PanelEditor } from "@/components/project/PanelEditor";
import { ProjectSettingsModal } from "@/components/project/ProjectSettingsModal";
import { useShell } from "@/shellStore";
import { relativeTime } from "@/i18n/relativeTime";
import { overallProgress } from "@/lib/artifactProgress";
import { ProgressRing } from "@/components/ui/ProgressRing";

type ProjectTab = "panel" | "designs" | "operations";

export function ProjectPage() {
  const { t, i18n } = useTranslation("project");
  const manifest = useShell((s) => s.currentManifest);
  const [tab, setTab] = useState<ProjectTab>("panel");
  const [settingsOpen, setSettingsOpen] = useState(false);

  const workingDir = useShell((s) => s.workingDir);
  const undo = useShell((s) => s.undo);
  const redo = useShell((s) => s.redo);
  const canUndo = useShell((s) => s.undoStack.length > 0);
  const canRedo = useShell((s) => s.redoStack.length > 0);
  const makeRestorePoint = useShell((s) => s.makeRestorePoint);
  const restorePoints = useShell((s) => s.restorePoints);
  const restoreTo = useShell((s) => s.restoreTo);
  const historyBusy = useShell((s) => s.historyBusy);
  const [pointsOpen, setPointsOpen] = useState(false);

  const artifactProgress = useShell((s) => s.artifactProgress);
  const pruneArtifactProgress = useShell((s) => s.pruneArtifactProgress);
  const prep = overallProgress(artifactProgress);

  const designIds = useMemo(
    () => manifest?.designs.map((d) => d.id) ?? [],
    [manifest?.designs],
  );
  useEffect(() => {
    pruneArtifactProgress(designIds);
  }, [designIds, pruneArtifactProgress]);

  // Keyboard shortcuts: ⌘/Ctrl+Z = undo, ⌘/Ctrl+Shift+Z = redo, ⌘/Ctrl+S = save point.
  useEffect(() => {
    if (!workingDir) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)))
        return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (k === "s") {
        e.preventDefault();
        makeRestorePoint();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [workingDir, undo, redo, makeRestorePoint]);

  if (!manifest) {
    return <div className="flex-1 p-6 text-[13px] text-muted-foreground">{t("noProject")}</div>;
  }

  const TABS: { id: ProjectTab; label: string; Icon: LucideIcon }[] = [
    { id: "panel", label: t("tab.panel"), Icon: LayoutGrid },
    { id: "designs", label: t("tab.designs"), Icon: Layers },
    { id: "operations", label: t("tab.operations"), Icon: ListChecks },
  ];

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Bambu-style tab bar */}
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        {TABS.map(({ id, label, Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={[
                "flex items-center gap-2 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors",
                active ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground",
              ].join(" ")}
            >
              <Icon className="size-4" /> {label}
            </button>
          );
        })}
        {prep.total > 0 && prep.fraction < 1 && (
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <ProgressRing value={prep.fraction} className="size-4" />
            {t("designs.preparingArtifacts", { done: prep.done, total: prep.total })}
          </div>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => undo()}
            disabled={!canUndo || historyBusy}
            aria-label={t("history.undo")}
            title={t("history.undo")}
            className="rounded-lg p-2 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
          >
            <Undo2 className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => redo()}
            disabled={!canRedo || historyBusy}
            aria-label={t("history.redo")}
            title={t("history.redo")}
            className="rounded-lg p-2 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
          >
            <Redo2 className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => makeRestorePoint()}
            disabled={historyBusy}
            aria-label={t("history.savePoint")}
            title={t("history.savePoint")}
            className="rounded-lg p-2 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
          >
            <Save className="size-4" />
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setPointsOpen((v) => !v)}
              aria-label={t("aria.restorePoints")}
              title={t("history.points")}
              className="rounded-lg p-2 text-muted-foreground transition-colors hover:text-foreground"
            >
              <History className="size-4" />
            </button>
            {pointsOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setPointsOpen(false)} aria-hidden />
                <div className="absolute right-0 z-20 mt-1 max-h-80 w-64 overflow-auto rounded-lg border border-border bg-card p-1 shadow-lg">
                  {restorePoints.length === 0 ? (
                    <div className="px-3 py-2 text-[12px] text-muted-foreground">{t("history.noPoints")}</div>
                  ) : (
                    restorePoints.map((p) => {
                      const rel = relativeTime(p.createdAt);
                      const when = t(rel.key, rel.params);
                      // Absolute time as a hover tooltip for precision — in the
                      // app's locale (i18n), not the browser's.
                      const abs = new Date(p.createdAt * 1000).toLocaleString(i18n.language);
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => {
                            setPointsOpen(false);
                            restoreTo(p.id);
                          }}
                          title={abs}
                          className="block w-full rounded-md px-3 py-1.5 text-left text-[12px] text-foreground transition-colors hover:bg-primary/10"
                        >
                          {when}
                        </button>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label={t("aria.settings")}
            title={t("aria.settings")}
            className="rounded-lg p-2 text-muted-foreground transition-colors hover:text-foreground"
          >
            <Settings className="size-4" />
          </button>
        </div>
      </div>

      {/* Tab content */}
      <div className="min-h-0 flex-1">
        {tab === "panel" && <PanelEditor />}
        {tab === "designs" && <DesignsGallery />}
        {tab === "operations" && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <div className="text-[15px] font-semibold text-foreground">{t("operations.placeholder.title")}</div>
            <p className="max-w-sm text-[12px] leading-relaxed text-muted-foreground">
              {t("operations.placeholder.desc")}
            </p>
          </div>
        )}
      </div>

      <ProjectSettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

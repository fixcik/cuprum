import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LayoutGrid, Layers, ListChecks, Settings, type LucideIcon } from "lucide-react";
import { DesignsTab } from "@/components/project/DesignsTab";
import { PanelEditor } from "@/components/project/PanelEditor";
import { ProjectSettingsModal } from "@/components/project/ProjectSettingsModal";
import { useShell } from "@/shellStore";

type ProjectTab = "panel" | "designs" | "operations";

export function ProjectPage() {
  const { t } = useTranslation("project");
  const manifest = useShell((s) => s.currentManifest);
  const [tab, setTab] = useState<ProjectTab>("panel");
  const [settingsOpen, setSettingsOpen] = useState(false);

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
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          aria-label={t("aria.settings")}
          title={t("aria.settings")}
          className="ml-auto rounded-lg p-2 text-muted-foreground transition-colors hover:text-foreground"
        >
          <Settings className="size-4" />
        </button>
      </div>

      {/* Tab content */}
      <div className="min-h-0 flex-1">
        {tab === "panel" && <PanelEditor />}
        {tab === "designs" && <DesignsTab />}
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

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { InlineEditableField } from "@/components/ui/InlineEditableField";
import { DesignsTab } from "@/components/project/DesignsTab";
import { PanelTab } from "@/components/project/PanelTab";
import { useShell } from "@/shellStore";

type ProjectTab = "panel" | "designs" | "operations";

export function ProjectPage() {
  const { t } = useTranslation("project");
  const manifest = useShell((s) => s.currentManifest);
  const updateProjectMetadata = useShell((s) => s.updateProjectMetadata);
  const error = useShell((s) => s.error);
  const [tab, setTab] = useState<ProjectTab>("panel");

  if (!manifest) {
    return <div className="flex-1 p-6 text-[13px] text-muted-foreground">{t("noProject")}</div>;
  }

  const configured = manifest.stackup != null;
  const activeTab: ProjectTab = configured ? tab : "panel";

  const saveName = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === manifest.name) return;
    updateProjectMetadata(trimmed, manifest.description);
  };
  const saveDescription = (description: string) => {
    const trimmed = description.trim();
    if (trimmed === manifest.description) return;
    updateProjectMetadata(manifest.name, trimmed);
  };

  const TABS: { id: ProjectTab; label: string }[] = [
    { id: "panel", label: t("tab.panel") },
    { id: "designs", label: t("tab.designs") },
    { id: "operations", label: t("tab.operations") },
  ];

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Compact header */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-2">
        <InlineEditableField
          value={manifest.name}
          onCommit={saveName}
          placeholder={manifest.name}
          ariaLabel={t("aria.projectName")}
          displayClassName="shrink-0 text-sm font-semibold text-foreground"
          inputClassName="text-sm font-semibold"
        />
        <span className="shrink-0 text-border">/</span>
        <InlineEditableField
          value={manifest.description}
          onCommit={saveDescription}
          placeholder={t("descriptionPlaceholder")}
          ariaLabel={t("aria.projectDescription")}
          displayClassName="min-w-0 flex-1 truncate text-[12px] text-muted-foreground"
          inputClassName="min-w-0 flex-1 text-[12px] text-muted-foreground"
        />
        {error && <span className="ml-auto shrink-0 text-[12px] text-destructive">{error}</span>}
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-border px-3">
        {TABS.map((tb) => {
          const disabled = !configured && tb.id !== "panel";
          const active = activeTab === tb.id;
          return (
            <button
              key={tb.id}
              type="button"
              disabled={disabled}
              title={disabled ? t("tabLocked") : undefined}
              onClick={() => setTab(tb.id)}
              className={[
                "border-b-2 px-3 py-2 text-[12px] transition-colors",
                active ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground",
                disabled ? "cursor-default opacity-30 hover:text-muted-foreground" : "",
              ].join(" ")}
            >
              {tb.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div className="min-h-0 flex-1">
        {activeTab === "panel" && <PanelTab />}
        {activeTab === "designs" && <DesignsTab />}
        {activeTab === "operations" && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <div className="text-[15px] font-semibold text-foreground">{t("operations.placeholder.title")}</div>
            <p className="max-w-sm text-[12px] leading-relaxed text-muted-foreground">
              {t("operations.placeholder.desc")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

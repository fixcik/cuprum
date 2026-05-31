import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Settings2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { PanelBlankPreview } from "@/components/panel/PanelBlankPreview";
import { api, type PanelDoc } from "@/lib/api";
import { useShell } from "@/shellStore";

/** Panel tab: a "configure" placeholder until the blank is set, then the blank
 *  2D preview. Board placement arrives in Phase 2. */
export function PanelTab() {
  const { t } = useTranslation("project");
  const currentPath = useShell((s) => s.currentPath);
  const configured = useShell((s) => s.currentManifest?.stackup != null);
  const setView = useShell((s) => s.setView);
  const [panel, setPanel] = useState<PanelDoc | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!currentPath || !configured) {
      setPanel(null);
      return;
    }
    api
      .readPanel(currentPath)
      .then((p) => {
        if (!cancelled) setPanel(p);
      })
      .catch(() => {
        if (!cancelled) setPanel(null);
      });
    return () => {
      cancelled = true;
    };
  }, [currentPath, configured]);

  if (!configured) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <Settings2 className="size-12 text-muted-foreground/50" />
        <div className="text-[15px] font-semibold text-foreground">{t("panel.notConfigured.title")}</div>
        <p className="max-w-sm text-[12px] leading-relaxed text-muted-foreground">{t("panel.notConfigured.desc")}</p>
        <Button onClick={() => setView("panel-setup")}>
          <Settings2 className="size-4" /> {t("panel.configure")}
        </Button>
      </div>
    );
  }

  if (!panel) {
    return <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">…</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <span className="text-[12px] text-muted-foreground">
          {t("panel.summary", { w: panel.width_mm, h: panel.height_mm })}
        </span>
        <Button variant="ghost" size="sm" onClick={() => setView("panel-setup")}>
          <Settings2 className="size-4" /> {t("panel.edit")}
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <PanelBlankPreview widthMm={panel.width_mm} heightMm={panel.height_mm} />
      </div>
    </div>
  );
}

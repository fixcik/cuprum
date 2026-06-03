import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

/** Root of the separate "Add design to panel" window (label "add-design"). */
export function AddDesignWindow() {
  const { t } = useTranslation("project");

  // Localise the OS window title on mount (Rust sets a neutral placeholder).
  useEffect(() => {
    getCurrentWindow().setTitle(t("panel.add.window.title")).catch(() => {});
  }, [t]);

  return (
    <div className="flex h-screen w-screen flex-col bg-card text-foreground">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="text-[13px] font-semibold">{t("panel.add.window.title")}</div>
        <button
          type="button"
          onClick={() => void getCurrentWindow().close()}
          aria-label={t("panel.add.close")}
          className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="flex-1" />
    </div>
  );
}

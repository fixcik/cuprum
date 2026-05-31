import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { NavRail } from "@/components/nav/NavRail";
import { HomePage } from "@/pages/HomePage";
import { ProjectPage } from "@/pages/ProjectPage";
import { PrinterPage } from "@/pages/PrinterPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { ImportWizardPage } from "@/pages/ImportWizardPage";
import { useShell } from "@/shellStore";

export default function App() {
  const view = useShell((s) => s.view);
  const manifestName = useShell((s) => s.currentManifest?.name ?? null);
  const loadDisplayScale = useShell((s) => s.loadDisplayScale);

  useEffect(() => {
    loadDisplayScale();
  }, [loadDisplayScale]);

  // Reflect the open project in the OS window title; reset to the app name
  // elsewhere. Wrapped so a non-Tauri (web) context is a no-op.
  useEffect(() => {
    const title = view === "project" && manifestName ? `Cuprum CAM: ${manifestName}` : "Cuprum CAM";
    getCurrentWindow()
      .setTitle(title)
      .catch(() => {});
  }, [view, manifestName]);

  return (
    <div className="flex h-screen w-screen">
      <NavRail />
      <div className="flex min-w-0 flex-1 flex-col">
        {view === "home" && <HomePage />}
        {view === "project" && <ProjectPage />}
        {view === "printer" && <PrinterPage />}
        {view === "settings" && <SettingsPage />}
        {view === "import" && <ImportWizardPage />}
      </div>
    </div>
  );
}

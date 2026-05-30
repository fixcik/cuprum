import { useEffect } from "react";
import { NavRail } from "@/components/nav/NavRail";
import { HomePage } from "@/pages/HomePage";
import { ProjectPage } from "@/pages/ProjectPage";
import { PrinterPage } from "@/pages/PrinterPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { ImportWizardPage } from "@/pages/ImportWizardPage";
import { useShell } from "@/shellStore";

export default function App() {
  const view = useShell((s) => s.view);
  const loadDisplayScale = useShell((s) => s.loadDisplayScale);

  useEffect(() => {
    loadDisplayScale();
  }, [loadDisplayScale]);

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

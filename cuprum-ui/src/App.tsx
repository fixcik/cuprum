import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { NavRail } from "@/components/nav/NavRail";
import { HomePage } from "@/pages/HomePage";
import { ProjectPage } from "@/pages/ProjectPage";
import { PrinterPage } from "@/pages/PrinterPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { api } from "@/lib/api";
import { useShell } from "@/shellStore";
import { useAddDesignBridge } from "@/hooks/useAddDesignBridge";
import { useUpdater } from "@/updaterStore";
import { UpdateBanner } from "@/components/UpdateBanner";

export default function App() {
  const view = useShell((s) => s.view);
  const manifestName = useShell((s) => s.currentManifest?.name ?? null);
  const loadDisplayScale = useShell((s) => s.loadDisplayScale);

  useAddDesignBridge();

  useEffect(() => {
    loadDisplayScale();
  }, [loadDisplayScale]);

  // Silent check for an app update on startup; a missing release manifest or an
  // offline machine stays quiet (the banner only shows when one is actually found).
  useEffect(() => {
    void useUpdater.getState().checkForUpdates(false);
  }, []);

  // Native menu "Check for Updates…" → loud check (shows "up to date"/error toast).
  useEffect(() => {
    const un = api.onMenuCheckUpdates(() => void useUpdater.getState().checkForUpdates(true));
    return () => {
      void un.then((unlisten) => unlisten());
    };
  }, []);

  // Surface working dirs left dirty by a prior crash. Phase 2 wires a proper
  // adopt/discard dialog; for now just make them visible in the console.
  useEffect(() => {
    api
      .scanRecoverable()
      .then((orphans) => {
        if (orphans.length > 0) console.warn("Recoverable unsaved projects:", orphans);
      })
      .catch(() => {});
  }, []);

  // Open-by-click: consume a queued path on cold start, then stay subscribed for
  // relaunch / macOS Opened events. Both route through the shell's open flow.
  useEffect(() => {
    const openByPath = useShell.getState().openProjectByPath;
    api
      .takePendingOpen()
      .then((path) => {
        if (path) void openByPath(path);
      })
      .catch(() => {});
    const pending = api.onOpenFile((path) => void useShell.getState().openProjectByPath(path));
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, []);

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
      </div>
      <UpdateBanner />
    </div>
  );
}

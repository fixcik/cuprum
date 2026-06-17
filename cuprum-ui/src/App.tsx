import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { NavRail } from "@/components/nav/NavRail";
import { HomePage } from "@/pages/HomePage";
import { ProjectPage } from "@/pages/ProjectPage";
import { EquipmentPage } from "@/pages/EquipmentPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { api } from "@/lib/api";
import { useShell, armSessionPersist } from "@/shellStore";
import { useNavigation } from "@/navigationStore";
import { loadLastSession } from "@/lib/lastSession";
import { useAddDesignBridge } from "@/hooks/useAddDesignBridge";
import { useInspectorBridge } from "@/hooks/useInspectorBridge";
import { useDrillBridge } from "@/hooks/useDrillBridge";
import { useExposeBridge } from "@/hooks/useExposeBridge";
import { useMillBridge } from "@/hooks/useMillBridge";
import { useMachineBridge } from "@/hooks/useMachineBridge";
import { useBridgeListeners } from "@/hooks/useTauriListeners";
import { useConsoleBridge } from "@/hooks/useConsoleBridge";
import { useDrillRunLiveListeners } from "@/hooks/useDrillRunLiveListeners";
import { useUpdater } from "@/updaterStore";
import { UpdateBanner } from "@/components/UpdateBanner";
import { CrashPrompt } from "@/components/CrashPrompt";
import i18n from "@/i18n";

// Module-scoped so cold-start restore runs once even under React StrictMode's
// dev-only double-mount (a second run would double-extract a working dir).
let coldStartHandled = false;

export default function App() {
  const view = useNavigation((s) => s.view);
  const manifestName = useShell((s) => s.currentManifest?.name ?? null);
  const loadDisplayScale = useNavigation((s) => s.loadDisplayScale);

  useAddDesignBridge();
  useInspectorBridge();
  useDrillBridge();
  useExposeBridge();
  useMillBridge();
  useMachineBridge();
  useConsoleBridge();
  useDrillRunLiveListeners();

  useEffect(() => {
    loadDisplayScale();
  }, [loadDisplayScale]);

  // Silent check for an app update on startup; a missing release manifest or an
  // offline machine stays quiet (the banner only shows when one is actually found).
  useEffect(() => {
    void useUpdater.getState().checkForUpdates(false);
  }, []);

  // Native menu "Check for Updates…" → loud check (shows "up to date"/error toast).
  // StrictMode-safe listener lifecycle — see useBridgeListeners.
  useBridgeListeners(() => [
    api.onMenuCheckUpdates(() => void useUpdater.getState().checkForUpdates(true)),
  ]);

  // Keep the native menu labels in sync with the active UI language. Runs on
  // mount (initial push) and whenever i18n.changeLanguage fires.
  useEffect(() => {
    const sync = () =>
      void api.setAppMenu({
        edit: i18n.t("menu:edit"),
        window: i18n.t("menu:window"),
        checkUpdates: i18n.t("menu:checkUpdates"),
        reportIssue: i18n.t("menu:reportIssue"),
      });
    sync();
    i18n.on("languageChanged", sync);
    return () => {
      i18n.off("languageChanged", sync);
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

  // Cold start: an OS open-by-click request wins; otherwise restore the last
  // session (open project + view) so a webview reload or app restart lands the
  // user back where they left off. Then stay subscribed for relaunch / macOS
  // Opened events. Guarded so React StrictMode's double-mount (dev) doesn't run
  // the restore twice and double-extract a working dir.
  useEffect(() => {
    if (!coldStartHandled) {
      coldStartHandled = true;
      void (async () => {
        try {
          const pending = await api.takePendingOpen().catch(() => null);
          if (pending) {
            await useShell.getState().openProjectByPath(pending);
            return;
          }
          const last = loadLastSession();
          if (!last) return;
          // Reopen the project first (this forces the "project" view on success;
          // a not-found path leaves the shell on Home with a notice). Then honor a
          // non-project view the user was on — for "project" the open already set
          // it, and a failed open correctly stays Home.
          if (last.path) await useShell.getState().openProjectByPath(last.path);
          // Only honor a non-project view once the open (if any) actually
          // succeeded — currentPath is set on success, null on not-found/error.
          // Otherwise a failed open would navigate away from Home and hide its
          // error/notice (which only HomePage renders).
          const openOk = !last.path || useShell.getState().currentPath === last.path;
          if (openOk && last.view !== "project") useNavigation.getState().setView(last.view);
        } finally {
          // Arm persistence ONLY now — after restore has read localStorage — so
          // startup's own state churn (and secondary windows) can't clobber the
          // saved entry before we restore from it. See shellStore subscription.
          armSessionPersist();
        }
      })();
    }
  }, []);

  // Stay subscribed for relaunch / macOS Opened events for the window lifetime.
  // StrictMode-safe listener lifecycle — see useBridgeListeners.
  useBridgeListeners(() => [
    api.onOpenFile((path) => void useShell.getState().openProjectByPath(path)),
  ]);

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
        {view === "equipment" && <EquipmentPage />}
        {view === "settings" && <SettingsPage />}
      </div>
      <UpdateBanner />
      <CrashPrompt />
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { useConsoleFollower } from "@/hooks/useConsoleFollower";
import { useShowWindowWhenReady } from "@/hooks/useShowWindowWhenReady";
import { ConsoleBody } from "@/components/machine/ConsoleDrawer";
import { MachineToolbar } from "@/components/machine/MachineToolbar";
import {
  MachineActionsProvider,
  consoleMachineActions,
} from "@/components/machine/MachineActionsContext";

/** Root of the separate machine-console window (label "console"). Self-sufficient
 *  remote view: machine state is fed directly from the backend's global broadcasts
 *  (`machine://status`, `machine://line`, `machine://connected/disconnected`) via
 *  useConsoleFollower — no relay from the main window required. Actions go via
 *  consoleMachineActions: stateless writes hit the backend directly; connect/
 *  disconnect/home are forwarded as intents to the main window (which owns the
 *  serial Channel). The Rust Destroyed event on "console" emits console:closed
 *  so the main window can revert the in-app drawer stub. */
export function ConsoleWindow() {
  const { t } = useTranslation("machine");
  // Stable provider value (factory captures only static api references).
  const actions = useMemo(() => consoleMachineActions(), []);
  const [seeded, setSeeded] = useState(false);
  useShowWindowWhenReady(seeded);
  const markSeeded = useCallback(() => setSeeded(true), []);

  // Follow the machine directly from global backend broadcasts; onSeeded is called
  // once the backlog has been fetched (even if empty or machine is disconnected).
  useConsoleFollower(markSeeded);

  // Emit console:ready so the main window knows the console is alive. Do this after
  // the follower's listeners are registered (the follower registers them
  // asynchronously on mount, so this effect fires after them in the same cycle).
  useEffect(() => {
    void api.emitConsoleReady();
  }, []);

  useEffect(() => {
    void getCurrentWindow().setTitle(t("console.windowTitle"));
  }, [t]);

  // Note: the main window learns this window is gone from the Rust `Destroyed`
  // event (console:closed emitted in main.rs on_window_event), not from a JS
  // unmount — OS-close kills the JS context before any unmount runs, and a
  // reload-unmount would wrongly revert the stub.

  if (!seeded) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-card text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  return (
    <MachineActionsProvider value={actions}>
      <div className="flex h-screen w-screen flex-col bg-card text-foreground">
        {/* Full MachineToolbar: ConnBar (connect via intent → main) + QuickActions
            + F/S readout + StatusPill + EStop. Connection state from global
            broadcasts; connect/disconnect go as intents to the main window.
            skipReattach: the console window follows global broadcasts and must
            NEVER build a telemetry Channel — reattach() would swap the backend's
            telemetry away from the main window (main goes dark). */}
        <MachineToolbar skipReattach compactConn />
        <div className="min-h-0 flex-1">
          <ConsoleBody onClose={() => void getCurrentWindow().close()} />
        </div>
      </div>
    </MachineActionsProvider>
  );
}

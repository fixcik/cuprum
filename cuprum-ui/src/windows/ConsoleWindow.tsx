import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Loader2 } from "lucide-react";
import { useMachine } from "@/machineStore";
import { useConsoleClient } from "@/hooks/useConsoleClient";
import { useShowWindowWhenReady } from "@/hooks/useShowWindowWhenReady";
import { ConsoleBody } from "@/components/machine/ConsoleDrawer";
import { MachineToolbar } from "@/components/machine/MachineToolbar";
import {
  MachineActionsProvider,
  consoleMachineActions,
} from "@/components/machine/MachineActionsContext";

/** Root of the separate machine-console window (label "console"). Remote view:
 *  read-model fed by the main window's relay; closing it signals the main window.
 *  Actions go via consoleMachineActions: stateless writes hit the backend directly,
 *  connect/disconnect/home are forwarded as intents to the main window. */
export function ConsoleWindow() {
  const { t } = useTranslation("machine");
  useConsoleClient();
  // Stable provider value (factory captures only static api references).
  const actions = useMemo(() => consoleMachineActions(), []);
  const ready = useMachine((s) => s.lines.length > 0 || s.connected);
  const [seeded, setSeeded] = useState(false);
  useShowWindowWhenReady(seeded);
  const markSeeded = useCallback(() => setSeeded(true), []);
  useEffect(() => {
    if (ready) markSeeded();
  }, [ready, markSeeded]);

  useEffect(() => {
    void getCurrentWindow().setTitle(t("console.windowTitle"));
  }, [t]);

  // Note: the main window learns this window is gone from the Rust `Destroyed`
  // event (console:closed), not from a JS unmount — OS-close kills the JS context
  // before any unmount effect runs, and a reload unmount would wrongly revert.

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
            + F/S readout + StatusPill + EStop. Connection state shown from the
            relay-seeded read-model; connect/disconnect go as intents to the main window. */}
        <MachineToolbar />
        <div className="min-h-0 flex-1">
          <ConsoleBody onClose={() => void getCurrentWindow().close()} />
        </div>
      </div>
    </MachineActionsProvider>
  );
}

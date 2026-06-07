import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Fan, Gauge, Loader2 } from "lucide-react";
import { useMachine } from "@/machineStore";
import { useConsoleClient } from "@/hooks/useConsoleClient";
import { useShowWindowWhenReady } from "@/hooks/useShowWindowWhenReady";
import { ConsoleBody } from "@/components/machine/ConsoleDrawer";
import { StatusPill } from "@/components/machine/StatusPill";
import { QuickActions } from "@/components/machine/QuickActions";
import { EStop } from "@/components/machine/EStop";
import {
  MachineActionsProvider,
  consoleMachineActions,
  useMachineActions,
} from "@/components/machine/MachineActionsContext";

/** Inner toolbar that consumes the injected actions for the E-Stop wiring.
 *  Lives inside the MachineActionsProvider, so useMachineActions() is available. */
function ConsoleToolbar() {
  const a = useMachineActions();
  const feed = useMachine((s) => s.status.feed);
  const spindle = useMachine((s) => s.status.spindle);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3 py-2">
      {/* QuickActions consumes useMachineActions() internally. The console toolbar
          intentionally omits the Overrides panel (chosen scope). */}
      <QuickActions />
      <div className="ml-auto flex items-center gap-3">
        {/* Feed/spindle mini-readout — same layout as MachineToolbar. */}
        <div className="hidden items-center gap-3 font-mono text-[11px] tabular-nums text-muted-foreground sm:flex">
          <span className="inline-flex items-center gap-1">
            <Gauge className="size-3.5" />F{Math.round(feed)}
          </span>
          <span className="inline-flex items-center gap-1">
            <Fan className="size-3.5" />S{Math.round(spindle)}
          </span>
        </div>
        <StatusPill big />
        <div className="h-6 w-px bg-border" />
        <EStop compact onClick={() => a.softReset()} />
      </div>
    </div>
  );
}

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
        {/* Action toolbar: QuickActions + F/S readout + StatusPill + EStop.
            ConnBar (port/baud/connect) is deferred to Phase 3. */}
        <ConsoleToolbar />
        <div className="min-h-0 flex-1">
          <ConsoleBody onClose={() => void getCurrentWindow().close()} />
        </div>
      </div>
    </MachineActionsProvider>
  );
}

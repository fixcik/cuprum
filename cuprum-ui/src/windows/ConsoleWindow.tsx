import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Fan, Gauge, Loader2 } from "lucide-react";
import { useMachine } from "@/machineStore";
import { useConsoleClient } from "@/hooks/useConsoleClient";
import { useShowWindowWhenReady } from "@/hooks/useShowWindowWhenReady";
import { ConsoleBody } from "@/components/machine/ConsoleDrawer";
import { StatusPill } from "@/components/machine/StatusPill";

/** Root of the separate machine-console window (label "console"). Remote view:
 *  read-model fed by the main window's relay; closing it signals the main window. */
export function ConsoleWindow() {
  const { t } = useTranslation("machine");
  useConsoleClient();
  const ready = useMachine((s) => s.lines.length > 0 || s.connected);
  const feed = useMachine((s) => s.status.feed);
  const spindle = useMachine((s) => s.status.spindle);
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
    <div className="flex h-screen w-screen flex-col bg-card text-foreground">
      <div className="flex items-center gap-3 border-b border-border px-3 py-2">
        <StatusPill />
        {/* Feed/spindle mini-readout — same markup/classes as MachineToolbar. */}
        <div className="flex items-center gap-3 font-mono text-[11px] tabular-nums text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Gauge className="size-3.5" />F{Math.round(feed)}
          </span>
          <span className="inline-flex items-center gap-1">
            <Fan className="size-3.5" />S{Math.round(spindle)}
          </span>
        </div>
        {/* Phase 2 replaces this row with the full injected toolbar. */}
      </div>
      <div className="min-h-0 flex-1">
        <ConsoleBody onClose={() => void getCurrentWindow().close()} />
      </div>
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
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
  const [seeded, setSeeded] = useState(false);
  useShowWindowWhenReady(seeded);
  const markSeeded = useCallback(() => setSeeded(true), []);
  useEffect(() => {
    if (ready) markSeeded();
  }, [ready, markSeeded]);

  useEffect(() => {
    void getCurrentWindow().setTitle(t("console.windowTitle"));
  }, [t]);

  // Tell the main window when this window goes away (revert the drawer stub).
  useEffect(() => () => {
    void api.emitConsoleClosed();
  }, []);

  if (!seeded) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-card text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col bg-card text-foreground">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <StatusPill />
        {/* Phase 2 replaces this row with the full injected toolbar. */}
      </div>
      <div className="min-h-0 flex-1">
        <ConsoleBody onClose={() => void getCurrentWindow().close()} />
      </div>
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Plug, RefreshCw, Unplug } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { api, type SerialPortInfo } from "@/lib/api";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";

/** Connection bar: serial port select + hot-plug refresh + connect/disconnect.
 *  No status pill here — that lives in the toolbar. Live-refreshes the port list
 *  while disconnected (2s poll, paused when the tab is hidden), mirroring the
 *  original ConnectionBar. */
export function ConnBar() {
  const { t } = useTranslation("machine");
  const cnc = useSettings((s) => s.cncProfile);
  const setCnc = useSettings((s) => s.setCncProfile);
  const connected = useMachine((s) => s.connected);
  const connect = useMachine((s) => s.connect);
  const reattach = useMachine((s) => s.reattach);
  const disconnect = useMachine((s) => s.disconnect);
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [busy, setBusy] = useState(false);

  // After a webview reload the store resets to "disconnected" while the Rust
  // backend may still hold the serial port. Re-bind on mount so the UI recovers
  // the live connection instead of stranding it (a fresh connect would then hit
  // "already connected"). No-op if already connected or nothing is held.
  useEffect(() => {
    void reattach();
  }, [reattach]);

  const refresh = useCallback(() => {
    void api.machine.listPorts().then(setPorts).catch(() => setPorts([]));
  }, []);

  // Poll list_ports every 2s while disconnected; pause on hidden tab, stop once
  // connected or unmounted.
  useEffect(() => {
    if (connected) return;
    refresh();
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (timer === undefined) timer = setInterval(refresh, 2000);
    };
    const stop = () => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else {
        refresh();
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [connected, refresh]);

  const selectedPort = cnc.port ?? ports[0]?.name ?? "";

  const onToggle = async () => {
    setBusy(true);
    try {
      if (connected) await disconnect();
      else if (selectedPort) {
        setCnc({ port: selectedPort });
        await connect(selectedPort, cnc.baud);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <select
          value={selectedPort}
          disabled={connected}
          onChange={(e) => setCnc({ port: e.target.value })}
          className="h-9 w-[230px] appearance-none rounded-md border border-border bg-background pl-2.5 pr-8 text-[12px] text-foreground outline-none disabled:opacity-50"
        >
          {ports.length === 0 && <option value="">{t("connection.noPorts")}</option>}
          {ports.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      </div>
      <button
        type="button"
        title={t("connection.refresh")}
        onClick={refresh}
        disabled={connected}
        className="grid size-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:opacity-50"
      >
        <RefreshCw className="size-4" />
      </button>
      <Button
        variant={connected ? "outline" : "default"}
        onClick={onToggle}
        disabled={busy || (!connected && !selectedPort)}
      >
        {connected ? <Unplug className="size-4" /> : <Plug className="size-4" />}
        {connected ? t("connection.disconnect") : t("connection.connect")}
      </Button>
    </div>
  );
}

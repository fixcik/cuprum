import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { api, type SerialPortInfo, type MachineStateName } from "@/lib/api";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";

const STATE_TONE: Record<MachineStateName, string> = {
  idle: "bg-emerald-500/20 text-emerald-300",
  jog: "bg-emerald-500/20 text-emerald-300",
  run: "bg-sky-500/20 text-sky-300",
  hold: "bg-amber-500/20 text-amber-300",
  home: "bg-sky-500/20 text-sky-300",
  door: "bg-amber-500/20 text-amber-300",
  check: "bg-muted text-muted-foreground",
  sleep: "bg-muted text-muted-foreground",
  alarm: "bg-destructive/20 text-destructive",
  unknown: "bg-muted text-muted-foreground",
};

export function ConnectionBar() {
  const { t } = useTranslation("machine");
  const cnc = useSettings((s) => s.cncProfile);
  const setCnc = useSettings((s) => s.setCncProfile);
  const connected = useMachine((s) => s.connected);
  const state = useMachine((s) => s.status.state);
  const connect = useMachine((s) => s.connect);
  const disconnect = useMachine((s) => s.disconnect);
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [busy, setBusy] = useState(false);

  // Stable across renders (api is module-level, setPorts is a stable dispatch),
  // so the interval/visibility handler below never capture a stale closure.
  const refresh = useCallback(() => {
    void api.machine.listPorts().then(setPorts).catch(() => setPorts([]));
  }, []);

  // Live-refresh the port list on hot-plug while the Machine view is open and
  // the machine isn't connected: poll `list_ports` (cheap) every 2s, pausing
  // when the tab is hidden and stopping once connected or unmounted.
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
    <div className="flex items-center gap-2 border-b border-border px-4 py-2">
      <select
        value={selectedPort}
        disabled={connected}
        onChange={(e) => setCnc({ port: e.target.value })}
        className="h-8 rounded-md border border-border bg-card px-2 text-sm disabled:opacity-50"
      >
        {ports.length === 0 && <option value="">{t("connection.noPorts")}</option>}
        {ports.map((p) => (
          <option key={p.name} value={p.name}>{p.name}</option>
        ))}
      </select>
      <button
        title={t("connection.refresh")}
        onClick={refresh}
        disabled={connected}
        className="grid size-8 place-items-center rounded-md text-muted-foreground hover:text-foreground disabled:opacity-50"
      >
        <RefreshCw className="size-4" />
      </button>
      <Button onClick={onToggle} disabled={busy || (!connected && !selectedPort)}>
        {connected ? t("connection.disconnect") : t("connection.connect")}
      </Button>
      <div className="flex-1" />
      <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATE_TONE[state]}`}>
        {connected ? t(`state.${state}`) : t("connection.disconnected")}
      </span>
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Plug, RefreshCw, Unplug } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { api, type SerialPortInfo } from "@/lib/api";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";
import { useMachineActions } from "@/components/machine/MachineActionsContext";

export interface ConnBarProps {
  /** Narrow layout for tight columns (e.g. the drill inspector footer): the port
   *  select stretches to fill its row and the connect button drops to a full-width
   *  row below, instead of the default single fixed-width row. */
  compact?: boolean;
  /** Prepend a CNC machine picker (the registry select, bound to the active CNC
   *  machine) ahead of the port row. For screens without the Equipment master-list
   *  — e.g. the drill footer — so the operator can choose which CNC to connect to.
   *  Off in Equipment, where the left-hand machine list already selects the machine. */
  machinePicker?: boolean;
  /** When connected, collapse to a slim "● name · port · Disconnect" status row
   *  instead of the full bar with disabled selects. Lets a screen show what it's
   *  connected to (and disconnect) without keeping the pickers around. */
  connectedSummary?: boolean;
  /** When true, skip the automatic reattach() call on mount. Use in windows that
   *  follow machine state via global broadcasts (e.g. the drill window) and must
   *  NOT steal the main window's telemetry Channel on open. */
  skipReattach?: boolean;
  /** Extra classes on the root — e.g. `min-w-0 flex-1` so the connected summary
   *  can shrink/truncate inside a tight single-row toolbar (the console window). */
  className?: string;
}

/** Connection bar: serial port select + hot-plug refresh + connect/disconnect,
 *  optionally a CNC machine picker. No status pill here — that lives in the toolbar.
 *  Live-refreshes the port list while disconnected (2s poll, paused when the tab is
 *  hidden), mirroring the original ConnectionBar. */
export function ConnBar({
  compact = false,
  machinePicker = false,
  connectedSummary = false,
  skipReattach = false,
  className,
}: ConnBarProps = {}) {
  const { t } = useTranslation("machine");
  const cnc = useSettings((s) => s.cncProfile);
  const setCnc = useSettings((s) => s.setCncProfile);
  const machines = useSettings((s) => s.machines);
  const activeCncMachineId = useSettings((s) => s.activeCncMachineId);
  const setActiveCncMachineId = useSettings((s) => s.setActiveCncMachineId);
  const a = useMachineActions();
  const connected = useMachine((s) => s.connected);
  const connectedPort = useMachine((s) => s.port);
  const reattach = useMachine((s) => s.reattach);
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [busy, setBusy] = useState(false);

  const cncMachines = machines.filter((m) => m.kind === "cnc");

  // After a webview reload the store resets to "disconnected" while the Rust
  // backend may still hold the serial port. Re-bind on mount so the UI recovers
  // the live connection instead of stranding it (a fresh connect would then hit
  // "already connected"). No-op if already connected or nothing is held.
  // Skipped in windows that follow via global broadcasts (drill window) so they
  // don't steal the main window's telemetry Channel on open.
  useEffect(() => {
    if (!skipReattach) void reattach();
  }, [reattach, skipReattach]);

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

  // While connected the live port is the store's `port`; fall back to the saved
  // profile port, then the first discovered port.
  const selectedPort = (connected ? connectedPort ?? cnc.port : cnc.port) ?? ports[0]?.name ?? "";

  // Always carry an <option> for the currently-selected port, even when the poll
  // never ran — e.g. after a webview reload reattaches an already-open port, so the
  // poll bailed on `connected` and `ports` is still empty. Without this synthetic
  // entry the disabled select falls back to the "no ports" placeholder and the live
  // connection looks lost.
  const portOptions: SerialPortInfo[] =
    selectedPort && !ports.some((p) => p.name === selectedPort)
      ? [{ name: selectedPort, kind: "" }, ...ports]
      : ports;

  const onToggle = () => {
    setBusy(true);
    if (connected) {
      a.disconnect();
    } else if (selectedPort) {
      setCnc({ port: selectedPort });
      a.connect(selectedPort, cnc.baud);
    }
    // The busy flag is cleared on the next connected-state change via the store,
    // so we reset it promptly here. For the main window the actual connect is
    // async but the store updates connected synchronously upon completion; for the
    // console window it is a fire-and-forget intent to the main window.
    setBusy(false);
  };

  // Connected slim summary (opt-in): show what we're connected to + a disconnect
  // button, instead of the full bar. The pickers reappear after disconnecting.
  if (connectedSummary && connected) {
    return (
      <div className={cn("flex items-center gap-2", className)}>
        <span className="size-2 shrink-0 rounded-full bg-emerald-500" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
          {(cnc.name || t("connection.machine")) + " · " + (connectedPort ?? cnc.port ?? "—")}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={onToggle}
          disabled={busy}
          className="shrink-0"
        >
          <Unplug className="size-4" />
          {t("connection.disconnect")}
        </Button>
      </div>
    );
  }

  return (
    <div className={cn(compact ? "flex flex-col gap-2" : "flex items-center gap-2", className)}>
      {/* Optional CNC machine picker (registry) — bound to the active CNC machine. */}
      {machinePicker && cncMachines.length > 0 && (
        <div className={compact ? "relative w-full" : "relative"}>
          <select
            value={activeCncMachineId ?? ""}
            disabled={connected}
            onChange={(e) => setActiveCncMachineId(e.target.value)}
            title={t("connection.machine")}
            aria-label={t("connection.machine")}
            className={`h-9 appearance-none rounded-md border border-border bg-background pl-2.5 pr-8 text-[12px] text-foreground outline-none disabled:opacity-50 ${
              compact ? "w-full" : "w-[230px]"
            }`}
          >
            {cncMachines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        </div>
      )}
      {/* Row 1 (compact) / inline group: port select + hot-plug refresh. */}
      <div className={compact ? "flex items-center gap-2" : "contents"}>
        <div className={compact ? "relative flex-1" : "relative"}>
          <select
            value={selectedPort}
            disabled={connected}
            onChange={(e) => setCnc({ port: e.target.value })}
            className={`h-9 appearance-none rounded-md border border-border bg-background pl-2.5 pr-8 text-[12px] text-foreground outline-none disabled:opacity-50 ${
              compact ? "w-full" : "w-[230px]"
            }`}
          >
            {portOptions.length === 0 && <option value="">{t("connection.noPorts")}</option>}
            {portOptions.map((p) => (
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
          className={`grid size-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:opacity-50 ${
            compact ? "shrink-0" : ""
          }`}
        >
          <RefreshCw className="size-4" />
        </button>
      </div>
      <Button
        variant={connected ? "outline" : "default"}
        onClick={onToggle}
        disabled={busy || (!connected && !selectedPort)}
        className={compact ? "w-full" : undefined}
      >
        {connected ? <Unplug className="size-4" /> : <Plug className="size-4" />}
        {connected ? t("connection.disconnect") : t("connection.connect")}
      </Button>
    </div>
  );
}

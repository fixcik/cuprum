import { createContext, useContext, type ReactNode } from "react";
import { api } from "@/lib/api";
import { useMachine } from "@/machineStore";

/** All write-side machine actions surfaced to toolbar/console components.
 *  Implementations vary by window: the main window owns the store and the
 *  serial connection; the console window delegates connect/disconnect/home to
 *  the main window via intents. */
export interface MachineActions {
  send: (line: string) => void;
  unlock: () => void;
  feedHold: () => void;
  cycleStart: () => void;
  softReset: () => void;
  override: (kind: "feed" | "spindle", action: string) => void;
  home: () => void;
  connect: (port: string, baud: number) => void;
  disconnect: () => void;
}

const Ctx = createContext<MachineActions | null>(null);

/** Provide window-appropriate machine action handlers to the subtree. Every
 *  window that renders machine controls must wrap its subtree in this provider. */
export function MachineActionsProvider({
  value,
  children,
}: {
  value: MachineActions;
  children: ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Returns the injected machine action handlers. Throws if called outside a
 *  MachineActionsProvider — every consumer window must wrap its machine UI. */
export function useMachineActions(): MachineActions {
  const v = useContext(Ctx);
  if (!v) throw new Error("useMachineActions: missing MachineActionsProvider");
  return v;
}

/** Main-window wiring: store logic for connect/disconnect/home (they own the
 *  serial Channel); direct backend calls for the stateless write operations. */
export function mainMachineActions(): MachineActions {
  const st = useMachine.getState();
  return {
    send: (l) => void api.machine.send(l),
    unlock: () => void api.machine.unlock(),
    feedHold: () => void api.machine.feedHold(),
    cycleStart: () => void api.machine.cycleStart(),
    softReset: () => void api.machine.softReset(),
    override: (k, a) => void api.machine.override(k as "feed" | "rapid" | "spindle", a as "100" | "+10" | "-10" | "+1" | "-1" | "stop"),
    home: () => void st.runHoming(),
    connect: (p, b) => void st.connect(p, b),
    disconnect: () => void st.disconnect(),
  };
}

/** Console-window wiring: direct backend calls for stateless writes (the
 *  backend serial port is a process singleton — safe from any window); intents
 *  to the main window for connect/disconnect/home, which require the Channel
 *  and store logic that live only in the main window. */
export function consoleMachineActions(): MachineActions {
  return {
    send: (l) => void api.machine.send(l),
    unlock: () => void api.machine.unlock(),
    feedHold: () => void api.machine.feedHold(),
    cycleStart: () => void api.machine.cycleStart(),
    softReset: () => void api.machine.softReset(),
    override: (k, a) => void api.machine.override(k as "feed" | "rapid" | "spindle", a as "100" | "+10" | "-10" | "+1" | "-1" | "stop"),
    home: () => void api.emitConsoleHome(),
    connect: (p, b) => void api.emitConsoleConnect(p, b),
    disconnect: () => void api.emitConsoleDisconnect(),
  };
}

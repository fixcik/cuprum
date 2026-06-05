import { create } from "zustand";
import { Channel } from "@tauri-apps/api/core";
import { api, type ConsoleLine, type MachineStatus, type Telemetry } from "@/lib/api";
import { parseHomingEnabled } from "@/lib/workZero";

const MAX_LINES = 500;

const IDLE_STATUS: MachineStatus = {
  state: "unknown",
  mpos: [0, 0, 0],
  wpos: [0, 0, 0],
  feed: 0,
  spindle: 0,
};

interface MachineStore {
  connected: boolean;
  port: string | null;
  status: MachineStatus;
  lines: ConsoleLine[];
  /** True once $22=1 is confirmed from a $$ query after connect. */
  homingAvailable: boolean;
  connect: (port: string, baud: number) => Promise<void>;
  disconnect: () => Promise<void>;
  pushLine: (line: ConsoleLine) => void;
  setStatus: (status: MachineStatus) => void;
  reset: () => void;
}

export const useMachine = create<MachineStore>((set, get) => ({
  connected: false,
  port: null,
  status: IDLE_STATUS,
  lines: [],
  homingAvailable: false,
  connect: async (port, baud) => {
    const ch = new Channel<Telemetry>();
    ch.onmessage = (msg) => {
      if (msg.type === "status") {
        const { state, mpos, wpos, feed, spindle } = msg;
        get().setStatus({ state, mpos, wpos, feed, spindle });
      } else {
        get().pushLine({ dir: msg.dir, text: msg.text });
        // Scan firmware settings lines for homing-enable ($22).
        const homing = parseHomingEnabled(msg.text);
        if (homing !== null) set({ homingAvailable: homing });
      }
    };
    await api.machine.connect(port, baud, ch);
    set({ connected: true, port });
    // Query firmware settings to detect homing support ($22).
    await api.machine.send("$$");
  },
  disconnect: async () => {
    if (!get().connected) return;
    await api.machine.disconnect();
    get().reset();
  },
  pushLine: (line) => set((s) => ({ lines: [...s.lines.slice(-(MAX_LINES - 1)), line] })),
  setStatus: (status) => set({ status }),
  // Keep `lines` so the user still sees why the connection dropped (e.g. the
  // error line pushed just before an unplug). Connection state + DRO reset.
  reset: () => set({ connected: false, port: null, status: IDLE_STATUS, homingAvailable: false }),
}));

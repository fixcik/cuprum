import { create } from "zustand";
import { Channel } from "@tauri-apps/api/core";
import { api, type ConsoleLine, type MachineStatus, type Telemetry } from "@/lib/api";

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
  connect: async (port, baud) => {
    const ch = new Channel<Telemetry>();
    ch.onmessage = (msg) => {
      if (msg.type === "status") {
        const { state, mpos, wpos, feed, spindle } = msg;
        get().setStatus({ state, mpos, wpos, feed, spindle });
      } else {
        get().pushLine({ dir: msg.dir, text: msg.text });
      }
    };
    await api.machine.connect(port, baud, ch);
    set({ connected: true, port });
  },
  disconnect: async () => {
    await api.machine.disconnect();
    get().reset();
  },
  pushLine: (line) => set((s) => ({ lines: [...s.lines.slice(-(MAX_LINES - 1)), line] })),
  setStatus: (status) => set({ status }),
  reset: () => set({ connected: false, port: null, status: IDLE_STATUS, lines: [] }),
}));

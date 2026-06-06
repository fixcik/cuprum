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
  overrides: [100, 100, 100],
};

interface MachineStore {
  connected: boolean;
  port: string | null;
  status: MachineStatus;
  lines: ConsoleLine[];
  /** True once $22=1 is confirmed from a $$ query after connect. */
  homingAvailable: boolean;
  /** True once a homing cycle has completed this session (state home → idle).
   *  Cleared on connect, alarm, and disconnect/reset. Gates machine-coordinate
   *  auto-moves (G53 retracts) so they never run against an unreferenced frame. */
  homed: boolean;
  connect: (port: string, baud: number) => Promise<void>;
  disconnect: () => Promise<void>;
  pushLine: (line: Omit<ConsoleLine, "ts">) => void;
  setStatus: (status: MachineStatus) => void;
  reset: () => void;
}

export const useMachine = create<MachineStore>((set, get) => ({
  connected: false,
  port: null,
  status: IDLE_STATUS,
  lines: [],
  homingAvailable: false,
  homed: false,
  connect: async (port, baud) => {
    const ch = new Channel<Telemetry>();
    ch.onmessage = (msg) => {
      if (msg.type === "status") {
        const { state, mpos, wpos, feed, spindle, overrides = [100, 100, 100] } = msg;
        get().setStatus({ state, mpos, wpos, feed, spindle, overrides });
      } else {
        get().pushLine({ dir: msg.dir, text: msg.text });
        // Scan firmware settings lines for homing-enable ($22).
        const homing = parseHomingEnabled(msg.text);
        if (homing !== null) set({ homingAvailable: homing });
      }
    };
    await api.machine.connect(port, baud, ch);
    // A fresh connection has not been homed yet; require a homing cycle before
    // machine-coordinate auto-moves are allowed.
    set({ connected: true, port, homed: false });
    // Query firmware settings to detect homing support ($22).
    await api.machine.send("$$");
  },
  disconnect: async () => {
    if (!get().connected) return;
    await api.machine.disconnect();
    get().reset();
  },
  // Stamp the local arrival time front-side so the console can show per-line
  // timings (e.g. how long an `ok` took).
  pushLine: (line) =>
    set((s) => ({ lines: [...s.lines.slice(-(MAX_LINES - 1)), { ...line, ts: Date.now() }] })),
  // Track the homing cycle via the status stream: a transition out of the `home`
  // state into `idle` means the cycle completed, so the frame is referenced
  // (homed). Entering `alarm` clears it — an alarm voids the known position.
  setStatus: (status) =>
    set((s) => {
      const prev = s.status.state;
      let homed = s.homed;
      if (prev === "home" && status.state === "idle") homed = true;
      else if (status.state === "alarm") homed = false;
      return homed === s.homed ? { status } : { status, homed };
    }),
  // Keep `lines` so the user still sees why the connection dropped (e.g. the
  // error line pushed just before an unplug). Connection state + DRO reset.
  reset: () =>
    set({
      connected: false,
      port: null,
      status: IDLE_STATUS,
      homingAvailable: false,
      homed: false,
    }),
}));

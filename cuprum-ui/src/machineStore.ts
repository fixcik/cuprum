import { create } from "zustand";
import { Channel } from "@tauri-apps/api/core";
import { api, type ConsoleLine, type MachineStatus, type Telemetry } from "@/lib/api";
import { parseHomingEnabled, parseSoftLimitsEnabled, parseMaxTravel } from "@/lib/workZero";

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
  /** GRBL soft-limits ($20) flag from the last $$ query. null = not yet known. */
  softLimitsEnabled: boolean | null;
  /** GRBL max-travel per axis [X,Y,Z] mm ($130/$131/$132). null until the first
   *  $$ query reports any of them; axes not yet seen stay at 0. */
  maxTravelMm: [number, number, number] | null;
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

// Partial accumulator for $130/$131/$132 — filled as the $$ lines stream in;
// reset on connect/disconnect. maxTravelMm is only published once all three are in.
let travelBuf: [number | null, number | null, number | null] = [null, null, null];

export const useMachine = create<MachineStore>((set, get) => ({
  connected: false,
  port: null,
  status: IDLE_STATUS,
  lines: [],
  homingAvailable: false,
  softLimitsEnabled: null,
  maxTravelMm: null,
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
        // Soft-limits enable ($20).
        const soft = parseSoftLimitsEnabled(msg.text);
        if (soft !== null) set({ softLimitsEnabled: soft });
        // Max travel per axis ($130/$131/$132). Accumulate into a partial buffer
        // and only publish the [X,Y,Z] tuple once ALL three axes are known, so the
        // soft-limit mismatch notice can't flash on a half-filled tuple.
        const travel = parseMaxTravel(msg.text);
        if (travel !== null)
          set(() => {
            travelBuf[travel.axis] = travel.value;
            const [x, y, z] = travelBuf;
            if (x !== null && y !== null && z !== null) return { maxTravelMm: [x, y, z] };
            return {};
          });
      }
    };
    await api.machine.connect(port, baud, ch);
    // A fresh connection has not been homed yet; require a homing cycle before
    // machine-coordinate auto-moves are allowed. Soft-limit state is unknown
    // until the following $$ query reports it.
    travelBuf = [null, null, null];
    set({ connected: true, port, homed: false, softLimitsEnabled: null, maxTravelMm: null });
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
  reset: () => {
    travelBuf = [null, null, null];
    set({
      connected: false,
      port: null,
      status: IDLE_STATUS,
      homingAvailable: false,
      softLimitsEnabled: null,
      maxTravelMm: null,
      homed: false,
    });
  },
}));

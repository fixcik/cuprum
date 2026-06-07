import { create } from "zustand";
import { Channel } from "@tauri-apps/api/core";
import { api, type ConsoleLine, type MachineStatus, type Telemetry } from "@/lib/api";
import { parseHomingEnabled, parseSoftLimitsEnabled, parseMaxTravel } from "@/lib/workZero";
import { shouldInferHomed } from "@/lib/homing";

const MAX_LINES = 500;

/** Grace after connect before judging whether the machine is already referenced.
 *  $$ replies within ~100 ms and status streams every 200 ms, so by now both the
 *  $22 flag and a fresh state are in. */
const HOME_DETECT_DELAY_MS = 600;

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
  /** True while a homing cycle launched from the app is in progress. Drives the
   *  control-panel "homing…" overlay. GRBL is silent during the cycle, so this is
   *  bracketed by the homeAwait command, not the status stream. */
  homing: boolean;
  connect: (port: string, baud: number) => Promise<void>;
  disconnect: () => Promise<void>;
  pushLine: (line: Omit<ConsoleLine, "ts">) => void;
  setStatus: (status: MachineStatus) => void;
  /** Run a homing cycle ($H), waiting for GRBL to confirm completion. Marks the
   *  frame homed on success; surfaces failure/abort to the console. */
  runHoming: () => Promise<void>;
  /** Abort an in-progress homing cycle: soft-reset GRBL and drop the overlay. */
  cancelHoming: () => void;
  reset: () => void;
}

// Partial accumulator for $130/$131/$132 — filled as the $$ lines stream in;
// reset on connect/disconnect. maxTravelMm is only published once all three are in.
let travelBuf: [number | null, number | null, number | null] = [null, null, null];

// Whether the machine has been seen in ALARM at any point since the last connect.
// A cold boot ($22=1) starts in alarm; if we ever observe that, a later `idle`
// (e.g. the user cleared it with `$X`) must NOT be mistaken for an already-homed
// frame. Reset on connect.
let seenAlarmAfterConnect = false;

export const useMachine = create<MachineStore>((set, get) => ({
  connected: false,
  port: null,
  status: IDLE_STATUS,
  lines: [],
  homingAvailable: false,
  softLimitsEnabled: null,
  maxTravelMm: null,
  homed: false,
  homing: false,
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
    // Start unhomed; the detection below may upgrade this if the controller kept
    // its reference across the reconnect. Soft-limit state is unknown until the
    // following $$ query reports it.
    travelBuf = [null, null, null];
    seenAlarmAfterConnect = false;
    set({ connected: true, port, homed: false, homing: false, softLimitsEnabled: null, maxTravelMm: null });
    // Query firmware settings to detect homing support ($22).
    await api.machine.send("$$");
    // Re-reference detection: a power-retained reconnect (just re-opening the USB
    // port) doesn't need a fresh homing cycle — GRBL still knows where it is. With
    // homing enabled it would boot into ALARM if it had lost the reference, so a
    // plain `idle` shortly after connect means it's still homed. A true cold boot
    // shows ALARM and stays unhomed (the user is prompted to home).
    setTimeout(() => {
      const s = get();
      if (!s.connected || s.port !== port) return;
      if (
        shouldInferHomed({
          homingAvailable: s.homingAvailable,
          state: s.status.state,
          alreadyHomed: s.homed,
          seenAlarmSinceConnect: seenAlarmAfterConnect,
        })
      )
        set({ homed: true });
    }, HOME_DETECT_DELAY_MS);
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
      else if (status.state === "alarm") {
        homed = false;
        // Remember the alarm so connect's re-reference detection won't mistake a
        // later `$X`-cleared idle for an already-homed frame.
        seenAlarmAfterConnect = true;
      }
      return homed === s.homed ? { status } : { status, homed };
    }),
  // GRBL stays silent during the cycle, so completion can't be read from the
  // status stream — homeAwait resolves on the `$H` ok (homed) and rejects on
  // failure/abort. The overlay tracks `homing`.
  runHoming: async () => {
    if (get().homing) return;
    set({ homing: true });
    try {
      await api.machine.homeAwait();
      set({ homed: true, homing: false });
    } catch (e) {
      // cancelHoming already cleared `homing`; an "aborted" reject is expected
      // then. Only surface the reason; the alarm banner covers genuine failures.
      get().pushLine({ dir: "rx", text: `homing: ${String(e)}` });
      set({ homing: false });
    }
  },
  cancelHoming: () => {
    if (!get().homing) return;
    void api.machine.softReset();
    set({ homing: false });
  },
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
      homing: false,
    });
  },
}));

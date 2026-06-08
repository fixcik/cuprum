import { create } from "zustand";
import { Channel } from "@tauri-apps/api/core";
import { api, type ConsoleLine, type MachineStatus, type Telemetry } from "@/lib/api";

export type { ConsoleLine };
import {
  parseHomingEnabled,
  parseSoftLimitsEnabled,
  parseMaxTravel,
  parseMaxSpindle,
  parseMinSpindle,
} from "@/lib/workZero";
import { shouldInferHomed } from "@/lib/homing";

const MAX_LINES = 500;

// Monotonic counter for per-line sequence numbers used by the relay delta helper.
let lineSeq = 0;

/** Grace after connect before judging whether the machine is already referenced.
 *  $$ replies within ~100 ms and status streams every 200 ms, so by now both the
 *  $22 flag and a fresh state are in. */
const HOME_DETECT_DELAY_MS = 600;

const PINS_CLEAR = { x: false, y: false, z: false, probe: false } as const;

const IDLE_STATUS: MachineStatus = {
  state: "unknown",
  mpos: [0, 0, 0],
  wpos: [0, 0, 0],
  feed: 0,
  spindle: 0,
  overrides: [100, 100, 100],
  pins: { ...PINS_CLEAR },
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
  /** GRBL max spindle speed ($30, RPM) — the firmware ceiling the S word maps to
   *  100 % PWM. null until the $$ query reports it; the spindle gauge falls back
   *  to the profile's spindleMaxRpm meanwhile. */
  maxSpindleRpm: number | null;
  /** GRBL min spindle speed ($31, S-word) — the minimum PWM floor: below this S
   *  word (but above 0) the spindle still spins at its slowest. null until the $$
   *  query reports it; 0 means no floor. Drives the spindle slider's lower bound. */
  minSpindleRpm: number | null;
  /** True once a homing cycle has completed this session (state home → idle).
   *  Cleared on connect, alarm, and disconnect/reset. Gates machine-coordinate
   *  auto-moves (G53 retracts) so they never run against an unreferenced frame. */
  homed: boolean;
  /** True while a homing cycle launched from the app is in progress. Drives the
   *  control-panel "homing…" overlay. GRBL is silent during the cycle, so this is
   *  bracketed by the homeAwait command, not the status stream. */
  homing: boolean;
  connect: (port: string, baud: number) => Promise<void>;
  /** Re-bind to a connection the backend kept alive across a webview reload: if
   *  the Rust side still holds the serial port, subscribe a fresh telemetry
   *  Channel and restore connection state. No-op if already connected or nothing
   *  is held. Call once on mount. */
  reattach: () => Promise<void>;
  disconnect: () => Promise<void>;
  pushLine: (line: Omit<ConsoleLine, "ts" | "seq">) => void;
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

// Guards against overlapping reattach() calls (e.g. React StrictMode's double
// mount fires the effect twice): the `connected` check alone doesn't, since both
// calls pass it before the awaited backend round-trip resolves.
let reattaching = false;

export const useMachine = create<MachineStore>((set, get) => {
  // Build a telemetry Channel wired to the store. Shared by connect() and
  // reattach() so a post-reload re-bind streams status/console exactly like a
  // fresh connect.
  const buildChannel = (): Channel<Telemetry> => {
    const ch = new Channel<Telemetry>();
    ch.onmessage = (msg) => {
      if (msg.type === "status") {
        const { state, mpos, wpos, feed, spindle, overrides = [100, 100, 100], pins } = msg;
        get().setStatus({ state, mpos, wpos, feed, spindle, overrides, pins: pins ?? { ...PINS_CLEAR } });
      } else {
        get().pushLine({ dir: msg.dir, text: msg.text });
        // Scan firmware settings lines for homing-enable ($22).
        const homing = parseHomingEnabled(msg.text);
        if (homing !== null) set({ homingAvailable: homing });
        // Soft-limits enable ($20).
        const soft = parseSoftLimitsEnabled(msg.text);
        if (soft !== null) set({ softLimitsEnabled: soft });
        // Max spindle speed ($30) — the real scale for the spindle gauge.
        const maxSpindle = parseMaxSpindle(msg.text);
        if (maxSpindle !== null) set({ maxSpindleRpm: maxSpindle });
        // Min spindle speed ($31) — the slider's lower bound.
        const minSpindle = parseMinSpindle(msg.text);
        if (minSpindle !== null) set({ minSpindleRpm: minSpindle });
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
    return ch;
  };

  // Post-connect bring-up shared by connect() and reattach(): reset the derived
  // state, mark connected, re-query $$ and run the re-reference detection.
  const finishConnect = async (port: string) => {
    // Start unhomed; the detection below may upgrade this if the controller kept
    // its reference across the reconnect. Soft-limit state is unknown until the
    // following $$ query reports it.
    travelBuf = [null, null, null];
    seenAlarmAfterConnect = false;
    set({
      connected: true,
      port,
      homed: false,
      homing: false,
      softLimitsEnabled: null,
      maxTravelMm: null,
      maxSpindleRpm: null,
      minSpindleRpm: null,
    });
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
  };

  return {
    connected: false,
    port: null,
    status: IDLE_STATUS,
    lines: [],
    homingAvailable: false,
    softLimitsEnabled: null,
    maxTravelMm: null,
    maxSpindleRpm: null,
    minSpindleRpm: null,
    homed: false,
    homing: false,
    connect: async (port, baud) => {
      await api.machine.connect(port, baud, buildChannel());
      await finishConnect(port);
    },
    reattach: async () => {
      // Already wired up in this JS context, or a reattach is mid-flight — nothing
      // to do. `reattaching` is set synchronously so overlapping calls bail before
      // the awaited backend round-trip.
      if (get().connected || reattaching) return;
      reattaching = true;
      try {
        const info = await api.machine.reattach(buildChannel());
        // null => the backend holds no connection (normal cold start).
        if (info) await finishConnect(info.port);
      } finally {
        reattaching = false;
      }
    },
    disconnect: async () => {
      if (!get().connected) return;
      await api.machine.disconnect();
      get().reset();
    },
    // Stamp the local arrival time and monotonic seq front-side so the console
    // can show per-line timings and the relay delta helper can key on seq.
    pushLine: (line) =>
      set((s) => ({
        lines: [...s.lines, { ...line, seq: ++lineSeq, ts: Date.now() }].slice(-(MAX_LINES)),
      })),
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
        maxSpindleRpm: null,
        minSpindleRpm: null,
        homed: false,
        homing: false,
      });
    },
  };
});

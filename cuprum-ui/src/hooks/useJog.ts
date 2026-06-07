import { useCallback, useEffect } from "react";
import { create } from "zustand";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";
import { api } from "@/lib/api";
import { canMove } from "@/lib/machineControls";
import { clampJogDelta } from "@/lib/jogClamp";
import { resolveJogBounds } from "@/lib/jogBounds";
import type { JogBounds } from "@/lib/jogBounds";

export type JogStep = number | "cont";

/** Below this many mm of room to the envelope edge a jog is a no-op (already
 *  parked at the edge). */
const MIN_JOG_MM = 0.01;

/** Feed (mm/min) for a "rapid-like" click-to-move jog: deliberately huge so GRBL
 *  clamps it to each axis' max rate — i.e. as fast as the old G0 traverse, but as
 *  a (cancellable) jog. */
export const RAPID_JOG_FEED = 100_000;

/** Active jog step — a shared transient UI choice (not persisted) so the jog pad
 *  and the Z-bar Z± buttons always move by the same step. */
interface JogStepStore {
  step: JogStep;
  setStep: (s: JogStep) => void;
}
const initialStep = (): JogStep => {
  const steps = useSettings.getState().cncProfile.jogStepsMm;
  return steps[Math.min(1, steps.length - 1)] ?? 1;
};
export const useJogStep = create<JogStepStore>((set) => ({
  step: initialStep(),
  setStep: (step) => set({ step }),
}));

// Module-level guard so a continuous jog started from one control is visible to
// every other consumer of the hook — only one continuous move may be in flight
// at a time. Plain (non-reactive) on purpose: it gates sends, it isn't rendered.
let moving = false;

export type { JogBounds };

/** Shared jog controller used by the jog pad, the Z bar and the work field: the
 *  shared step state, a one-shot step jog (`go`), a continuous hold jog
 *  (`startContinuous`/`stopContinuous`), and an absolute cancel-then-retarget
 *  click-to-move (`jogTo`). Every move is clamped to the resolved bounds (default:
 *  X∈[0,x], Y∈[0,y], Z∈[-z,0]) from the live machine position. Pass `bounds` to
 *  override the clamp range, e.g. for machine-frame touch-off before work zero is
 *  set. */
export function useJog(opts?: { bounds?: JogBounds }) {
  const cnc = useSettings((s) => s.cncProfile);
  const connected = useMachine((s) => s.connected);
  const state = useMachine((s) => s.status.state);
  const enabled = canMove(state, connected);
  const step = useJogStep((s) => s.step);
  const setStep = useJogStep((s) => s.setStep);
  const continuous = step === "cont";

  // Resolve clamp bounds once per render; destructure to six stable primitives so
  // the callbacks can list them as deps without an object identity churn each render.
  const b = resolveJogBounds(cnc.workEnvelopeMm, opts?.bounds);
  const [bx0, bx1] = b.x;
  const [by0, by1] = b.y;
  const [bz0, bz1] = b.z;

  // Step jog: one relative move per call, each axis clamped to the bounds from the
  // live mpos. No-op if every clamped axis is below the edge threshold.
  const go = useCallback(
    (dx: number, dy: number, dz: number) => {
      if (!enabled || typeof step !== "number") return;
      const mpos = useMachine.getState().status.mpos;
      const ax = clampJogDelta(dx * step, mpos[0], bx0, bx1);
      const ay = clampJogDelta(dy * step, mpos[1], by0, by1);
      const az = clampJogDelta(dz * step, mpos[2], bz0, bz1);
      if (Math.abs(ax) < MIN_JOG_MM && Math.abs(ay) < MIN_JOG_MM && Math.abs(az) < MIN_JOG_MM) return;
      void api.machine.jog(ax, ay, az, cnc.jogFeedMmMin);
    },
    [enabled, step, cnc.jogFeedMmMin, bx0, bx1, by0, by1, bz0, bz1],
  );

  // Continuous jog: a single jog toward the bounds edge along the chosen direction;
  // the trailing jog-cancel on release stops it early. For diagonals every active
  // axis is clamped to the smallest available room so motion stays on a true 45°
  // line and never leaves the bounds.
  const startContinuous = useCallback(
    async (sx: number, sy: number, sz: number) => {
      if (!enabled) return;
      if (moving) {
        // Another direction is already in flight (e.g. a second key/pointer):
        // cancel it and AWAIT the cancel so the new jog can't reach GRBL's
        // planner first (which would stack the two moves).
        moving = false;
        await api.machine.jogCancel();
      }
      const mpos = useMachine.getState().status.mpos;
      const roomX = sx > 0 ? bx1 - mpos[0] : sx < 0 ? mpos[0] - bx0 : Infinity;
      const roomY = sy > 0 ? by1 - mpos[1] : sy < 0 ? mpos[1] - by0 : Infinity;
      const roomZ = sz > 0 ? bz1 - mpos[2] : sz < 0 ? mpos[2] - bz0 : Infinity;
      const room = Math.min(
        sx !== 0 ? Math.max(0, roomX) : Infinity,
        sy !== 0 ? Math.max(0, roomY) : Infinity,
        sz !== 0 ? Math.max(0, roomZ) : Infinity,
      );
      if (!Number.isFinite(room) || room <= MIN_JOG_MM) return;
      moving = true;
      void api.machine.jog(sx * room, sy * room, sz * room, cnc.jogFeedMmMin);
    },
    [enabled, bx0, bx1, by0, by1, bz0, bz1, cnc.jogFeedMmMin],
  );

  const stopContinuous = useCallback(() => {
    if (!moving) return;
    moving = false;
    void api.machine.jogCancel();
  }, []);

  // Absolute click-to-move jog: drive the given axes (work coordinates) to their
  // targets, each clamped to the bounds. Cancels any in-flight jog first so a
  // fresh click RETARGETS instead of queuing behind the old move (GRBL buffers
  // jogs) — and because a jog keeps the machine in the `jog` state (still
  // `canMove`), the click surface stays live, so re-clicks aren't blocked. Uses an
  // absolute target ($J=G90) so it's robust to where the cancel decelerated.
  // `feed` defaults to the jog feed; pass RAPID_JOG_FEED for rapid-like traverse.
  const jogTo = useCallback(
    async (target: { x?: number; y?: number; z?: number }, feed = cnc.jogFeedMmMin) => {
      if (!enabled) return;
      const { mpos, wpos } = useMachine.getState().status;
      // Clamp each work-space target to the bounds via the live work offset
      // (wco = machine − work), so the target stays within [lo, hi] in machine coords.
      const clampWork = (work: number, axis: 0 | 1 | 2, lo: number, hi: number): number => {
        const wco = mpos[axis] - wpos[axis];
        return Math.min(hi, Math.max(lo, work + wco)) - wco;
      };
      const tx = target.x !== undefined ? clampWork(target.x, 0, bx0, bx1) : undefined;
      const ty = target.y !== undefined ? clampWork(target.y, 1, by0, by1) : undefined;
      const tz = target.z !== undefined ? clampWork(target.z, 2, bz0, bz1) : undefined;
      // Skip a no-op jog (target already at the current position) — GRBL rejects a
      // zero-distance $J with an error, which would just be console noise.
      const atTarget = (t: number | undefined, axis: 0 | 1 | 2) =>
        t === undefined || Math.abs(t - wpos[axis]) < MIN_JOG_MM;
      if (atTarget(tx, 0) && atTarget(ty, 1) && atTarget(tz, 2)) return;
      // Retarget: stop the current jog (continuous or a prior click-to-move) so
      // the new absolute jog replaces it rather than running after it.
      if (moving || useMachine.getState().status.state === "jog") {
        moving = false;
        await api.machine.jogCancel();
      }
      void api.machine.jogTo({ x: tx, y: ty, z: tz }, feed);
    },
    [enabled, bx0, bx1, by0, by1, bz0, bz1, cnc.jogFeedMmMin],
  );

  // Stop any in-flight continuous jog the moment motion becomes disallowed
  // (disconnect, alarm, …) so the machine never keeps running after the controls
  // go dead.
  useEffect(() => {
    if (!enabled && moving) stopContinuous();
  }, [enabled, stopContinuous]);

  return { enabled, step, setStep, continuous, go, startContinuous, stopContinuous, jogTo };
}

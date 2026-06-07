import { useCallback, useEffect } from "react";
import { create } from "zustand";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";
import { api } from "@/lib/api";
import { canMove } from "@/lib/machineControls";
import { clampJogDelta } from "@/lib/jogClamp";

export type JogStep = number | "cont";

/** Below this many mm of room to the envelope edge a jog is a no-op (already
 *  parked at the edge). */
const MIN_JOG_MM = 0.01;

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

/** Shared jog controller used by both the jog pad and the Z bar: the shared step
 *  state, a one-shot step jog (`go`), a continuous hold jog
 *  (`startContinuous`/`stopContinuous`), and an arbitrary clamped Z move
 *  (`jogZBy`) for the Z-bar click-to-level. Every move is clamped to the work
 *  envelope (X∈[0,x], Y∈[0,y], Z∈[-z,0]) from the live machine position and runs
 *  at the jog feed (never a rapid). */
export function useJog() {
  const cnc = useSettings((s) => s.cncProfile);
  const connected = useMachine((s) => s.connected);
  const state = useMachine((s) => s.status.state);
  const enabled = canMove(state, connected);
  const step = useJogStep((s) => s.step);
  const setStep = useJogStep((s) => s.setStep);
  const continuous = step === "cont";

  // Step jog: one relative move per call, each axis clamped to the envelope from
  // the live mpos. No-op if every clamped axis is below the edge threshold.
  const go = useCallback(
    (dx: number, dy: number, dz: number) => {
      if (!enabled || typeof step !== "number") return;
      const mpos = useMachine.getState().status.mpos;
      const env = cnc.workEnvelopeMm;
      const ax = clampJogDelta(dx * step, mpos[0], 0, env.x);
      const ay = clampJogDelta(dy * step, mpos[1], 0, env.y);
      const az = clampJogDelta(dz * step, mpos[2], -env.z, 0);
      if (Math.abs(ax) < MIN_JOG_MM && Math.abs(ay) < MIN_JOG_MM && Math.abs(az) < MIN_JOG_MM) return;
      void api.machine.jog(ax, ay, az, cnc.jogFeedMmMin);
    },
    [enabled, step, cnc.jogFeedMmMin, cnc.workEnvelopeMm],
  );

  // Continuous jog: a single jog toward the envelope edge along the chosen
  // direction; the trailing jog-cancel on release stops it early. For diagonals
  // every active axis is clamped to the smallest available room so motion stays
  // on a true 45° line and never leaves the envelope.
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
      const env = cnc.workEnvelopeMm;
      const roomX = sx > 0 ? env.x - mpos[0] : sx < 0 ? mpos[0] : Infinity;
      const roomY = sy > 0 ? env.y - mpos[1] : sy < 0 ? mpos[1] : Infinity;
      const roomZ = sz > 0 ? 0 - mpos[2] : sz < 0 ? mpos[2] - -env.z : Infinity;
      const room = Math.min(
        sx !== 0 ? Math.max(0, roomX) : Infinity,
        sy !== 0 ? Math.max(0, roomY) : Infinity,
        sz !== 0 ? Math.max(0, roomZ) : Infinity,
      );
      if (!Number.isFinite(room) || room <= MIN_JOG_MM) return;
      moving = true;
      void api.machine.jog(sx * room, sy * room, sz * room, cnc.jogFeedMmMin);
    },
    [enabled, cnc.workEnvelopeMm, cnc.jogFeedMmMin],
  );

  const stopContinuous = useCallback(() => {
    if (!moving) return;
    moving = false;
    void api.machine.jogCancel();
  }, []);

  // Move Z by an arbitrary delta (mm) toward a target level, clamped to the
  // envelope from the live mpos, at the jog feed (feed-limited, never a rapid).
  // Backs the Z-bar click-to-level.
  const jogZBy = useCallback(
    (dz: number) => {
      if (!enabled) return;
      const mpos = useMachine.getState().status.mpos;
      const az = clampJogDelta(dz, mpos[2], -cnc.workEnvelopeMm.z, 0);
      if (Math.abs(az) < MIN_JOG_MM) return;
      void api.machine.jog(0, 0, az, cnc.jogFeedMmMin);
    },
    [enabled, cnc.workEnvelopeMm, cnc.jogFeedMmMin],
  );

  // Stop any in-flight continuous jog the moment motion becomes disallowed
  // (disconnect, alarm, …) so the machine never keeps running after the controls
  // go dead.
  useEffect(() => {
    if (!enabled && moving) stopContinuous();
  }, [enabled, stopContinuous]);

  return { enabled, step, setStep, continuous, go, startContinuous, stopContinuous, jogZBy };
}

import { api, type MachineStatus } from "@/lib/api";
import { useMachine } from "@/machineStore";
import { useBridgeListeners } from "@/hooks/useTauriListeners";

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

/** Drill-window machine follower. The drill window does NOT own the serial
 *  connection (the main window holds the telemetry Channel), so it can't use
 *  connect()/reattach() — that would steal the Channel. Instead it populates its
 *  own machineStore from the global broadcasts the backend emits for exactly this
 *  purpose: `machine://status` (full status), `machine://connected/disconnected`,
 *  and the main window's `machine://derived` relay for the JS-derived `homed` flag.
 *
 *  Writes go through setState/setStatus directly — never disconnect(), which would
 *  tear down the real connection the main window owns. Commands (jog, run, zero) are
 *  sent straight to the backend via invoke; those are process-global. */
export function useDrillMachineFollower(): void {
  useBridgeListeners(() => [
    api.machine.onStatus((s) => {
      // A status report implies the connection is live.
      useMachine.setState({ connected: true });
      useMachine.getState().setStatus({
        state: s.state,
        mpos: s.mpos,
        wpos: s.wpos,
        feed: s.feed,
        spindle: s.spindle,
        overrides: s.overrides,
        pins: s.pins,
      });
    }),
    api.machine.onConnected(() => useMachine.setState({ connected: true })),
    api.machine.onDisconnected(() =>
      useMachine.setState({ connected: false, status: IDLE_STATUS, homed: false }),
    ),
    api.onMachineDerived((d) =>
      // Patch only the fields present in this relay (soft-limit settings may be null
      // until the main window has read `$$`); `homed` is always sent.
      useMachine.setState({
        homed: d.homed,
        ...(d.softLimitsEnabled !== undefined ? { softLimitsEnabled: d.softLimitsEnabled } : {}),
        ...(d.maxTravelMm !== undefined ? { maxTravelMm: d.maxTravelMm } : {}),
      }),
    ),
  ]);
}

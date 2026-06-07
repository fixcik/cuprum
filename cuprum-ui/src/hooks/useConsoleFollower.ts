import { useEffect } from "react";
import { api, type MachineStatus } from "@/lib/api";
import { useMachine } from "@/machineStore";

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

/** Console-window machine follower. The console window does NOT own the serial
 *  connection (the main window holds the telemetry Channel), so it can't use
 *  connect()/reattach() — that would steal the Channel. Instead it:
 *
 *  1. On mount, subscribes to all live events (before the backlog fetch, so no
 *     lines are dropped in the gap).
 *  2. Fetches the backlog via `machine_console_backlog` and seeds the line store.
 *  3. Calls `onSeeded` once the backlog is fetched (even if empty) so the window
 *     can reveal itself regardless of whether the machine is connected.
 *
 *  Subscribes to:
 *  - `machine://line`   — live console line events → pushLine
 *  - `machine://status` — live status → setStatus + connected:true
 *  - `machine://connected` / `machine://disconnected`
 *
 *  This mirrors useDrillMachineFollower but adds the console line feed. */
export function useConsoleFollower(onSeeded: () => void): void {
  useEffect(() => {
    let active = true;
    const unlistens: Array<() => void> = [];

    void (async () => {
      // Subscribe to live line events FIRST, before the backlog fetch, so no lines
      // emitted between the fetch and the subscription are silently dropped.
      const lineUn = await api.machine.onLine((raw) => {
        if (!active) return;
        useMachine.getState().pushLine({ dir: raw.dir, text: raw.text });
      });
      if (!active) {
        lineUn();
        return;
      }
      unlistens.push(lineUn);

      const statusUn = await api.machine.onStatus((s) => {
        if (!active) return;
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
      });
      if (!active) {
        statusUn();
        return;
      }
      unlistens.push(statusUn);

      const connUn = await api.machine.onConnected(() => {
        if (active) useMachine.setState({ connected: true });
      });
      if (!active) {
        connUn();
        return;
      }
      unlistens.push(connUn);

      const discUn = await api.machine.onDisconnected(() => {
        if (!active) return;
        useMachine.setState({ connected: false, status: IDLE_STATUS, homed: false });
      });
      if (!active) {
        discUn();
        return;
      }
      unlistens.push(discUn);

      // Fetch the backlog now that all live-event listeners are registered. Lines
      // that arrive while awaiting are queued by the onLine listener above and will
      // be pushed after the backlog lines (slight duplication risk is harmless — the
      // backend's ring buffer and the live event converge quickly).
      let backlog: { dir: "rx" | "tx"; text: string }[] = [];
      try {
        backlog = await api.machine.consoleBacklog();
      } catch {
        // Non-fatal: the window still works from live events alone.
      }
      if (!active) return;

      // Seed the store: push each backlog line through pushLine, which stamps the
      // store-global monotonic seq + local ts. MAX_LINES = 500 matches the backend
      // ring buffer cap, so the slice will be at most 500 entries.
      const st = useMachine.getState();
      for (const raw of backlog) {
        st.pushLine({ dir: raw.dir as "rx" | "tx", text: raw.text });
      }

      // Signal the window that the backlog is ready (even if empty) so the loader
      // is dismissed and the window can reveal itself.
      if (active) onSeeded();
    })();

    return () => {
      active = false;
      for (const un of unlistens) un();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once; onSeeded is stable from useCallback
  }, []);
}

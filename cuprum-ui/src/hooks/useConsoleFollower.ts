import { useEffect } from "react";
import { api } from "@/lib/api";
import { useMachine } from "@/machineStore";

/** Console-window machine follower. The console window does NOT own the serial
 *  connection (the main window holds the telemetry Channel), so it can't use
 *  connect()/reattach() — that would steal the Channel. Instead it:
 *
 *  1. On mount, fetches the backlog via `machine_console_backlog` and seeds the
 *     line store FIRST.
 *  2. THEN subscribes to live events (line/status/connected/disconnected).
 *  3. Calls `onSeeded` once the backlog is fetched (even if empty) so the window
 *     can reveal itself regardless of whether the machine is connected.
 *
 *  Subscribes to:
 *  - `machine://line`   — live console line events → pushLine
 *  - `machine://status` — live status → setStatus + connected:true
 *  - `machine://connected` / `machine://disconnected`
 *
 *  Ordering tradeoff: backlog is pushed BEFORE subscribing to live events. This
 *  accepts a tiny gap (a couple of lines emitted during the ~ms backlog fetch may
 *  be missed) in exchange for never duplicating backlog lines with live ones — the
 *  alternative (subscribe first) would re-push lines already in the backlog and,
 *  under load, evict real history past the MAX_LINES cap. No backend dedup/seq is
 *  needed this way (machine.rs stays untouched).
 *
 *  This mirrors useDrillMachineFollower but adds the console line feed. */
export function useConsoleFollower(onSeeded: () => void): void {
  useEffect(() => {
    let active = true;
    const unlistens: Array<() => void> = [];

    void (async () => {
      // 1. Fetch + seed the backlog FIRST, so live lines never duplicate it.
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
      onSeeded();

      // 2. Subscribe to live events AFTER seeding the backlog.
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
        // Local reset only (the console window doesn't own the port) — reset() is
        // the single source of truth for clearing connection state, NOT disconnect().
        useMachine.getState().reset();
      });
      if (!active) {
        discUn();
        return;
      }
      unlistens.push(discUn);
    })();

    return () => {
      active = false;
      for (const un of unlistens) un();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once; onSeeded is stable from useCallback
  }, []);
}

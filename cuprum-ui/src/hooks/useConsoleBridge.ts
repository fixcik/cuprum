import { useEffect, useRef } from "react";
import { useMachine } from "@/machineStore";
import { api } from "@/lib/api";
import { linesSince } from "@/lib/consoleRelay";

/** Main-window side of the console relay. Mount once in App. Sends display data
 *  to the console window; the main store stays the single source of truth. */
export function useConsoleBridge(): void {
  const status = useMachine((s) => s.status);
  const lines = useMachine((s) => s.lines);
  const lastSeqRef = useRef(0);
  // Whether a console window is currently listening. Gates the live relay so we
  // don't push ~5 IPC/sec when no console window is open. Set true on
  // console:ready, false on console:closed (Rust Destroyed event).
  const activeRef = useRef(false);

  const snapshot = () => {
    const s = useMachine.getState();
    lastSeqRef.current = s.lines.length ? s.lines[s.lines.length - 1].seq : 0;
    return api.emitConsoleSnapshot({
      connected: s.connected,
      port: s.port,
      status: s.status,
      lines: s.lines,
      homingAvailable: s.homingAvailable,
      homed: s.homed,
      maxSpindleRpm: s.maxSpindleRpm,
    });
  };

  // Track liveness from the same authoritative signals the drawer stub uses, and
  // (re)seed a full snapshot on the ready handshake.
  useEffect(() => {
    const ps = [
      api.onConsoleReady(() => {
        activeRef.current = true;
        void snapshot();
      }),
      api.onConsoleClosed(() => {
        activeRef.current = false;
      }),
    ];
    return () => {
      ps.forEach((p) => void p.then((f) => f()));
    };
  }, []);

  // Live status updates (small payload). Skip when no console window is listening.
  useEffect(() => {
    if (!activeRef.current) return;
    void api.emitConsoleStatus(status);
  }, [status]);

  // Live line deltas (only lines newer than the last we sent). Skip when no
  // console window is listening.
  useEffect(() => {
    if (!activeRef.current) return;
    const tail = linesSince(lines, lastSeqRef.current);
    if (tail.length) {
      lastSeqRef.current = tail[tail.length - 1].seq;
      void api.emitConsoleLines(tail);
    }
  }, [lines]);
}

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

  // On the console window's ready handshake, (re)seed it with a full snapshot.
  useEffect(() => {
    const p = api.onConsoleReady(() => void snapshot());
    return () => {
      void p.then((f) => f());
    };
  }, []);

  // Live status updates (small payload).
  useEffect(() => {
    void api.emitConsoleStatus(status);
  }, [status]);

  // Live line deltas (only lines newer than the last we sent).
  useEffect(() => {
    const tail = linesSince(lines, lastSeqRef.current);
    if (tail.length) {
      lastSeqRef.current = tail[tail.length - 1].seq;
      void api.emitConsoleLines(tail);
    }
  }, [lines]);
}

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

/** Latest machine WORK position (mm), or null when none has arrived recently.
 *  Subscribes to the global `machine://status` event and auto-clears the
 *  position after `staleMs` of silence (e.g. the poller stopped on unplug), so
 *  the marker can hide instead of freezing. */
export function useMachinePosition(staleMs = 1000): { x: number; y: number } | null {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const sub = api.machine.onStatus((s) => {
      setPos({ x: s.wpos[0], y: s.wpos[1] });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setPos(null), staleMs);
    });
    return () => {
      void sub.then((un) => un());
      if (timer.current) clearTimeout(timer.current);
    };
  }, [staleMs]);

  return pos;
}

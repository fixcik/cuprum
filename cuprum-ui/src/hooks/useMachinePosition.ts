import { useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { api } from "@/lib/api";

/** Latest machine WORK position (mm), or null when none has arrived recently.
 *  Subscribes to the global `machine://status` event and auto-clears the
 *  position after `staleMs` of silence (e.g. the poller stopped on unplug), so
 *  the marker can hide instead of freezing. */
export function useMachinePosition(staleMs = 1000): { x: number; y: number; z: number } | null {
  const [pos, setPos] = useState<{ x: number; y: number; z: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // StrictMode-safe listener lifecycle (same as useBridgeListeners, but local
    // because this effect re-runs on `staleMs`): unlisten synchronously when
    // already resolved, or immediately upon a late resolve after cleanup.
    let active = true;
    let unlisten: UnlistenFn | null = null;
    void api.machine
      .onStatus((s) => {
        if (!active) return;
        setPos({ x: s.wpos[0], y: s.wpos[1], z: s.wpos[2] });
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setPos(null), staleMs);
      })
      .then((un) => {
        if (active) unlisten = un;
        else un();
      });
    return () => {
      active = false;
      unlisten?.();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [staleMs]);

  return pos;
}

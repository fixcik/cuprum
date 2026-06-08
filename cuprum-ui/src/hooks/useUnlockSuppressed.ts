import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

/** True for a short grace window after unlock ($X) is sent from ANY window, so the
 *  alarm banner can hide at once instead of waiting for the next status poll to
 *  confirm the cleared state. Self-correcting: once the grace window elapses, live
 *  machine state drives visibility again — if the alarm persisted (e.g. a stuck
 *  limit), the banner reappears. Listens to the global `machine://unlock` event, so
 *  pressing unlock in one window dismisses the banner in every window. */
export function useUnlockSuppressed(graceMs = 1000): boolean {
  const [suppressed, setSuppressed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const sub = api.machine.onUnlock(() => {
      setSuppressed(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setSuppressed(false), graceMs);
    });
    return () => {
      void sub.then((un) => un());
      if (timer.current) clearTimeout(timer.current);
    };
  }, [graceMs]);

  return suppressed;
}

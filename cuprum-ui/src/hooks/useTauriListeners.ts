import { useEffect, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";

/** Register a set of Tauri event listeners for the lifetime of the component and
 *  tear them down on unmount. `subscribe` runs once and returns the pending
 *  `Promise<UnlistenFn>` of each listener.
 *
 *  Cleanup is synchronous-safe: listeners that have already resolved are
 *  unlistened immediately, and any still in-flight is unlistened the moment it
 *  resolves (via the `active` flag). This avoids the StrictMode double-mount leak
 *  of the old `subs.forEach((p) => p.then((un) => un()))` cleanup, where the
 *  unlisten could register *after* the effect had already been torn down.
 *
 *  The main-window side of the inspector / add-design bridges uses this. */
export function useBridgeListeners(subscribe: () => Promise<UnlistenFn>[]) {
  useEffect(() => {
    let active = true;
    const unlistens: UnlistenFn[] = [];
    for (const p of subscribe()) {
      void p.then((un) => {
        if (active) unlistens.push(un);
        else un(); // effect already cleaned up → drop this listener at once
      });
    }
    return () => {
      active = false;
      for (const un of unlistens) un();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once; subscribe captures stable module fns
  }, []);
}

/** Subscribe a remote window to a single project snapshot, announcing readiness
 *  only *after* the listener is live (so the main window's reply can't beat it).
 *  Returns the latest snapshot (null until the first arrives).
 *
 *  Shared by the inspector and add-design windows. */
export function useSnapshotSubscription<T>(
  subscribe: (cb: (s: T) => void) => Promise<UnlistenFn>,
  emitReady: () => unknown,
): T | null {
  const [snap, setSnap] = useState<T | null>(null);
  useEffect(() => {
    let active = true;
    let unlisten: UnlistenFn | null = null;
    void subscribe((s) => {
      if (active) setSnap(s);
    }).then((un) => {
      if (!active) {
        un();
        return;
      }
      unlisten = un;
      void emitReady();
    });
    return () => {
      active = false;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once; args are stable module fns
  }, []);
  return snap;
}

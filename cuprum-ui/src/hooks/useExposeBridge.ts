import { useEffect, useRef } from "react";
import { useShell } from "@/shellStore";
import { api } from "@/lib/api";
import { useExposeScreenData } from "@/hooks/useExposeScreenData";
import { useBridgeListeners } from "@/hooks/useTauriListeners";

/** Main-window side of the expose bridge. Mount once in App. The expose window
 *  is a remote control: it gets the project as a snapshot and sends run commands
 *  directly via invoke. No machine relay is needed — exposure is printer-driven,
 *  not CNC. The pattern mirrors useDrillBridge but without the machine follower. */
export function useExposeBridge() {
  // Build the snapshot from main-window stores.
  const snap = useExposeScreenData();

  // Ref so the mount-time ready listener can push the latest snapshot without
  // re-binding on every change.
  const snapRef = useRef(snap);
  snapRef.current = snap;

  // Push the project snapshot whenever it changes.
  useEffect(() => {
    void api.emitExposeSnapshot(snap);
  }, [snap]);

  useBridgeListeners(() => [
    api.onExposeReady(() => {
      // Seed a freshly-opened window with the current snapshot.
      void api.emitExposeSnapshot(snapRef.current);
      // Hand off a pending "repeat run" prefill to the just-opened window (one-shot).
      const pending = useShell.getState().pendingExposePrefill;
      if (pending) {
        void api.emitExposePrefill(pending);
        useShell.getState().setPendingExposePrefill(null);
      }
    }),
  ]);
}

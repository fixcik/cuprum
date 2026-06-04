import { useEffect } from "react";
import { api } from "@/lib/api";
import { useMachine } from "@/machineStore";

/** Reconcile the live machine connection when the backend reports a drop. On
 *  `machine://disconnected` (incl. unplug, which the reader thread surfaces) we
 *  tear the Rust state down and reset the store, so the UI returns to
 *  "disconnected" even if the user navigated away from the Machine view. */
export function useMachineBridge() {
  useEffect(() => {
    const disc = api.machine.onDisconnected(() => {
      void useMachine.getState().disconnect();
    });
    const err = api.machine.onError((msg) => {
      useMachine.getState().pushLine({ dir: "rx", text: `error: ${msg}` });
    });
    return () => {
      void disc.then((un) => un());
      void err.then((un) => un());
    };
  }, []);
}

import { useEffect } from "react";
import { useMachine } from "@/machineStore";
import { api } from "@/lib/api";

/** Main-window side of the console bridge. Mount once in App.
 *
 *  The display relay (snapshot/status/lines) has been removed: the console window
 *  now follows the machine directly via the backend's global broadcasts
 *  (`machine://status`, `machine://line`, `machine://connected/disconnected`) —
 *  see useConsoleFollower. The bridge retains only:
 *
 *  - Intent consumers: connect/disconnect/home requests from the console window
 *    are executed here against the main-window store (which owns the Channel).
 *  - Drawer-stub tracking: console:ready / console:closed are observed so the
 *    main window knows whether the console OS window is open (for the stub). */
export function useConsoleBridge(): void {
  // Intent consumers: console window delegates connect/disconnect/home to the main
  // window because it must not own the telemetry Channel.
  useEffect(() => {
    const ps = [
      api.onConsoleConnect(({ port, baud }) => void useMachine.getState().connect(port, baud)),
      api.onConsoleDisconnect(() => void useMachine.getState().disconnect()),
      api.onConsoleHome(() => void useMachine.getState().runHoming()),
    ];
    return () => {
      void Promise.all(ps).then((fns) => fns.forEach((f) => f()));
    };
  }, []);
}

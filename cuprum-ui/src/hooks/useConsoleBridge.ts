import { useMachine } from "@/machineStore";
import { api } from "@/lib/api";
import { useBridgeListeners } from "@/hooks/useTauriListeners";

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
  // window because it must not own the telemetry Channel. useBridgeListeners gives
  // StrictMode-safe cleanup (each unlisten is stored as it resolves, so a fast
  // remount can't drop a listener whose promise hadn't resolved before teardown).
  useBridgeListeners(() => [
    api.onConsoleConnect(({ port, baud }) => void useMachine.getState().connect(port, baud)),
    api.onConsoleDisconnect(() => void useMachine.getState().disconnect()),
    api.onConsoleHome(() => void useMachine.getState().runHoming()),
  ]);
}

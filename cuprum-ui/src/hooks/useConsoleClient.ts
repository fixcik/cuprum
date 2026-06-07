import { useEffect } from "react";
import { api } from "@/lib/api";
import { useMachine } from "@/machineStore";

/** Console window side: seed the local read-model from the main window's relay
 *  (snapshot + live status + line deltas). Announces readiness only after all
 *  listeners are registered so the main window's reply can't beat them. */
export function useConsoleClient(): void {
  const seed = useMachine((s) => s.seedFromSnapshot);
  const setStatus = useMachine((s) => s.setStatus);
  const append = useMachine((s) => s.appendRelayLines);

  useEffect(() => {
    const uns: Array<Promise<() => void>> = [
      api.onConsoleSnapshot((s) => seed(s)),
      api.onConsoleStatus((st) => setStatus(st)),
      api.onConsoleLines((ls) => append(ls)),
    ];
    // Announce readiness AFTER listeners are registered so main's reply can't beat us.
    void Promise.all(uns).then(() => void api.emitConsoleReady());
    return () => {
      void Promise.all(uns).then((fns) => fns.forEach((f) => f()));
    };
  }, [seed, setStatus, append]);
}

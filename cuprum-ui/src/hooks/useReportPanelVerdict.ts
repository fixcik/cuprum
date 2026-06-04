import { useEffect, useRef } from "react";
import { useShell } from "@/shellStore";
import { api, type Verdict } from "@/lib/api";
import { profileHash } from "@/lib/profileHash";
import type { CapabilityProfile } from "@/lib/capabilityProfile";

const DEBOUNCE_MS = 800;

/**
 * Debounced side-effect: writes the panel verdict + profile hash to the recents
 * catalog whenever the verdict is fully resolved (all placed designs have sizes
 * and metrics). Skipped while `ready` is false so an incomplete verdict is never
 * persisted. Debounced so rapid panel edits don't hammer the DB.
 *
 * Designed as a standalone hook so PanelEditor stays a pure render concern.
 */
export function useReportPanelVerdict(
  verdict: Verdict,
  ready: boolean,
  profile: CapabilityProfile,
): void {
  const currentPath = useShell((s) => s.currentPath);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!ready || !currentPath) return;

    const hash = profileHash(profile);

    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      api.setRecentVerdict(currentPath, verdict, hash).catch(() => {
        // Best-effort: never surface catalog write errors to the user.
      });
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [verdict, ready, currentPath, profile]);
}

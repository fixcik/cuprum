import { useRef } from "react";
import { api } from "@/lib/api";
import { useBridgeListeners } from "@/hooks/useTauriListeners";
import type { DrillRoute } from "@/lib/drillRoute";
import { buildDrillTimingReport, type DrillTimingSample } from "@/lib/drillTimingTrace";

export interface DrillTimingTraceArgs {
  route: DrillRoute | null;
  groupMotionSecs: number[];
  /** Spindle feed override (%) — recorded in the report; actual time scales with it. */
  feedOverridePct: number;
}

/** Collects per-hole machine timings streamed by the backend and, when a run finishes,
 *  logs one structured actual-vs-estimated report to the webview console for estimate
 *  calibration (#615). No UI — opting out is just not mounting it. Mount once per run
 *  view (it owns its own Tauri listeners, separate from `useDrillRun`'s). */
export function useDrillTimingTrace(args: DrillTimingTraceArgs) {
  const samplesRef = useRef<DrillTimingSample[]>([]);
  // Keep the latest args without re-subscribing: listeners are registered once on mount.
  const argsRef = useRef(args);
  argsRef.current = args;

  useBridgeListeners(() => [
    api.drillRun.onProgress((p) => {
      // Only post-hole emits carry a measured time; pre-hole emits omit it.
      if (p.holeActualMs != null) {
        samplesRef.current.push({ holeIndex: p.holeIndex, actualMs: p.holeActualMs });
      }
    }),
    api.drillRun.onDone(() => {
      const { route, groupMotionSecs, feedOverridePct } = argsRef.current;
      if (route && samplesRef.current.length > 0) {
        const report = buildDrillTimingReport(
          samplesRef.current,
          route,
          groupMotionSecs,
          feedOverridePct,
        );
        // One-shot structured log the operator copies from the webview console.
        console.info("[drill-timing]", JSON.stringify(report));
      }
      samplesRef.current = [];
    }),
    // A stopped/errored run never reaches `done`; drop its partial samples so the next
    // run starts clean. A graceful stop emits `state: idle` (no `done`/`error`), so reset
    // on the idle/error terminal states too — otherwise leftover samples would corrupt
    // the next run's report.
    api.drillRun.onState((phase) => {
      if (phase === "idle" || phase === "error") {
        samplesRef.current = [];
      }
    }),
    api.drillRun.onError(() => {
      samplesRef.current = [];
    }),
  ]);
}

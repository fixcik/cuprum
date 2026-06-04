import { useEffect, useMemo, useRef, useState } from "react";
import { useShell } from "@/shellStore";
import { useSettings } from "@/settingsStore";
import { usePlacedBoardSizes } from "@/hooks/usePlacedBoardSizes";
import { api, type BoardMetrics } from "@/lib/api";
import { evaluate, overallVerdict, type Severity, type Verdict } from "@/lib/feasibility";
import { evaluatePanel, type PanelFinding } from "@/lib/panelFeasibility";
import { worseSeverity } from "@/lib/severity";

const EMPTY_NEVER: never[] = [];

/** Results of the panel-level feasibility check.
 *  All derived from `evaluatePanel` — the single source of truth for panel layout
 *  checks. Re-computed whenever the panel, sizes, profile, or design verdicts change. */
export interface PanelFindingsResult {
  findings: PanelFinding[];
  /** Overall panel verdict (block > warn > ok). */
  verdict: Verdict;
  /** Worst severity per instance id — for canvas highlight and inspector display. */
  byInstance: Map<string, Severity>;
}

/** Fetches board metrics (disk-cached) for every placed design, derives per-design
 *  verdicts, then runs `evaluatePanel` to produce panel-level findings.
 *  Memoized: only recomputes when inputs change. */
export function usePanelFindings(): PanelFindingsResult {
  const instances = useShell((s) => s.currentManifest?.panel?.instances ?? EMPTY_NEVER);
  const designs = useShell((s) => s.currentManifest?.designs ?? EMPTY_NEVER);
  const panel = useShell((s) => s.currentManifest?.panel ?? null);
  const stackup = useShell((s) => s.currentManifest?.stackup ?? null);
  const workingDir = useShell((s) => s.workingDir);
  const profile = useSettings((s) => s.profile);

  // Board sizes per design id (already fetched by usePlacedBoardSizes).
  const sizes = usePlacedBoardSizes();

  // Per-design board metrics (disk-cached), keyed by design id. Cached by design
  // CONTENT only; verdicts are derived from these against the CURRENT profile/panel/
  // stackup in a memo below, so a profile change re-evaluates without re-fetching.
  const [metricsMap, setMetricsMap] = useState<Record<string, BoardMetrics>>({});

  // Ref used to guard stale async updates (cancel on cleanup / dependency change).
  const cancelRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!workingDir) return;

    // Ids currently placed.
    const liveIds = new Set(instances.map((i) => i.design_id));

    // Fetch metrics for designs not yet resolved. Keyed by design content only —
    // NOT profile/panel/stackup (verdicts are derived from these metrics below).
    const needed = Array.from(liveIds).filter((id) => !(id in metricsMap));

    needed.forEach((id) => {
      const d = designs.find((x) => x.id === id);
      if (!d) return;
      cancelRef.current.delete(id); // allow fresh fetch
      api
        .projectBoardMetrics(
          workingDir,
          d.gerbers.map((g) => ({ rel: g.path, layerType: g.layer_type })),
        )
        .then((m) => {
          // If this id is no longer needed (unmounted or design removed), skip.
          if (cancelRef.current.has(id)) return;
          setMetricsMap((prev) => ({ ...prev, [id]: m.metrics }));
        })
        .catch(() => {});
    });

    // Prune stale entries (design no longer placed).
    setMetricsMap((prev) => {
      const entries = Object.entries(prev).filter(([id]) => liveIds.has(id));
      return entries.length === Object.keys(prev).length
        ? prev
        : Object.fromEntries(entries);
    });

    return () => {
      // Mark all current needed ids as cancelled so in-flight responses are ignored.
      needed.forEach((id) => cancelRef.current.add(id));
    };
    // metricsMap intentionally omitted (same fetch-and-prune pattern as usePlacedBoardSizes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingDir, instances, designs]);

  // Per-design verdict, derived from cached metrics against the CURRENT profile /
  // panel / stackup. Recomputes on a profile change without re-fetching metrics.
  const designVerdicts = useMemo((): Record<string, Verdict> => {
    const out: Record<string, Verdict> = {};
    for (const [id, m] of Object.entries(metricsMap)) {
      out[id] = overallVerdict(evaluate(m, profile, panel, stackup));
    }
    return out;
  }, [metricsMap, profile, panel, stackup]);

  // Run evaluatePanel with all resolved inputs.
  const findings = useMemo((): PanelFinding[] => {
    if (!panel) return [];
    return evaluatePanel({ panel, sizes, profile, designVerdicts });
  }, [panel, sizes, profile, designVerdicts]);

  // Overall verdict from the findings.
  const verdict = useMemo((): Verdict => overallVerdict(findings), [findings]);

  // Per-instance worst severity, for canvas highlight and inspector display.
  const byInstance = useMemo((): Map<string, Severity> => {
    const map = new Map<string, Severity>();
    for (const f of findings) {
      for (const id of f.instanceIds) {
        map.set(id, worseSeverity(map.get(id), f.severity));
      }
    }
    return map;
  }, [findings]);

  return { findings, verdict, byInstance };
}

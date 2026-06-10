import { api, type BoardMetricsResult, type LayerType } from "@/lib/api";

/** Gerber reference as passed to `project_board_metrics`. */
export type GerberRef = { rel: string; layerType: LayerType };

type FetchMetrics = (
  workingDir: string,
  refs: GerberRef[],
  traceSession?: number,
) => Promise<BoardMetricsResult>;

/** Entry budget: comfortably above the designs-per-project count so panel-wide
 *  sweeps (verdicts + sizes + drill origins) never thrash the cache. */
const MAX_ENTRIES = 32;

/** Single-flight promise cache over `project_board_metrics`. The Rust side
 *  already disk-caches the computation by content; this layer removes the
 *  repeated IPC round-trips (a full BoardMetrics is hundreds of KB) when
 *  several hooks ask for the same design in one layout cycle.
 *
 *  - Concurrent callers of one key await the same in-flight promise.
 *  - `fresh` is delivered as-is to everyone awaiting the original computation;
 *    later cache hits get `fresh: false` — exactly what a repeat invoke would
 *    have returned from the Rust disk cache — so artifact flushes are not
 *    scheduled twice.
 *  - A rejected fetch is dropped from the cache (callers keep their own
 *    fallbacks; the next call retries).
 *  - `traceSession` (import-time tracing) bypasses the cache so traces see a
 *    real invoke.
 *  - Switching `workingDir` clears the cache (design ids/paths are sequential
 *    per project — same guard as the holes cache in useDrillPlan). */
export function createMetricsCache(fetch: FetchMetrics) {
  const entries = new Map<string, Promise<BoardMetricsResult>>();
  const settled = new Set<string>();
  let lastWorkingDir: string | null = null;

  const keyOf = (workingDir: string, refs: GerberRef[]) =>
    `${workingDir}\n${refs.map((r) => `${r.rel}:${r.layerType}`).join(",")}`;

  const get = (
    workingDir: string,
    refs: GerberRef[],
    traceSession?: number,
  ): Promise<BoardMetricsResult> => {
    if (traceSession != null) return fetch(workingDir, refs, traceSession);
    if (workingDir !== lastWorkingDir) {
      entries.clear();
      settled.clear();
      lastWorkingDir = workingDir;
    }
    const key = keyOf(workingDir, refs);
    const hit = entries.get(key);
    if (hit) {
      // LRU touch: re-insert so the oldest key stays first in iteration order.
      entries.delete(key);
      entries.set(key, hit);
      return settled.has(key) ? hit.then((r) => ({ ...r, fresh: false })) : hit;
    }
    const p: Promise<BoardMetricsResult> = fetch(workingDir, refs).then(
      (r) => {
        // Guard against the entry having been evicted and re-created meanwhile.
        if (entries.get(key) === p) settled.add(key);
        return r;
      },
      (e) => {
        if (entries.get(key) === p) {
          entries.delete(key);
          settled.delete(key);
        }
        throw e;
      },
    );
    entries.set(key, p);
    if (entries.size > MAX_ENTRIES) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) {
        entries.delete(oldest);
        settled.delete(oldest);
      }
    }
    return p;
  };

  const clear = () => {
    entries.clear();
    settled.clear();
  };

  return { get, clear };
}

/** App-wide cache instance. Each webview (main window, drill window) gets its
 *  own module copy — dedup happens within a window, which is where the
 *  duplicate calls live. */
export const metricsCache = createMetricsCache((wd, refs, ts) => api.projectBoardMetrics(wd, refs, ts));

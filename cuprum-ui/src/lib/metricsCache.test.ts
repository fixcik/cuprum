import { describe, it, expect, vi } from "vitest";
import { createMetricsCache, type GerberRef } from "@/lib/metricsCache";
import type { BoardMetricsResult } from "@/lib/api";

/** Minimal fake result — the cache treats it opaquely apart from `fresh`. */
const result = (tag: string, fresh = true) =>
  ({ metrics: { tag } as unknown, fresh }) as unknown as BoardMetricsResult;

const REFS: GerberRef[] = [
  { rel: "design-1/edge.gbr", layerType: "edgeCuts" },
  { rel: "design-1/top.gbr", layerType: "topCopper" },
];
const OTHER_REFS: GerberRef[] = [{ rel: "design-2/top.gbr", layerType: "topCopper" }];

describe("metricsCache", () => {
  it("deduplicates concurrent calls for one key into a single fetch", async () => {
    let resolve!: (r: BoardMetricsResult) => void;
    const fetch = vi.fn(() => new Promise<BoardMetricsResult>((res) => (resolve = res)));
    const cache = createMetricsCache(fetch);

    const p1 = cache.get("/proj", REFS);
    const p2 = cache.get("/proj", REFS);
    expect(fetch).toHaveBeenCalledTimes(1);

    resolve(result("a"));
    const [r1, r2] = await Promise.all([p1, p2]);
    // Both awaiters of the original computation see the genuine fresh flag.
    expect(r1.fresh).toBe(true);
    expect(r2.fresh).toBe(true);
  });

  it("serves later hits from cache with fresh:false", async () => {
    const fetch = vi.fn(async () => result("a", true));
    const cache = createMetricsCache(fetch);

    const first = await cache.get("/proj", REFS);
    expect(first.fresh).toBe(true);

    const second = await cache.get("/proj", REFS);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(second.fresh).toBe(false);
    expect(second.metrics).toBe(first.metrics);
  });

  it("keys by gerber set — different refs fetch independently", async () => {
    const fetch = vi.fn(async (_wd: string, refs: GerberRef[]) => result(refs[0].rel));
    const cache = createMetricsCache(fetch);

    await cache.get("/proj", REFS);
    await cache.get("/proj", OTHER_REFS);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not cache a rejected fetch — the next call retries", async () => {
    const fetch = vi
      .fn<(wd: string, refs: GerberRef[]) => Promise<BoardMetricsResult>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(result("ok"));
    const cache = createMetricsCache(fetch);

    await expect(cache.get("/proj", REFS)).rejects.toThrow("boom");
    const r = await cache.get("/proj", REFS);
    expect(r.fresh).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("clears the cache when workingDir changes", async () => {
    const fetch = vi.fn(async () => result("a"));
    const cache = createMetricsCache(fetch);

    await cache.get("/proj-a", REFS);
    await cache.get("/proj-b", REFS);
    // Back to the first project: its entry was dropped on the switch.
    await cache.get("/proj-a", REFS);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("bypasses the cache when traceSession is set", async () => {
    const fetch = vi.fn(async () => result("a"));
    const cache = createMetricsCache(fetch);

    await cache.get("/proj", REFS, 7);
    await cache.get("/proj", REFS, 7);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith("/proj", REFS, 7);

    // A traced call neither reads nor populates the cache.
    await cache.get("/proj", REFS);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("evicts the least-recently-used entry beyond the cap", async () => {
    const fetch = vi.fn(async (_wd: string, refs: GerberRef[]) => result(refs[0].rel));
    const cache = createMetricsCache(fetch);
    const refsOf = (i: number): GerberRef[] => [{ rel: `design-${i}/top.gbr`, layerType: "topCopper" }];

    // Fill to the cap (32), then touch entry 0 so it becomes most-recent.
    for (let i = 0; i < 32; i++) await cache.get("/proj", refsOf(i));
    await cache.get("/proj", refsOf(0));
    expect(fetch).toHaveBeenCalledTimes(32);

    // One more key evicts the oldest (entry 1, not the touched entry 0).
    await cache.get("/proj", refsOf(32));
    await cache.get("/proj", refsOf(0)); // still cached
    expect(fetch).toHaveBeenCalledTimes(33);
    await cache.get("/proj", refsOf(1)); // evicted → refetch
    expect(fetch).toHaveBeenCalledTimes(34);
  });

  it("clear() drops everything", async () => {
    const fetch = vi.fn(async () => result("a"));
    const cache = createMetricsCache(fetch);

    await cache.get("/proj", REFS);
    cache.clear();
    await cache.get("/proj", REFS);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

import { create } from "zustand";
import { api } from "@/lib/api";
import { useShell } from "@/shellStore";
import { serializePack, isPackInFlight, markFlushDirty } from "@/lib/projectPack";

/** Debounce window before flushing freshly-computed artifacts into the .cuprum. */
const ARTIFACT_FLUSH_MS = 1500;
let _flushTimer: ReturnType<typeof setTimeout> | null = null;

interface ArtifactsStore {
  /** Per-design artifact-prep progress (0..1), keyed by designId. */
  artifactProgress: Record<string, number>;
  /** Ephemeral opaque trace-session token per newly-imported design, keyed by
   *  designId. Set at import time; absent for designs opened from disk. Not
   *  persisted — an in-memory u32 has no meaning across launches. */
  traceSessions: Record<string, number>;
  /** Number of ZIP paths currently being imported (incremented per-path at start,
   *  decremented in finally). Drives the importing spinner on the designs tab. */
  importingCount: number;

  /** Schedule a debounced repack to flush freshly-computed artifacts into the
   *  .cuprum. No-op when `fresh` is false (artifact was served from cache). */
  scheduleArtifactFlush: (fresh: boolean) => void;
  /** A card reports its ring fraction; store keeps the map for the global chip. */
  reportArtifactProgress: (designId: string, fraction: number) => void;
  /** Drop progress entries for designs no longer in the manifest (and on close). */
  pruneArtifactProgress: (liveIds: string[]) => void;
  /** Remove one design's progress entry — e.g. its card unmounted mid-prep, so
   *  the global chip shouldn't freeze at that design's partial fraction. */
  clearArtifactProgress: (designId: string) => void;
  /** Drop all per-session artifact state. Called on project switch so trace
   *  tokens, progress, and import counters don't leak across projects (design
   *  ids are reused, so a stale trace token would mis-group a fresh import). */
  reset: () => void;
}

export const useArtifacts = create<ArtifactsStore>((set) => ({
  artifactProgress: {},
  traceSessions: {},
  importingCount: 0,

  scheduleArtifactFlush: (fresh) => {
    if (!fresh) return;
    const { workingDir, currentPath } = useShell.getState();
    if (!workingDir || !currentPath) return;
    // If a repack is already queued/running, just mark dirty and exit.  Once the
    // pack queue drains, serializePack will fire exactly one trailing flush so
    // freshly-computed artifacts are not lost.  This collapses N concurrent flush
    // requests into ≤2 actual api.saveProject calls.
    if (isPackInFlight()) {
      markFlushDirty();
      return;
    }
    const path = currentPath;
    if (_flushTimer) clearTimeout(_flushTimer);
    _flushTimer = setTimeout(() => {
      _flushTimer = null;
      const s = useShell.getState();
      if (s.currentPath !== path || !s.workingDir) return; // project changed/closed
      const wd = s.workingDir;
      void serializePack(() => api.saveProject(wd, path)).catch(() => {
        /* best-effort; the next fresh artifact reschedules */
      });
    }, ARTIFACT_FLUSH_MS);
  },

  reportArtifactProgress: (designId, fraction) => {
    set((s) => ({ artifactProgress: { ...s.artifactProgress, [designId]: fraction } }));
  },
  pruneArtifactProgress: (liveIds) => {
    set((s) => {
      const live = new Set(liveIds);
      const next: Record<string, number> = {};
      for (const [id, f] of Object.entries(s.artifactProgress)) {
        if (live.has(id)) next[id] = f;
      }
      return { artifactProgress: next };
    });
  },
  clearArtifactProgress: (designId) => {
    set((s) => {
      if (!(designId in s.artifactProgress)) return s;
      const next = { ...s.artifactProgress };
      delete next[designId];
      return { artifactProgress: next };
    });
  },

  reset: () => set({ artifactProgress: {}, traceSessions: {}, importingCount: 0 }),
}));

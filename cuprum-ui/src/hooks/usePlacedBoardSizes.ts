import { useEffect, useState } from "react";
import { useShell } from "@/shellStore";
import { api } from "@/lib/api";

const EMPTY: never[] = [];

/** Resolved board extents (mm) keyed by design id for every placed instance.
 *  Fetched via cached project metrics (disk-cached, so the calls are cheap) once
 *  per referenced design within a consumer; pruned when a design is no longer
 *  placed. Extracted to keep the canvas render and the editor's clamp / off-panel
 *  checks on one fetch-and-prune implementation instead of two copies. */
export function usePlacedBoardSizes(): Record<string, { w: number; h: number }> {
  const instances = useShell((s) => s.currentManifest?.panel?.instances ?? EMPTY);
  const designs = useShell((s) => s.currentManifest?.designs ?? EMPTY);
  const workingDir = useShell((s) => s.workingDir);
  const [sizes, setSizes] = useState<Record<string, { w: number; h: number }>>({});

  useEffect(() => {
    if (!workingDir) return;
    const needed = Array.from(new Set(instances.map((i) => i.design_id))).filter((id) => !sizes[id]);
    let cancelled = false;
    needed.forEach((id) => {
      const d = designs.find((x) => x.id === id);
      if (!d) return;
      api
        .projectBoardMetrics(
          workingDir,
          d.gerbers.map((g) => ({ rel: g.path, layerType: g.layer_type })),
        )
        .then((m) => {
          if (cancelled) return;
          setSizes((prev) => ({ ...prev, [id]: { w: m.metrics.board.widthMm, h: m.metrics.board.heightMm } }));
        })
        .catch(() => {});
    });
    const liveIds = new Set(instances.map((i) => i.design_id));
    setSizes((prev) => {
      const entries = Object.entries(prev).filter(([id]) => liveIds.has(id));
      return entries.length === Object.keys(prev).length ? prev : Object.fromEntries(entries);
    });
    return () => {
      cancelled = true;
    };
    // `sizes` intentionally omitted: including it would re-run the effect on every
    // fetch completion, re-issuing redundant metrics calls. We read it inside only
    // to skip already-known ids, which the prune step keeps consistent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingDir, instances, designs]);

  return sizes;
}

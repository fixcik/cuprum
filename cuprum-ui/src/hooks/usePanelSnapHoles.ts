import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useShell } from "@/shellStore";
import { metricsCache } from "@/lib/metricsCache";
import { collectDesignHoles, projectHoleToPanel, type LocalHole } from "@/lib/panelDrill";
import type { HoleCandidate } from "@/lib/alignmentPoints";

const EMPTY: never[] = [];

/** Snap candidates for the alignment-point tool: every physical hole on the
 *  panel in panel coordinates — tooling holes plus the drill holes of every
 *  placed design instance. Design holes are fetched lazily (only while
 *  `enabled`) via the same cached path as the drill plan (metrics origin +
 *  readDrill), cached per design id, and re-projected on placement changes. */
export function usePanelSnapHoles(
  enabled: boolean,
  sizes: Record<string, { w: number; h: number }>,
): HoleCandidate[] {
  const instances = useShell((s) => s.currentManifest?.panel?.instances ?? EMPTY);
  const toolingHoles = useShell((s) => s.currentManifest?.panel?.tooling_holes ?? EMPTY);
  const designs = useShell((s) => s.currentManifest?.designs ?? EMPTY);
  const workingDir = useShell((s) => s.workingDir);

  // Per-design local holes, cached across tool activations. Bump `version` when
  // a fetch lands so the projected list recomputes.
  const holesCache = useRef<Map<string, LocalHole[]>>(new Map());
  const lastWorkingDir = useRef<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!enabled || !workingDir) return;
    // Design ids are sequential per project — drop the cache on project change.
    if (workingDir !== lastWorkingDir.current) {
      holesCache.current.clear();
      lastWorkingDir.current = workingDir;
    }
    let cancelled = false;
    const needed = Array.from(new Set(instances.map((i) => i.design_id))).filter(
      (id) => !holesCache.current.has(id),
    );
    needed.forEach((designId) => {
      void (async () => {
        const design = designs.find((d) => d.id === designId);
        const drillLayers = design?.gerbers.filter((g) => g.layer_type === "drill") ?? [];
        if (!design || drillLayers.length === 0) {
          holesCache.current.set(designId, []);
          return;
        }
        // Outline origin from cached board metrics (0,0 when unavailable).
        let originXMm = 0;
        let originYMm = 0;
        try {
          const m = await metricsCache.get(
            workingDir,
            design.gerbers.map((g) => ({ rel: g.path, layerType: g.layer_type })),
          );
          if (m.metrics.board.hasEdgeLayer) {
            originXMm = m.metrics.board.originXMm;
            originYMm = m.metrics.board.originYMm;
          }
        } catch {
          /* origin stays 0,0 */
        }
        const holesAbs = (
          await Promise.all(
            drillLayers.map(async (g) => {
              try {
                return await api.readDrill(workingDir, g.path);
              } catch {
                return [];
              }
            }),
          )
        ).flat();
        if (cancelled) return;
        holesCache.current.set(designId, collectDesignHoles(holesAbs, originXMm, originYMm));
        setVersion((v) => v + 1);
      })();
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, workingDir, instances, designs]);

  return useMemo(() => {
    if (!enabled) return [];
    const out: HoleCandidate[] = toolingHoles.map((h) => ({
      xMm: h.x_mm,
      yMm: h.y_mm,
      diameterMm: h.diameter_mm,
    }));
    for (const inst of instances) {
      const local = holesCache.current.get(inst.design_id);
      const sz = sizes[inst.design_id];
      if (!local || !sz) continue;
      for (const h of local) {
        const p = projectHoleToPanel(h, inst, sz.w, sz.h);
        out.push({ xMm: p.xMm, yMm: p.yMm, diameterMm: h.dMm });
      }
    }
    return out;
    // `version` invalidates the memo when a lazy per-design fetch lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, toolingHoles, instances, sizes, version]);
}

import { useEffect, useRef, useState } from "react";
import { api, type DrillSnapshot, type DrillClass } from "@/lib/api";
import { metricsCache } from "@/lib/metricsCache";
import { collectDesignHoles, buildPanelDrillPlan, type LocalHole } from "@/lib/panelDrill";
import type { PanelDrillPlan } from "@/lib/panelDrill";
export interface DrillPlanResult {
  plan: PanelDrillPlan | null;
  loading: boolean;
}

/** Build the full PanelDrillPlan from a DrillSnapshot.
 *  Fetches drill holes and origin metrics per design (cached), then combines
 *  into the plan. Route computation is the caller's responsibility (DrillWindow).
 *  Returns loading=true while async work is in flight.
 *  Guards against stale async results via cancel flag. */
export function useDrillPlan(snapshot: DrillSnapshot | null): DrillPlanResult {
  const [result, setResult] = useState<DrillPlanResult>({ plan: null, loading: false });

  // Per-design holes cache: avoids re-fetching the same design across snapshots.
  // Keyed by design_id; stored in a ref (not state) so updates don't retrigger the effect.
  const holesCache = useRef<Map<string, LocalHole[]>>(new Map());
  // Design IDs are sequential PER PROJECT (design-1, design-2, …), not globally
  // unique. Clear the cache when the working dir changes so a new project's
  // design-1 doesn't serve the old project's design-1 holes.
  const lastWorkingDir = useRef<string | null>(null);

  useEffect(() => {
    if (!snapshot?.workingDir || !snapshot.manifest?.panel) {
      setResult({ plan: null, loading: false });
      return;
    }

    const { workingDir, manifest, placedSizes, tools, viaMaxDiameterMm, drillBitToleranceMm } =
      snapshot;
    const panel = manifest.panel!;
    let cancelled = false;

    if (workingDir !== lastWorkingDir.current) {
      holesCache.current.clear();
      lastWorkingDir.current = workingDir;
    }

    setResult((prev) => ({ ...prev, loading: true }));

    (async () => {
      try {
        // Collect unique design_ids from placed instances.
        const uniqueDesignIds = Array.from(new Set(panel.instances.map((i) => i.design_id)));

        // For each design not already cached, fetch drill holes + origin.
        await Promise.all(
          uniqueDesignIds.map(async (designId) => {
            if (holesCache.current.has(designId)) return;

            const design = manifest.designs.find((d) => d.id === designId);
            if (!design) {
              holesCache.current.set(designId, []);
              return;
            }

            // Find all drill layers for this design.
            const drillLayers = design.gerbers.filter((g) => g.layer_type === "drill");
            if (drillLayers.length === 0) {
              holesCache.current.set(designId, []);
              return;
            }

            // Get the design's outline origin via board metrics.
            // Fall back to 0,0 if the design has no edge layer or metrics fail.
            let originXMm = 0;
            let originYMm = 0;
            try {
              const metricsResult = await metricsCache.get(
                workingDir,
                design.gerbers.map((g) => ({ rel: g.path, layerType: g.layer_type })),
              );
              if (metricsResult.metrics.board.hasEdgeLayer) {
                originXMm = metricsResult.metrics.board.originXMm;
                originYMm = metricsResult.metrics.board.originYMm;
              }
            } catch {
              // No edge layer or metrics unavailable — origin stays 0,0.
            }

            if (cancelled) return;

            // Read holes from each drill layer and combine.
            const allHolesAbs = (
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

            const localHoles = collectDesignHoles(allHolesAbs, originXMm, originYMm);
            holesCache.current.set(designId, localHoles);
          }),
        );

        if (cancelled) return;

        // Build plan using the populated cache.
        const sizes = new Map(Object.entries(placedSizes));
        const zones = (panel.keep_out_zones ?? []).map((z) => ({
          x: z.x_mm,
          y: z.y_mm,
          w: z.width_mm,
          h: z.height_mm,
        }));
        // Apply per-diameter class overrides stored in the panel manifest.
        const overrides = new Map<string, DrillClass>(Object.entries(panel.drill_class_overrides ?? {}));
        const plan = buildPanelDrillPlan(panel, holesCache.current, sizes, tools, {
          viaMaxDiameterMm,
          drillBitToleranceMm,
        }, zones, overrides);

        if (!cancelled) {
          setResult({ plan, loading: false });
        }
      } catch {
        if (!cancelled) {
          setResult({ plan: null, loading: false });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  // Re-run when the snapshot identity changes. The snapshot carries tools/DFM
  // thresholds (pushed live from the main window), so a fresh snapshot on a
  // settings edit re-runs the plan without a window restart.
  }, [snapshot]);

  return result;
}

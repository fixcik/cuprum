import { useEffect, useRef, useState } from "react";
import { api, type DrillSnapshot } from "@/lib/api";
import { useSettings } from "@/settingsStore";
import { collectDesignHoles, buildPanelDrillPlan, type LocalHole } from "@/lib/panelDrill";
import { planDrillRoute, type DrillRoute } from "@/lib/drillRoute";
import type { PanelDrillPlan } from "@/lib/panelDrill";

export interface DrillPlanResult {
  plan: PanelDrillPlan | null;
  route: DrillRoute | null;
  loading: boolean;
}

/** Build the real PanelDrillPlan + DrillRoute from a DrillSnapshot.
 *  Fetches drill holes and origin metrics per design (cached), then combines
 *  into the plan and route. Returns loading=true while async work is in flight.
 *  Guards against stale async results via cancel flag. */
export function useDrillPlan(snapshot: DrillSnapshot | null): DrillPlanResult {
  const tools = useSettings((s) => s.tools);
  const viaMaxDiameterMm = useSettings((s) => s.profile.viaMaxDiameterMm);
  const drillBitToleranceMm = useSettings((s) => s.profile.drillBitToleranceMm);

  const [result, setResult] = useState<DrillPlanResult>({ plan: null, route: null, loading: false });

  // Per-design holes cache: avoids re-fetching the same design across snapshots.
  // Keyed by design_id; stored in a ref (not state) so updates don't retrigger the effect.
  const holesCache = useRef<Map<string, LocalHole[]>>(new Map());

  useEffect(() => {
    if (!snapshot?.workingDir || !snapshot.manifest?.panel) {
      setResult({ plan: null, route: null, loading: false });
      return;
    }

    const { workingDir, manifest, placedSizes } = snapshot;
    const panel = manifest.panel!;
    let cancelled = false;

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
              const metricsResult = await api.projectBoardMetrics(
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
        const plan = buildPanelDrillPlan(panel, holesCache.current, sizes, tools, {
          viaMaxDiameterMm,
          drillBitToleranceMm,
        });

        const route = planDrillRoute(plan, { xMm: 0, yMm: panel.height_mm });

        if (!cancelled) {
          setResult({ plan, route, loading: false });
        }
      } catch {
        if (!cancelled) {
          setResult({ plan: null, route: null, loading: false });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  // Re-run when the snapshot identity changes or the tool/profile settings change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, tools, viaMaxDiameterMm, drillBitToleranceMm]);

  return result;
}

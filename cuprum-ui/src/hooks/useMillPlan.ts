import { useEffect, useRef, useState } from "react";
import {
  api,
  type MillSnapshot,
  type MillPlanInput,
  type MillPlanResult,
  type MillDesignInput,
  type MillInstanceInput,
  type Hole,
} from "@/lib/api";
import { metricsCache } from "@/lib/metricsCache";

/** Cut parameters the editor controls feed into the plan. Kept separate from the
 *  snapshot so a control tweak re-plans without a new snapshot. */
export interface MillCutParams {
  cutWidthMm: number;
  passes: number;
  overlap: number;
  climb: boolean;
  cutDepthMm: number;
  depthPerPassMm: number | null;
  feedXyMmMin: number;
  plungeMmMin: number;
}

/** Extent (mm) of the PANEL being milled — drives the preview canvas (world size)
 *  and the datum flip. Panel-wide: this is the whole panel, not a single design. */
export interface MillExtent {
  widthMm: number;
  heightMm: number;
}

export interface MillPlanState {
  result: MillPlanResult | null;
  extent: MillExtent | null;
  /** Whether a millable source (≥1 placed design with a top-copper gerber) was found. */
  hasSource: boolean;
  loading: boolean;
}

const EMPTY: MillPlanState = { result: null, extent: null, hasSource: false, loading: false };

/** Per-design source resolved once and reused across instances. */
interface DesignSource {
  gerberRel: string;
  holes: Hole[];
  originXMm: number;
  originYMm: number;
  boardWMm: number;
  boardHMm: number;
}

/** Does the panel reference at least one placed design that has a top-copper gerber? */
function hasMillableSource(snapshot: MillSnapshot): boolean {
  const panel = snapshot.manifest?.panel;
  if (!panel || !snapshot.manifest) return false;
  const placedIds = new Set(panel.instances.map((i) => i.design_id));
  return snapshot.manifest.designs.some(
    (d) => placedIds.has(d.id) && d.gerbers.some((g) => g.layer_type === "topCopper"),
  );
}

/** Build the PANEL-WIDE isolation-milling plan from a MillSnapshot + the editor's
 *  cut params. Mirrors useDrillPlan: walk every placed instance, resolve each
 *  referenced design's top-copper gerber + drill holes + extent (cached per design),
 *  then call the Rust `mill_plan` command which isolates each design once and
 *  projects its toolpaths into panel space per instance. All heavy geometry is in
 *  Rust — this only marshals designs[]/instances[] and guards against stale async
 *  results. Debounced via the stringified input so a control tweak refetches at most
 *  once per change. */
export function useMillPlan(snapshot: MillSnapshot | null, params: MillCutParams): MillPlanState {
  const [state, setState] = useState<MillPlanState>(EMPTY);

  // Per-design source cache, keyed by design_id (cleared when the working dir changes
  // since design ids are sequential per project).
  const sourceCache = useRef<Map<string, DesignSource | null>>(new Map());
  const lastWorkingDir = useRef<string | null>(null);

  // Debounce key: only re-fire on a real change (workingDir + panel layout + params
  // + datum + cnc). The panel layout is captured by instances + width/height.
  const panel = snapshot?.manifest?.panel ?? null;
  const inputKey =
    snapshot?.workingDir && panel && snapshot.cncProfile && hasMillableSource(snapshot)
      ? JSON.stringify([
          snapshot.workingDir,
          panel.instances,
          panel.width_mm,
          panel.height_mm,
          panel.keep_out_zones,
          params,
          snapshot.millDatumCorner,
          snapshot.cncProfile,
        ])
      : null;

  useEffect(() => {
    if (!snapshot?.workingDir || !panel || !snapshot.cncProfile || !hasMillableSource(snapshot)) {
      setState(EMPTY);
      return;
    }
    const { workingDir, manifest, cncProfile, millDatumCorner, placedSizes } = snapshot;

    if (workingDir !== lastWorkingDir.current) {
      sourceCache.current.clear();
      lastWorkingDir.current = workingDir;
    }

    let cancelled = false;
    setState((prev) => ({ ...prev, hasSource: true, loading: true }));

    (async () => {
      try {
        // Resolve each unique placed design's source (gerber + holes + origin + extent),
        // caching per design_id so repeated instances don't refetch.
        const uniqueDesignIds = Array.from(new Set(panel.instances.map((i) => i.design_id)));
        await Promise.all(
          uniqueDesignIds.map(async (designId) => {
            if (sourceCache.current.has(designId)) return;

            const design = manifest?.designs.find((d) => d.id === designId);
            const copper = design?.gerbers.find((g) => g.layer_type === "topCopper");
            if (!design || !copper) {
              sourceCache.current.set(designId, null);
              return;
            }

            // Extent: prefer the panel's placed size; fall back to board metrics.
            // Origin: from board metrics (the copper gerber is in absolute coords, so
            // the backend needs the bbox min corner to shift to board-local). Falls
            // back to 0,0 when there's no edge layer.
            let originXMm = 0;
            let originYMm = 0;
            let boardWMm = placedSizes[designId]?.w ?? 0;
            let boardHMm = placedSizes[designId]?.h ?? 0;
            try {
              const m = await metricsCache.get(
                workingDir,
                design.gerbers.map((g) => ({ rel: g.path, layerType: g.layer_type })),
              );
              if (m.metrics.board.hasEdgeLayer) {
                originXMm = m.metrics.board.originXMm;
                originYMm = m.metrics.board.originYMm;
              }
              if (!boardWMm) boardWMm = m.metrics.board.widthMm;
              if (!boardHMm) boardHMm = m.metrics.board.heightMm;
            } catch {
              // No edge layer / metrics unavailable — origin stays 0,0, sizes from placedSizes.
            }
            if (cancelled) return;

            // Drill holes for this design (raw gerber coords — same frame as the copper
            // gerber), subtracted from the copper so rings don't cross holes.
            const drillLayers = design.gerbers.filter((g) => g.layer_type === "drill");
            const holes = (
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

            sourceCache.current.set(designId, {
              gerberRel: copper.path,
              holes,
              originXMm,
              originYMm,
              boardWMm,
              boardHMm,
            });
          }),
        );
        if (cancelled) return;

        // Build the deduped designs[] (index map) and the instances[] referencing it.
        const designs: MillDesignInput[] = [];
        const designIndex = new Map<string, number>();
        for (const id of uniqueDesignIds) {
          const src = sourceCache.current.get(id);
          if (!src) continue; // design has no top-copper gerber → not millable
          designIndex.set(id, designs.length);
          designs.push({
            gerberRel: src.gerberRel,
            holes: src.holes,
            originXMm: src.originXMm,
            originYMm: src.originYMm,
            boardWMm: src.boardWMm,
            boardHMm: src.boardHMm,
          });
        }

        const instances: MillInstanceInput[] = [];
        for (const inst of panel.instances) {
          const idx = designIndex.get(inst.design_id);
          if (idx === undefined) continue; // instance of a non-millable design — skip
          instances.push({
            designIndex: idx,
            xMm: inst.x_mm,
            yMm: inst.y_mm,
            rotationDeg: inst.rotation_deg,
          });
        }

        const extent: MillExtent = { widthMm: panel.width_mm, heightMm: panel.height_mm };
        const input: MillPlanInput = {
          workingDir,
          designs,
          instances,
          panelWidthMm: panel.width_mm,
          panelHeightMm: panel.height_mm,
          cutWidthMm: params.cutWidthMm,
          passes: params.passes,
          overlap: params.overlap,
          climb: params.climb,
          datum: millDatumCorner,
          cnc: {
            safeZMm: cncProfile.safeZMm,
            toolChangeZMm: cncProfile.toolChangeZMm,
            spindleControllable: cncProfile.spindleControllable,
            spindleMaxRpm: cncProfile.spindleMaxRpm,
            prependGcode: cncProfile.prependGcode,
            appendGcode: cncProfile.appendGcode,
          },
          cutDepthMm: params.cutDepthMm,
          depthPerPassMm: params.depthPerPassMm ?? undefined,
          feedXyMmMin: params.feedXyMmMin,
          plungeMmMin: params.plungeMmMin,
          // Keep-out zones are defined in panel space — now applicable (panel-wide plan).
          keepOutZones: (panel.keep_out_zones ?? []).map((z) => ({
            x: z.x_mm,
            y: z.y_mm,
            w: z.width_mm,
            h: z.height_mm,
          })),
        };

        const result = await api.mill.plan(input);
        if (!cancelled) setState({ result, extent, hasSource: true, loading: false });
      } catch {
        if (!cancelled) setState({ result: null, extent: null, hasSource: true, loading: false });
      }
    })();

    return () => {
      cancelled = true;
    };
    // inputKey captures the meaningful change (workingDir + panel layout + params + datum + cnc).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputKey]);

  return state;
}

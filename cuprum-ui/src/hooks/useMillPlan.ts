import { useEffect, useRef, useState } from "react";
import { api, type MillSnapshot, type MillPlanInput, type MillPlanResult, type Hole } from "@/lib/api";
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

/** Extent (mm) of the design being milled — drives the preview canvas + datum flip.
 *  Carries the gerber bbox origin too: the copper arrives in absolute gerber coords,
 *  so the backend needs the origin to normalise paths/G-code into panel space. */
export interface MillExtent {
  widthMm: number;
  heightMm: number;
  originXMm: number;
  originYMm: number;
}

export interface MillPlanState {
  result: MillPlanResult | null;
  extent: MillExtent | null;
  /** Whether a millable source (a placed design with a top-copper gerber) was found. */
  hasSource: boolean;
  loading: boolean;
}

const EMPTY: MillPlanState = { result: null, extent: null, hasSource: false, loading: false };

/** Pick the source design + its top-copper gerber for the isolation run. MVP: the
 *  first PLACED design that has a `topCopper` gerber. (Multi-instance panel-wide
 *  isolation is a later phase; the backend mills one gerber in its own coordinate
 *  frame.) Returns null when nothing millable is present. */
function pickSource(snapshot: MillSnapshot): { designId: string; gerberRel: string } | null {
  const manifest = snapshot.manifest;
  const panel = manifest?.panel;
  if (!manifest || !panel) return null;
  const placedIds = new Set(panel.instances.map((i) => i.design_id));
  for (const design of manifest.designs) {
    if (!placedIds.has(design.id)) continue;
    const copper = design.gerbers.find((g) => g.layer_type === "topCopper");
    if (copper) return { designId: design.id, gerberRel: copper.path };
  }
  return null;
}

/** Build the isolation-milling plan from a MillSnapshot + the editor's cut params.
 *  Resolves the source gerber + drill holes, derives the design extent (for the
 *  datum flip + canvas), then calls the Rust `mill_plan` command. All heavy work
 *  (copper boolean, offset solver, G-code) is in Rust — this only marshals input
 *  and guards against stale async results. Debounced via the stringified input so a
 *  control tweak refetches at most once per change. */
export function useMillPlan(snapshot: MillSnapshot | null, params: MillCutParams): MillPlanState {
  const [state, setState] = useState<MillPlanState>(EMPTY);

  // Per-design holes cache, keyed by design_id (cleared when the working dir changes
  // since design ids are sequential per project).
  const holesCache = useRef<Map<string, Hole[]>>(new Map());
  const extentCache = useRef<Map<string, MillExtent>>(new Map());
  const lastWorkingDir = useRef<string | null>(null);

  // Stringify the planning inputs so the effect only re-fires on a real change.
  const source = snapshot ? pickSource(snapshot) : null;
  const inputKey =
    snapshot?.workingDir && source
      ? JSON.stringify([snapshot.workingDir, source.gerberRel, params, snapshot.millDatumCorner, snapshot.cncProfile])
      : null;

  useEffect(() => {
    if (!snapshot?.workingDir || !source || !snapshot.cncProfile) {
      setState(EMPTY);
      return;
    }
    const { workingDir, manifest, cncProfile, millDatumCorner } = snapshot;
    const { designId, gerberRel } = source;

    if (workingDir !== lastWorkingDir.current) {
      holesCache.current.clear();
      extentCache.current.clear();
      lastWorkingDir.current = workingDir;
    }

    let cancelled = false;
    setState((prev) => ({ ...prev, hasSource: true, loading: true }));

    (async () => {
      try {
        const design = manifest?.designs.find((d) => d.id === designId);

        // Resolve the design extent (board metrics) — drives the datum flip + canvas.
        let extent = extentCache.current.get(designId) ?? null;
        if (!extent && design) {
          try {
            const m = await metricsCache.get(
              workingDir,
              design.gerbers.map((g) => ({ rel: g.path, layerType: g.layer_type })),
            );
            extent = {
              widthMm: m.metrics.board.widthMm,
              heightMm: m.metrics.board.heightMm,
              originXMm: m.metrics.board.originXMm,
              originYMm: m.metrics.board.originYMm,
            };
          } catch {
            extent = null;
          }
          if (extent) extentCache.current.set(designId, extent);
        }
        if (cancelled) return;

        // Drill holes for this design (raw gerber coords — same frame the copper
        // gerber lives in), subtracted from the copper so rings don't cross holes.
        let holes = holesCache.current.get(designId) ?? null;
        if (!holes && design) {
          const drillLayers = design.gerbers.filter((g) => g.layer_type === "drill");
          holes = (
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
          holesCache.current.set(designId, holes);
        }
        if (cancelled) return;

        const ext = extent ?? { widthMm: 0, heightMm: 0, originXMm: 0, originYMm: 0 };
        const input: MillPlanInput = {
          workingDir,
          gerberRel,
          holes: holes ?? [],
          cutWidthMm: params.cutWidthMm,
          passes: params.passes,
          overlap: params.overlap,
          climb: params.climb,
          datum: millDatumCorner,
          panelWidthMm: ext.widthMm,
          panelHeightMm: ext.heightMm,
          // The copper gerber is in absolute coords; the backend subtracts this
          // origin and flips Y to land paths/G-code/preview in panel space.
          originXMm: ext.originXMm,
          originYMm: ext.originYMm,
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
          // No keep-out zones: this MVP mills a SINGLE design in its own coordinate
          // frame, not the assembled panel. Keep-out zones are defined in panel
          // space and don't map into a lone design's frame, so applying them here
          // would be meaningless. Panel-wide isolation (multi-instance) is a later
          // phase; that's where keep-out zones become applicable.
          keepOutZones: [],
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
    // inputKey captures the meaningful change (workingDir + gerber + params + datum + cnc).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputKey]);

  return state;
}

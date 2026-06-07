import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { colorFor, sideOf, missingRequired } from "@/lib/layerColors";
import {
  api,
  DEFAULT_FR4_THICKNESS_MM,
  type BBox,
  type BoardMetrics,
  type GerberFile,
  type Hole,
  type LayerType,
  type PanelDoc,
  type Stackup,
} from "@/lib/api";
import type { FindingCategory, Finding, ProblemType, Verdict } from "@/lib/feasibility";
import type { BoardMeshData } from "@/lib/boardMesh";
import { evaluate, overallVerdict, problemTypeOf } from "@/lib/feasibility";
import type { CapabilityProfile } from "@/lib/capabilityProfile";
import { useSettings } from "@/settingsStore";
import { drillBitsFromTools } from "@/lib/toolLibrary";
import type { StackLayer, FocusTarget } from "@/components/import/LayerStack";
import type { DrcMarkerInput } from "@/components/preview/DrcMarkers";
import type { PreviewMode, DrcIssue } from "@/components/preview/PreviewPane";
import { useUnitFormat } from "@/i18n/useUnitFormat";
import { useFindingText } from "@/hooks/useFindingText";

/** Per-gerber render status for the streaming 2D preview. */
type SvgStatus = "none" | "pending" | "loaded" | "error";

/** Local, UI-only model of one gerber in a design. Layer type is NOT stored here —
 *  the manifest design is the source of truth; this carries only the derived 2D/drill
 *  render state, keyed by position in `gerbers[]`. */
export interface InspectorFile {
  path: string;
  filename: string;
  svgBody?: string;
  bbox?: BBox;
  snap?: [number, number][];
  holes: Hole[];
  drillError: string | null;
  svgStatus: SvgStatus;
}

/** All data derived from a design's gerbers: loaded files, layer stacks, mesh, metrics,
 *  DRC findings, and related UI state. Returned by usePreviewData. */
export interface PreviewData {
  files: InspectorFile[];
  layers: StackLayer[];
  visibleHoles: Hole[];
  mesh: BoardMeshData | null;
  metrics: BoardMetrics | null;
  metricsLoading: boolean;
  findings: Finding[];
  verdict: Verdict;
  markers: DrcMarkerInput[];
  issues: DrcIssue[];
  focusTarget: FocusTarget | null;
  hasRequired: boolean;
  missing: LayerType[];
  layersLoading: boolean;
  previewNotice: string | undefined;
  layerColors: Record<string, string>;
  visibleKeys: Set<string>;
  hidden: Set<string>;
  toggle: (index: number, visible: boolean) => void;
  /** Whether a layer is visible at the current mode/side + manual hides (LayerPanel rows). */
  isVisible: (type: LayerType, path: string) => boolean;
}

/** Findings whose hotspots are holes — drawn as a ring around the bore. */
const CIRCLE_FINDINGS = new Set(["drill.minHole", "via.plating", "drill.bitSnap"]);
/** Findings whose hotspots mark a thin feature (drawn as a box). */
const BOX_FINDINGS = new Set<string>([]);
/** Findings whose hotspots are the actual failing strokes — colour-highlighted as
 *  lines at their width. Silk is split per side, so match the `silk.line.*` family
 *  by prefix. */
const isLineFinding = (id: string) => id.startsWith("silk.line") || id.startsWith("copper.thinTrace");

/** Layer types a finding's hotspots belong to, by category — so a marker is only
 *  drawn while one of those layers is actually visible. `null` = not tied to a
 *  specific layer (e.g. overshoot is judged by side alone). */
const FINDING_LAYER_TYPES: Partial<Record<FindingCategory, LayerType[]>> = {
  copper: ["topCopper", "bottomCopper", "innerCopper"],
  silk: ["topSilk", "bottomSilk"],
  mask: ["topMask", "bottomMask"],
  drill: ["drill"],
  via: ["drill"],
};

export interface UsePreviewDataOpts {
  /** Whether the 3D mesh build has been armed (lazy: becomes true on first 3D view). */
  armed3d: boolean;
  /** FR4 substrate thickness in mm; falls back to DEFAULT_FR4_THICKNESS_MM. */
  thicknessMm?: number;
  profile: CapabilityProfile;
  panel?: PanelDoc | null;
  stackup?: Stackup | null;
  /** manifest.layer_colors — per-type colour overrides. */
  overrides?: Record<string, string>;
  /** When true, topMask/bottomMask are excluded from layers and visibleKeys. */
  excludeMask?: boolean;
  /** Called with `fresh` flag after SVG/metrics artifact load. */
  onArtifactFresh?: (fresh: boolean) => void;
  /** Currently focused DRC hotspot (for markers/focusTarget). */
  focus?: { fid: string; hi: number } | null;
  /** Monotonic counter bumped each time focus is set (enables re-centering on the same spot). */
  focusNonce?: number;
  /** Problem types hidden by the user from the 2D overlay and stepper (does NOT
   *  affect the verdict). When omitted the filter is off (add-design behaviour).
   *  Pass a stable reference (state or useMemo) — a fresh Set each render
   *  recomputes markers/issues. */
  hiddenTypes?: Set<ProblemType>;
}

/**
 * Load and derive all preview data for a single design's gerber set.
 *
 * Encapsulates:
 *  - streaming SVG + drill loading (files state + three effects)
 *  - 3D board mesh build (gated by armed3d)
 *  - DFM metrics measurement
 *  - DRC findings evaluation and marker/issue derivation
 *  - layer visibility, colors, visibleKeys, visibleHoles
 *  - hidden/toggle state
 */
export function usePreviewData(
  workingDir: string | null,
  designId: string,
  gerbers: GerberFile[],
  mode: PreviewMode,
  side: "top" | "bottom",
  opts: UsePreviewDataOpts,
): PreviewData {
  const {
    armed3d,
    thicknessMm: thicknessMmOpt,
    profile,
    panel,
    stackup,
    overrides,
    excludeMask = false,
    onArtifactFresh,
    focus = null,
    focusNonce = 0,
    hiddenTypes,
  } = opts;
  const tools = useSettings((s) => s.tools);

  // Keep the latest onArtifactFresh in a ref so the async effects (whose dep
  // arrays intentionally omit it) always call the current callback, not a stale
  // closure captured at effect-setup.
  const onArtifactFreshRef = useRef(onArtifactFresh);
  useEffect(() => {
    onArtifactFreshRef.current = onArtifactFresh;
  });

  const { t } = useTranslation(["feasibility", "common", "metrics", "import", "layers", "project"]);
  const { fmtLen, fmtLenPair } = useUnitFormat();
  // Shared finding-text resolver (tr = single text, trLen = with a shared-unit
  // length override) — same logic FeasibilityTab uses; see hooks/useFindingText.
  const { tr: resolveText, trLen } = useFindingText();

  // Per-gerber MANUAL hide toggles by REL-PATH (UI-only, not persisted).
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  // Streaming 2D/drill render state, indexed by position in gerbers[].
  const [files, setFiles] = useState<InspectorFile[]>([]);

  // Measured manufacturing facts (DFM) + their loading state.
  const [mesh, setMesh] = useState<BoardMeshData | null>(null);
  const [metrics, setMetrics] = useState<BoardMetrics | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);

  // Required layers (the board outline) that must be assigned for a valid,
  // previewable board. While any are missing we skip expensive builds.
  const missing = useMemo(() => missingRequired(gerbers.map((g) => g.layer_type)), [gerbers]);
  const hasRequired = missing.length === 0;

  // Stable key over the design's gerber set (rel-path + type). Drives the 2D/3D/
  // metrics recompute: changing a layer type mutates gerbers -> this key.
  const gerbersKey = useMemo(
    () => gerbers.map((g) => `${g.path}:${g.layer_type}`).join(","),
    [gerbers],
  );

  // Build / refresh the local files model from the gerbers, streaming the
  // per-gerber 2D SVG (non-drill) and drill holes.
  useEffect(() => {
    let cancelled = false;
    if (!workingDir || gerbers.length === 0) {
      setFiles([]);
      return;
    }
    const base: InspectorFile[] = gerbers.map((g) => ({
      path: g.path,
      filename: g.path.split("/").pop() ?? g.path,
      holes: [],
      drillError: null,
      svgStatus: g.layer_type === "drill" ? "none" : "pending",
    }));
    const slots = base.slice();
    setFiles(base.map((f) => ({ ...f })));
    const flush = () => {
      if (!cancelled) setFiles(slots.map((f) => ({ ...f })));
    };
    // Drill layers stay per-call (cheap, separate command).
    gerbers.forEach((g, i) => {
      if (g.layer_type === "drill") {
        api
          .readDrill(workingDir, g.path)
          .then((holes) => {
            if (cancelled) return;
            slots[i] = { ...slots[i], holes };
            flush();
          })
          .catch((e) => {
            if (cancelled) return;
            slots[i] = { ...slots[i], drillError: String(e) };
            flush();
          });
      }
    });

    // All SVG layers in one batched IPC call (parallel render in Rust).
    const svgIdx = gerbers
      .map((g, i) => ({ g, i }))
      .filter(({ g }) => g.layer_type !== "drill");
    if (svgIdx.length > 0) {
      api
        .renderLayersSvg(
          workingDir,
          svgIdx.map(({ g }) => g.path),
        )
        .then((results) => {
          if (cancelled) return;
          results.forEach((r, k) => {
            const i = svgIdx[k].i;
            if (r.geometry) {
              slots[i] = {
                ...slots[i],
                svgBody: r.geometry.svgBody,
                bbox: r.geometry.bbox,
                snap: r.geometry.snap,
                svgStatus: "loaded",
              };
            } else {
              slots[i] = { ...slots[i], svgStatus: "error" };
            }
          });
          flush();
          onArtifactFreshRef.current?.(results.some((r) => r.fresh));
        })
        .catch(() => {
          if (cancelled) return;
          svgIdx.forEach(({ i }) => {
            slots[i] = { ...slots[i], svgStatus: "error" };
          });
          flush();
        });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingDir, designId, gerbersKey]);

  // Excluded drill rel-paths (hidden drill layers are dropped from the mesh).
  const excludedDrillKeys = useMemo(
    () =>
      gerbers
        .filter((g) => g.layer_type === "drill" && hidden.has(g.path))
        .map((g) => g.path),
    [gerbers, hidden],
  );
  const excludedKey = excludedDrillKeys.join(",");
  // FR4 thickness from the panel stackup, baked into the board Z.
  const thicknessMm = thicknessMmOpt ?? DEFAULT_FR4_THICKNESS_MM;

  // Build the full 3D board mesh in the Rust core. Only when armed (first 3D view).
  // Non-drill layers toggle client-side via visibleKeys (instant); drill layers
  // need a server-side rebuild when hidden (dropped from the mesh).
  useEffect(() => {
    let cancelled = false;
    if (!armed3d) return;
    if (!workingDir || gerbers.length === 0 || !hasRequired) {
      setMesh(null);
      return;
    }
    const refs = gerbers.map((g) => ({ rel: g.path, layerType: g.layer_type }));
    (async () => {
      try {
        const buf = await api.projectBoardMesh(workingDir, refs, excludedDrillKeys, thicknessMm);
        // Dynamic import: parseBoardMesh builds a THREE.BufferGeometry, so it pulls
        // three into a lazy chunk instead of the startup bundle. Safe — this runs
        // only when the 3D view has been armed.
        const { parseBoardMesh } = await import("@/lib/boardMesh");
        if (!cancelled) setMesh(parseBoardMesh(buf));
      } catch {
        if (!cancelled) setMesh(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingDir, gerbersKey, excludedKey, hasRequired, armed3d, thicknessMm]);

  // Measure manufacturing facts whenever the gerber set / a layer-type assignment
  // changes, but only once the required outline is present.
  useEffect(() => {
    let cancelled = false;
    if (!workingDir || gerbers.length === 0 || !hasRequired) {
      setMetrics(null);
      setMetricsLoading(false);
      return;
    }
    const refs = gerbers.map((g) => ({ rel: g.path, layerType: g.layer_type }));
    setMetricsLoading(true);
    (async () => {
      try {
        const m = await api.projectBoardMetrics(workingDir, refs);
        if (!cancelled) {
          setMetrics(m.metrics);
          onArtifactFreshRef.current?.(m.fresh);
        }
      } catch {
        if (!cancelled) setMetrics(null);
      } finally {
        if (!cancelled) setMetricsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingDir, gerbersKey, hasRequired]);

  // Judge measured facts against the capability profile (instant, client-side).
  const findings = useMemo(
    () => evaluate(metrics, profile, panel, stackup, drillBitsFromTools(tools)),
    [metrics, profile, panel, stackup, tools],
  );
  const verdict = overallVerdict(findings);

  // Effective visibility: 3D shows every side by default; 2D shows only the
  // selected side (+ shared layers). Manual hides apply in both modes.
  const isVisible = useCallback(
    (type: LayerType, path: string): boolean => {
      if (hidden.has(path)) return false;
      if (mode === "3d") return true;
      const s = sideOf(type);
      return s === side || s === "both";
    },
    [hidden, mode, side],
  );

  // Should a DRC marker be drawn? Only when the layer it belongs to is visible.
  const markerVisible = useCallback(
    (category: FindingCategory, hside: "top" | "bottom" | "both"): boolean => {
      if (category === "size") return hside === "both" || hside === side;
      const types = FINDING_LAYER_TYPES[category];
      if (!types) return true;
      return gerbers.some(
        (g) =>
          types.includes(g.layer_type) &&
          isVisible(g.layer_type, g.path) &&
          (hside === "both" || sideOf(g.layer_type) === hside),
      );
    },
    [gerbers, isVisible, side],
  );

  // Flatten all findings' hotspots into preview markers (board mm).
  const markers = useMemo<DrcMarkerInput[]>(
    () =>
      findings.flatMap((f) => {
        // Drop a problem-type the user hid in the filter (overlay only, not verdict).
        if (hiddenTypes) {
          const tp = problemTypeOf(f.id);
          if (tp && hiddenTypes.has(tp)) return [];
        }
        const shape = CIRCLE_FINDINGS.has(f.id)
          ? ("circle" as const)
          : BOX_FINDINGS.has(f.id)
            ? ("box" as const)
            : isLineFinding(f.id)
              ? ("line" as const)
              : ("dim" as const);
        const visual = (f.hotspots ?? [])
          .map((h, i) => ({ h, i }))
          .filter(({ h }) => markerVisible(f.category, h.side))
          .map(({ h, i }) => {
            const l = f.limit?.params?.len;
            const [vs, ls2] = typeof l === "number" ? fmtLenPair([h.v, l]) : [fmtLen(h.v), ""];
            const limitStr = typeof l === "number" ? trLen(f.limit, ls2) : resolveText(f.limit);
            return {
              key: `${f.id}#${i}`,
              a: h.a,
              b: h.b,
              value: vs,
              label: resolveText(f.label),
              limit: limitStr,
              detail: resolveText(f.detail) || undefined,
              severity: f.severity,
              focused: shape !== "line" && focus?.fid === f.id && focus?.hi === i,
              shape,
              widthMm: shape === "line" ? h.v : undefined,
              lineColor: shape === "line" && f.category === "copper" ? "hsl(var(--destructive))" : undefined,
            };
          });
        const hovers = (f.hoverBoxes ?? [])
          .filter((h) => markerVisible(f.category, h.side))
          .map((h, i) => {
            const l = f.limit?.params?.len;
            const [valueStr, limitStr] =
              typeof l === "number"
                ? (() => { const [vs, ls] = fmtLenPair([h.v, l]); return [vs, trLen(f.limit, ls)]; })()
                : [fmtLen(h.v), resolveText(f.limit)];
            return {
              key: `${f.id}~hover#${i}`,
              a: h.a,
              b: h.b,
              value: valueStr,
              label: resolveText(f.label),
              limit: limitStr,
              detail: resolveText(f.detail) || undefined,
              severity: f.severity,
              focused: focus?.fid === f.id && focus?.hi === i,
              shape: "hover" as const,
            };
          });
        return [...visual, ...hovers];
      }),
    [findings, focus, hiddenTypes, markerVisible, resolveText, trLen, fmtLen, fmtLenPair],
  );

  // Flat list of navigable problems for the on-preview stepper.
  const issues = useMemo(
    () =>
      findings.flatMap((f) => {
        const hs = f.hotspots ?? [];
        if (hs.length === 0) return [];
        if (hiddenTypes) {
          const tp = problemTypeOf(f.id);
          if (tp && hiddenTypes.has(tp)) return [];
        }
        if (f.highlightAll) {
          const boxes = f.hoverBoxes ?? [];
          if (boxes.length > 0) {
            return boxes.flatMap((h, i) =>
              markerVisible(f.category, h.side)
                ? [{ fid: f.id, hi: i, label: resolveText(f.label), value: fmtLen(h.v), severity: f.severity }]
                : [],
            );
          }
          return markerVisible(f.category, hs[0].side)
            ? [{ fid: f.id, hi: 0, label: resolveText(f.label), value: resolveText(f.measured), severity: f.severity }]
            : [];
        }
        return hs.flatMap((h, i) =>
          markerVisible(f.category, h.side)
            ? [{ fid: f.id, hi: i, label: resolveText(f.label), value: fmtLen(h.v), severity: f.severity }]
            : [],
        );
      }),
    [findings, hiddenTypes, markerVisible, resolveText, fmtLen],
  );

  // Centre the 2D view on the focus target. `focusNonce` is bumped by the caller
  // each time focus changes so re-clicking the same hotspot re-centres the view.
  const focusTarget = useMemo<FocusTarget | null>(() => {
    if (!focus) return null;
    const f = findings.find((x) => x.id === focus.fid);
    if (!f) return null;
    // For highlightAll findings, frame the focused cluster or full set.
    if (f.highlightAll) {
      const box = f.hoverBoxes?.[focus.hi];
      if (box) {
        const w = Math.abs(box.b[0] - box.a[0]);
        const h2 = Math.abs(box.b[1] - box.a[1]);
        return {
          p: [(box.a[0] + box.b[0]) / 2, (box.a[1] + box.b[1]) / 2],
          spanMm: Math.max(w, h2) * 1.6 + 6,
          nonce: focusNonce,
        };
      }
      if (f.hotspots && f.hotspots.length > 0) {
        let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
        for (const h of f.hotspots) {
          for (const p of [h.a, h.b]) {
            minx = Math.min(minx, p[0]); miny = Math.min(miny, p[1]);
            maxx = Math.max(maxx, p[0]); maxy = Math.max(maxy, p[1]);
          }
        }
        return {
          p: [(minx + maxx) / 2, (miny + maxy) / 2],
          spanMm: Math.max(maxx - minx, maxy - miny) * 1.3 + 4,
          nonce: focusNonce,
        };
      }
    }
    const h = f.hotspots?.[focus.hi];
    if (!h) return null;
    return { p: [(h.a[0] + h.b[0]) / 2, (h.a[1] + h.b[1]) / 2], spanMm: 18, nonce: focusNonce };
  }, [focus, focusNonce, findings]);

  // Layers/drills visible in 3D = those not manually hidden (keyed by rel-path).
  // When excludeMask is set, topMask/bottomMask are also excluded.
  const visibleKeys = useMemo(
    () =>
      new Set(
        gerbers
          .filter((g) => {
            if (hidden.has(g.path)) return false;
            if (excludeMask && (g.layer_type === "topMask" || g.layer_type === "bottomMask")) return false;
            return true;
          })
          .map((g) => g.path),
      ),
    [gerbers, hidden, excludeMask],
  );

  // Colour by rel-path, for 3D surface layers.
  const layerColors = useMemo(() => {
    const m: Record<string, string> = {};
    gerbers.forEach((g) => {
      m[g.path] = colorFor(g.layer_type, overrides);
    });
    return m;
  }, [gerbers, overrides]);

  // Progress badge while per-layer SVGs stream in (2D only).
  const svgTotal = files.filter((f) => f.svgStatus !== "none").length;
  const svgSettled = files.filter((f) => f.svgStatus === "loaded" || f.svgStatus === "error").length;
  const previewNotice =
    mode === "2d" && svgTotal > 0 && svgSettled < svgTotal
      ? t("metrics:layersProgress", { done: svgSettled, total: svgTotal })
      : undefined;

  // Holes from the currently-visible drill layers.
  const visibleHoles = useMemo(
    () =>
      gerbers.flatMap((g, i) =>
        g.layer_type === "drill" && isVisible(g.layer_type, g.path) ? files[i]?.holes ?? [] : [],
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gerbers, files, hidden, mode, side],
  );

  // StackLayer list — used by LayerStack 2D composite. When excludeMask is set,
  // mask layers are omitted.
  const layers: StackLayer[] = useMemo(
    () =>
      gerbers
        .map((g, i) => ({ g, f: files[i] }))
        .filter(({ g, f }) => {
          if (!f?.svgBody || !f?.bbox) return false;
          if (excludeMask && (g.layer_type === "topMask" || g.layer_type === "bottomMask")) return false;
          return true;
        })
        .map(({ g, f }) => ({
          key: g.path,
          svgBody: f!.svgBody as string,
          bbox: f!.bbox!,
          color: colorFor(g.layer_type, overrides),
          visible: isVisible(g.layer_type, g.path),
          type: g.layer_type,
          snap: f!.snap ?? [],
        })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gerbers, files, hidden, overrides, mode, side, excludeMask],
  );

  // 2D viewer is loading when SVG layers are still being rendered and none are ready.
  const layersLoading = mode === "2d" && layers.length === 0 && svgTotal > 0 && svgSettled < svgTotal;

  // Toggle layer visibility by index in gerbers[].
  const toggle = useCallback(
    (index: number, visible: boolean) => {
      const g = gerbers[index];
      if (!g) return;
      setHidden((prev) => {
        const next = new Set(prev);
        if (visible) next.delete(g.path);
        else next.add(g.path);
        return next;
      });
    },
    [gerbers],
  );

  return {
    files,
    layers,
    visibleHoles,
    mesh,
    metrics,
    metricsLoading,
    findings,
    verdict,
    markers,
    issues,
    focusTarget,
    hasRequired,
    missing,
    layersLoading,
    previewNotice,
    layerColors,
    visibleKeys,
    hidden,
    toggle,
    isVisible,
  };
}

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Layers, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { LayerPanel, type PanelRow } from "@/components/import/LayerPanel";
import { type StackLayer, type FocusTarget } from "@/components/import/LayerStack";
import { type DrcMarkerInput } from "@/components/preview/DrcMarkers";
import { PreviewPane, type PreviewMode, type PreviewTab } from "@/components/preview/PreviewPane";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { colorFor, sideOf, stackOrder, missingRequired } from "@/lib/layerColors";
import { api, type BBox, type BoardMetrics, type Hole, type LayerType } from "@/lib/api";
import type { FindingCategory, I18nText } from "@/lib/feasibility";
import { parseBoardMesh, type BoardMeshData } from "@/lib/boardMesh";
import { evaluate, overallVerdict, VERDICT_KEY } from "@/lib/feasibility";
import { useShell } from "@/shellStore";
import { useSettings } from "@/settingsStore";
import { useUnitFormat } from "@/i18n/useUnitFormat";

/** Param names carrying a RAW length in mm — formatted via fmtLen at render. */
const LEN_PARAMS = new Set(["len", "w", "h"]);

/** Findings whose hotspots mark a thin feature (drawn as a box). */
const BOX_FINDINGS = new Set<string>([]);
/** Findings whose hotspots are holes — drawn as a ring around the bore. */
const CIRCLE_FINDINGS = new Set(["drill.minHole", "via.plating", "drill.bitSnap"]);
/** Findings whose hotspots are the actual failing strokes — colour-highlighted as
 *  lines at their width (no per-stroke box/tooltip). Silk is split per side, so
 *  match the `silk.line.*` family by prefix. */
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

/** Per-gerber render status for the streaming 2D preview. */
type SvgStatus = "none" | "pending" | "loaded" | "error";

/** Local, UI-only model of one gerber in this design. Layer type is NOT stored
 *  here — the manifest design is the source of truth; this carries only the
 *  derived 2D/drill render state, keyed by position in `gerbers[]`. */
interface InspectorFile {
  path: string;
  filename: string;
  svgBody?: string;
  bbox?: BBox;
  snap?: [number, number][];
  holes: Hole[];
  drillError: string | null;
  svgStatus: SvgStatus;
}

interface DesignInspectorProps {
  designId: string;
  onBack: () => void;
}

// Identity is the gerber REL-PATH (g.path), matching project_board_mesh /
// project_board_metrics. LayerPanel keeps its numeric `index` = position in this
// design's gerbers[]; the inspector maps index -> gerbers[index].path at every
// call site that crosses into the store or a rel-path key set.
export function DesignInspector({ designId, onBack }: DesignInspectorProps) {
  const manifest = useShell((s) => s.currentManifest);
  const workingDir = useShell((s) => s.workingDir);
  const setDesignLayerType = useShell((s) => s.setDesignLayerType);
  const design = manifest?.designs.find((d) => d.id === designId) ?? null;
  const gerbers = useMemo(() => design?.gerbers ?? [], [design]);

  const { t } = useTranslation(["feasibility", "common", "metrics", "import", "layers", "project"]);
  const { fmtLen, fmtLenPair } = useUnitFormat();
  // Resolve an I18nText to a display string: length params unit-formatted, key-like
  // string params translated, then the text key translated. `lenOverride`, when
  // given, replaces the `len` param's value (so a finding's value and limit can be
  // rendered in one shared unit by the caller).
  const resolveText = useCallback(
    (text?: I18nText, lenOverride?: string): string => {
      if (!text) return "";
      const params: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(text.params ?? {})) {
        if (k === "len" && lenOverride != null && typeof v === "number") params[k] = lenOverride;
        else if (Array.isArray(v)) params[k] = v.map((mm) => fmtLen(mm)).join(", ");
        else if (LEN_PARAMS.has(k) && typeof v === "number") params[k] = fmtLen(v);
        else if (typeof v === "string" && v.includes(":")) params[k] = t(v);
        else params[k] = v;
      }
      return t(text.key, params);
    },
    [t, fmtLen],
  );
  const tr = useCallback((text?: I18nText): string => resolveText(text), [resolveText]);
  const trLen = useCallback(
    (text: I18nText | undefined, lenStr: string): string => resolveText(text, lenStr),
    [resolveText],
  );

  const [mode, setMode] = useState<PreviewMode>("2d");
  const [tab, setTab] = useState<PreviewTab>("preview");
  const [side, setSide] = useState<"top" | "bottom">("top");
  // 3D camera facing (null = orbited off-axis) + a nonce to snap the camera onto
  // a side when the toggle is clicked.
  const [facing, setFacing] = useState<"top" | "bottom" | null>("top");
  const [snapNonce, setSnapNonce] = useState(0);
  const pickSide = useCallback((v: "top" | "bottom") => {
    setSide(v);
    setFacing(v);
    setSnapNonce((n) => n + 1);
  }, []);
  const [mesh, setMesh] = useState<BoardMeshData | null>(null);
  // Measured manufacturing facts (DFM) + their loading state.
  const [metrics, setMetrics] = useState<BoardMetrics | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  // Per-gerber MANUAL hide toggles by REL-PATH (UI-only, not persisted).
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  // Streaming 2D/drill render state, indexed by position in gerbers[].
  const [files, setFiles] = useState<InspectorFile[]>([]);
  const overrides = manifest?.layer_colors;
  const profile = useSettings((s) => s.profile);

  // Required layers (the board outline) that must be assigned for a valid,
  // previewable board. While any are missing we skip the (expensive) mesh build
  // and prompt the user to assign them instead of rendering.
  const missing = useMemo(() => missingRequired(gerbers.map((g) => g.layer_type)), [gerbers]);
  const hasRequired = missing.length === 0;

  // Stable key over the design's gerber set (rel-path + type). Drives the 2D/3D/
  // metrics recompute: changing a layer type mutates the manifest -> gerbers ->
  // this key, so everything downstream refreshes.
  const gerbersKey = useMemo(
    () => gerbers.map((g) => `${g.path}:${g.layer_type}`).join(","),
    [gerbers],
  );

  // Build / refresh the local files model from the manifest design, streaming the
  // per-gerber 2D SVG (non-drill) and drill holes. Progressive pattern: a slots
  // array + cancelled guard, recomputed on designId + gerber set.
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
      } else {
        api
          .renderGerberSvg(workingDir, g.path)
          .then((geo) => {
            if (cancelled) return;
            slots[i] = {
              ...slots[i],
              svgBody: geo.svgBody,
              bbox: geo.bbox,
              snap: geo.snap,
              svgStatus: "loaded",
            };
            flush();
          })
          .catch(() => {
            if (cancelled) return;
            slots[i] = { ...slots[i], svgStatus: "error" };
            flush();
          });
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingDir, designId, gerbersKey]);

  // Build the full 3D board mesh in the Rust core (off the UI thread) from the
  // working-dir loose files keyed by rel-path. Recomputes only when the gerber set
  // / a layer-type assignment changes, or when a drill layer's visibility flips
  // (hidden drill layers are dropped from the mesh entirely — a server-side
  // rebuild). Non-drill layers toggle client-side via visibleKeys (instant).
  const excludedDrillKeys = useMemo(
    () =>
      gerbers
        .filter((g) => g.layer_type === "drill" && hidden.has(g.path))
        .map((g) => g.path),
    [gerbers, hidden],
  );
  const excludedKey = excludedDrillKeys.join(",");
  useEffect(() => {
    let cancelled = false;
    // No outline assigned → nothing valid to build; don't spend time on the mesh.
    if (!workingDir || gerbers.length === 0 || !hasRequired) {
      setMesh(null);
      return;
    }
    const refs = gerbers.map((g) => ({ rel: g.path, layerType: g.layer_type }));
    // Keep the previous mesh visible while recomputing (drill/type change) so the
    // 3D Canvas isn't torn down — that preserves the camera and avoids replaying
    // the intro animation. Only a genuinely empty design clears it (above).
    (async () => {
      try {
        const buf = await api.projectBoardMesh(workingDir, refs, excludedDrillKeys);
        if (!cancelled) setMesh(parseBoardMesh(buf));
      } catch {
        if (!cancelled) setMesh(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingDir, gerbersKey, excludedKey, hasRequired]);

  // Measure manufacturing facts (cheap, off-thread) whenever the gerber set or a
  // layer-type assignment changes, but only once the required outline is present
  // (same gate as the mesh — nothing to measure without it).
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
        if (!cancelled) setMetrics(m);
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

  // Judge measured facts against the capability profile (instant, client-side —
  // re-runs when the profile thresholds change too).
  const findings = useMemo(() => evaluate(metrics, profile), [metrics, profile]);
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

  // Should a DRC marker be drawn? Only when the layer it belongs to is currently
  // visible (right side + not hidden). `both`-side hotspots (holes) show whenever
  // any layer of their role is visible; sided ones need that exact face shown.
  const markerVisible = useCallback(
    (category: FindingCategory, hside: "top" | "bottom" | "both"): boolean => {
      if (category === "size") return hside === "both" || hside === side; // overshoot — by side only
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

  // DRC overlay on the preview is OFF by default (clean preview); it turns on
  // only when arriving from the Feasibility tab (clicking a finding) or via its
  // toggle — so the markers don't clutter casual browsing.
  const [showDrc, setShowDrc] = useState(false);
  // DRC marker focus: which finding's hotspot is highlighted/centred in 2D.
  const [focus, setFocus] = useState<{ fid: string; hi: number } | null>(null);
  const focusNonce = useRef(0);
  const onFocus = useCallback(
    (fid: string, hi: number) => {
      focusNonce.current += 1;
      setFocus({ fid, hi });
      setShowDrc(true);
      setTab("preview");
      setMode("2d");
      // Reveal the right face so the focused marker isn't filtered out.
      const f = findings.find((x) => x.id === fid);
      // For highlightAll findings hi indexes hoverBoxes; otherwise hotspots.
      const hs = f?.highlightAll ? f.hoverBoxes?.[hi]?.side : f?.hotspots?.[hi]?.side;
      if (hs === "top" || hs === "bottom") setSide(hs);
    },
    [findings],
  );

  // Flatten all findings' hotspots into preview markers (board mm).
  const markers = useMemo<DrcMarkerInput[]>(
    () =>
      findings.flatMap((f) => {
        const shape = CIRCLE_FINDINGS.has(f.id)
          ? ("circle" as const)
          : BOX_FINDINGS.has(f.id)
            ? ("box" as const)
            : isLineFinding(f.id)
              ? ("line" as const)
              : ("dim" as const);
        const visual = (f.hotspots ?? [])
          .map((h, i) => ({ h, i }))
          // Hide markers whose layer isn't currently shown (e.g. bottom-side
          // issues while viewing the top).
          .filter(({ h }) => markerVisible(f.category, h.side))
          .map(({ h, i }) => {
            // value (this hotspot) + the finding's limit share one unit.
            const l = f.limit?.params?.len;
            const [vs, ls2] = typeof l === "number" ? fmtLenPair([h.v, l]) : [fmtLen(h.v), ""];
            const limitStr = typeof l === "number" ? trLen(f.limit, ls2) : tr(f.limit);
            return {
              key: `${f.id}#${i}`,
              a: h.a,
              b: h.b,
              value: vs,
              label: tr(f.label),
              limit: limitStr,
              detail: tr(f.detail) || undefined,
              severity: f.severity,
              // Line highlights aren't individually focusable (it's a bulk tint).
              focused: shape !== "line" && focus?.fid === f.id && focus?.hi === i,
              shape,
              widthMm: shape === "line" ? h.v : undefined,
              lineColor: shape === "line" && f.category === "copper" ? "hsl(var(--destructive))" : undefined,
            };
          });
        // Invisible per-cluster hover regions so a tooltip pops on any part of a
        // line-highlighted feature (without one hitbox per stroke).
        const hovers = (f.hoverBoxes ?? [])
          .filter((h) => markerVisible(f.category, h.side))
          .map((h, i) => {
            // Each cluster shows ITS OWN width (h.v), in one shared unit with the limit.
            const l = f.limit?.params?.len;
            const [valueStr, limitStr] =
              typeof l === "number"
                ? (() => { const [vs, ls] = fmtLenPair([h.v, l]); return [vs, trLen(f.limit, ls)]; })()
                : [fmtLen(h.v), tr(f.limit)];
            return {
              key: `${f.id}~hover#${i}`,
              a: h.a,
              b: h.b,
              value: valueStr,
              label: tr(f.label),
              limit: limitStr,
              detail: tr(f.detail) || undefined,
              severity: f.severity,
              focused: focus?.fid === f.id && focus?.hi === i,
              shape: "hover" as const,
            };
          });
        return [...visual, ...hovers];
      }),
    [findings, focus, markerVisible, tr, trLen, fmtLen, fmtLenPair],
  );

  // Flat list of navigable problems for the on-preview stepper ("walk the
  // errors"). One entry per located hotspot; a highlight-all finding (silk) is a
  // single entry (its whole set is tinted at once). Filtered by `markerVisible`,
  // so the stepper only walks problems on the CURRENTLY VIEWED side / visible
  // layers — ◂▸ never jumps you to the other face.
  const issues = useMemo(
    () =>
      findings.flatMap((f) => {
        const hs = f.hotspots ?? [];
        if (hs.length === 0) return [];
        if (f.highlightAll) {
          const boxes = f.hoverBoxes ?? [];
          // Each cluster (silk line / text-block, copper trace) is its own ‹› stop,
          // showing its own width — instead of one entry per side.
          if (boxes.length > 0) {
            return boxes.flatMap((h, i) =>
              markerVisible(f.category, h.side)
                ? [{ fid: f.id, hi: i, label: tr(f.label), value: fmtLen(h.v), severity: f.severity }]
                : [],
            );
          }
          return markerVisible(f.category, hs[0].side)
            ? [{ fid: f.id, hi: 0, label: tr(f.label), value: tr(f.measured), severity: f.severity }]
            : [];
        }
        return hs.flatMap((h, i) =>
          markerVisible(f.category, h.side)
            ? [{ fid: f.id, hi: i, label: tr(f.label), value: fmtLen(h.v), severity: f.severity }]
            : [],
        );
      }),
    [findings, markerVisible, tr, fmtLen],
  );
  const issueIndex = focus ? issues.findIndex((n) => n.fid === focus.fid && n.hi === focus.hi) : -1;

  // Toggling the overlay on (manually) jumps to the first problem so there's
  // something to look at; toggling off just hides it.
  const onShowDrcChange = useCallback(
    (v: boolean) => {
      setShowDrc(v);
      if (v && issueIndex < 0 && issues.length > 0) onFocus(issues[0].fid, issues[0].hi);
    },
    [issues, issueIndex, onFocus],
  );

  // Centre the 2D view on the focus target. For a "highlight all" finding (silk),
  // frame the whole failing set's bbox; otherwise the single focused hotspot.
  const focusTarget = useMemo<FocusTarget | null>(() => {
    if (!focus) return null;
    const f = findings.find((x) => x.id === focus.fid);
    if (!f) return null;
    if (f.highlightAll) {
      // Frame the focused cluster (hoverBox); fall back to the whole set.
      const box = f.hoverBoxes?.[focus.hi];
      if (box) {
        const w = Math.abs(box.b[0] - box.a[0]);
        const h2 = Math.abs(box.b[1] - box.a[1]);
        return {
          p: [(box.a[0] + box.b[0]) / 2, (box.a[1] + box.b[1]) / 2],
          spanMm: Math.max(w, h2) * 1.6 + 6,
          nonce: focusNonce.current,
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
          nonce: focusNonce.current,
        };
      }
    }
    const h = f.hotspots?.[focus.hi];
    if (!h) return null;
    return { p: [(h.a[0] + h.b[0]) / 2, (h.a[1] + h.b[1]) / 2], spanMm: 18, nonce: focusNonce.current };
  }, [focus, findings]);

  // Layers/drills visible in 3D = those not manually hidden (keyed by rel-path,
  // matching the Rust mesh keys). Pure client-side filter — instant.
  const visibleKeys = useMemo(
    () => new Set(gerbers.filter((g) => !hidden.has(g.path)).map((g) => g.path)),
    [gerbers, hidden],
  );
  // Colour by rel-path, for "other" 3D surface layers.
  const layerColors = useMemo(() => {
    const m: Record<string, string> = {};
    gerbers.forEach((g) => {
      m[g.path] = colorFor(g.layer_type, overrides);
    });
    return m;
  }, [gerbers, overrides]);

  // A drill layer has no SVG preview but DOES have holes to show/hide — treat it
  // as toggleable content just like the other layers. `index` = position in
  // gerbers[]; key/identity is the rel-path.
  const rows: PanelRow[] = useMemo(
    () =>
      gerbers
        .map((g, i) => {
          const f = files[i];
          const loading = f?.svgStatus === "pending";
          const hasContent =
            f?.svgStatus === "loaded" || (g.layer_type === "drill" && (f?.holes.length ?? 0) > 0);
          return {
            key: g.path,
            index: i,
            filename: f?.filename ?? (g.path.split("/").pop() ?? g.path),
            type: g.layer_type,
            color: colorFor(g.layer_type, overrides),
            visible: hasContent && isVisible(g.layer_type, g.path),
            hasPreview: hasContent,
            loading,
            drillError: f?.drillError,
          };
        })
        // In 2D only list the selected side's layers (+ shared ones: contour,
        // drill, inner, other = side "both"); 3D lists everything.
        .filter((r) => mode === "3d" || sideOf(r.type) === side || sideOf(r.type) === "both")
        // Sort by physical stack (bottom → top); ties keep gerber order.
        .sort((a, b) => stackOrder(a.type) - stackOrder(b.type) || a.index - b.index),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gerbers, files, hidden, overrides, mode, side],
  );

  // Progress badge while per-layer SVGs stream in (2D only — 3D has its own
  // spinner until the mesh is ready).
  // A layer is "done" once its render has SETTLED — loaded OR errored — not only
  // when loaded. An empty gerber (e.g. a single-sided board's blank B_Silkscreen,
  // header + M02 with no geometry) legitimately errors ("no drawable geometry");
  // counting it as still-pending froze the badge at N-1/N forever.
  const svgTotal = files.filter((f) => f.svgStatus !== "none").length;
  const svgSettled = files.filter((f) => f.svgStatus === "loaded" || f.svgStatus === "error").length;
  const previewNotice = mode === "2d" && svgTotal > 0 && svgSettled < svgTotal ? t("metrics:layersProgress", { done: svgSettled, total: svgTotal }) : undefined;

  // Holes from the currently-visible drill layers (each drill file toggles its own).
  const visibleHoles = useMemo(
    () =>
      gerbers.flatMap((g, i) =>
        g.layer_type === "drill" && isVisible(g.layer_type, g.path) ? files[i]?.holes ?? [] : [],
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gerbers, files, hidden, mode, side],
  );

  const layers: StackLayer[] = useMemo(
    () =>
      gerbers
        .map((g, i) => ({ g, f: files[i] }))
        .filter(({ f }) => f?.svgBody && f?.bbox)
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
    [gerbers, files, hidden, overrides, mode, side],
  );

  // index = position in gerbers[]; map to the rel-path before touching the store
  // (layer-type edit, persisted + undoable) or the UI-only hidden rel-path set.
  const onType = (index: number, type: LayerType) => {
    const g = gerbers[index];
    if (g) void setDesignLayerType(designId, g.path, type);
  };
  const toggle = (index: number, visible: boolean) => {
    const g = gerbers[index];
    if (!g) return;
    setHidden((prev) => {
      const next = new Set(prev);
      if (visible) next.delete(g.path);
      else next.add(g.path);
      return next;
    });
  };

  if (!design) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ChevronLeft className="size-4" /> {t("project:designs.back")}
          </Button>
          <h1 className="truncate text-[13px] font-semibold text-foreground">{design.source_name}</h1>
          {hasRequired && (
            <SegmentedControl
              value={tab}
              onChange={setTab}
              options={[
                { value: "preview", label: t("import:tab.preview") },
                {
                  value: "metrics",
                  label: t("import:tab.metrics"),
                  icon: metricsLoading ? <Loader2 className="size-3 animate-spin" /> : undefined,
                },
                {
                  value: "feasibility",
                  label: t("import:tab.feasibility"),
                  title: metricsLoading ? t("import:state.checking") : metrics ? t(VERDICT_KEY[verdict]) : undefined,
                  icon: metricsLoading ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : metrics ? (
                    <span
                      className={`size-2 rounded-full ${
                        verdict === "block"
                          ? "bg-destructive"
                          : verdict === "warn"
                            ? "bg-warning"
                            : "bg-success"
                      }`}
                    />
                  ) : undefined,
                },
              ]}
            />
          )}
        </div>
        <div className="flex items-center gap-2">
          {hasRequired && (metricsLoading || metrics) && (
            <button
              type="button"
              onClick={() => setTab("feasibility")}
              title={t("import:action.openFeasibility")}
              // Border colour set inline (the dynamic `border-{verdict}` utilities
              // weren't reliably generated by Tailwind → it fell back to the grey
              // default border).
              style={{
                borderColor: metricsLoading
                  ? "hsl(var(--border))"
                  : verdict === "block"
                    ? "hsl(var(--destructive))"
                    : verdict === "warn"
                      ? "hsl(var(--warning))"
                      : "hsl(var(--success))",
              }}
              className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] transition-colors ${
                metricsLoading
                  ? "text-muted-foreground"
                  : verdict === "block"
                    ? "bg-destructive/15 text-destructive hover:bg-destructive/20"
                    : verdict === "warn"
                      ? "bg-warning/15 text-warning hover:bg-warning/20"
                      : "bg-success/15 text-success hover:bg-success/20"
              }`}
            >
              {metricsLoading ? (
                <>
                  <Loader2 className="size-3 animate-spin" /> {t("import:state.checking")}
                </>
              ) : (
                <>
                  <span
                    className={`size-2 rounded-full ${
                      verdict === "block" ? "bg-destructive" : verdict === "warn" ? "bg-warning" : "bg-success"
                    }`}
                  />
                  {t(VERDICT_KEY[verdict])}
                </>
              )}
            </button>
          )}
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <LayerPanel rows={rows} onType={onType} onToggle={toggle} />
        <div className="min-w-0 flex-1">
          {hasRequired ? (
            <PreviewPane
              layers={layers}
              holes={visibleHoles}
              mesh={mesh}
              visibleKeys={visibleKeys}
              layerColors={layerColors}
              side={side}
              onSideChange={pickSide}
              facing={facing}
              onFacingChange={setFacing}
              snapNonce={snapNonce}
              mode={mode}
              onModeChange={setMode}
              notice={previewNotice}
              tab={tab}
              metrics={metrics}
              metricsLoading={metricsLoading}
              findings={findings}
              markers={markers}
              focusTarget={focusTarget}
              focus={focus}
              onFocus={onFocus}
              showDrc={showDrc}
              onShowDrcChange={onShowDrcChange}
              issues={issues}
              issueIndex={issueIndex}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <Layers className="size-12 text-muted-foreground/50" />
              <div className="text-[15px] font-semibold text-foreground">{t("import:missing.title")}</div>
              <p className="max-w-sm text-[12px] leading-relaxed text-muted-foreground">
                {t("import:missing.descriptionPrefix")}{" "}
                <span className="text-foreground">{missing.map((lt) => t(`layers:${lt}`)).join(", ")}</span>.{" "}
                {t("import:missing.descriptionSuffix")}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

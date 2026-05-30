import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, FileX2, Layers } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { LayerPanel, type PanelRow } from "@/components/import/LayerPanel";
import { type StackLayer, type FocusTarget } from "@/components/import/LayerStack";
import { type DrcMarkerInput } from "@/components/preview/DrcMarkers";
import { PreviewPane, type PreviewMode, type PreviewTab } from "@/components/preview/PreviewPane";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { colorFor, sideOf, stackOrder, missingRequired, LAYER_LABELS } from "@/lib/layerColors";
import { api, type BoardMetrics, type LayerType } from "@/lib/api";
import type { FindingCategory, I18nText } from "@/lib/feasibility";
import { parseBoardMesh, type BoardMeshData } from "@/lib/boardMesh";
import { evaluate, overallVerdict, VERDICT_KEY } from "@/lib/feasibility";
import { useShell } from "@/shellStore";
import { useSettings } from "@/settingsStore";
import { useUnitFormat } from "@/i18n/useUnitFormat";

/** Param names carrying a RAW length in mm — formatted via fmtLen at render. */
const LEN_PARAMS = new Set(["len", "w", "h"]);

/** Findings whose hotspots mark a thin feature (drawn as a box). */
const BOX_FINDINGS = new Set(["copper.minTrace"]);
/** Findings whose hotspots are holes — drawn as a ring around the bore. */
const CIRCLE_FINDINGS = new Set(["drill.minHole", "via.plating", "drill.bitSnap"]);
/** Findings whose hotspots are the actual failing strokes — colour-highlighted as
 *  lines at their width (no per-stroke box/tooltip). Silk is split per side, so
 *  match the `silk.line.*` family by prefix. */
const isLineFinding = (id: string) => id.startsWith("silk.line");

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

// Identity is the staged INDEX (not name): files can share a basename, and the
// commit applies layer types positionally in staging order.
export function ImportWizardPage() {
  const staged = useShell((s) => s.staged);
  const staging = useShell((s) => s.staging);
  const stagedZipPaths = useShell((s) => s.stagedZipPaths);
  const setLayerType = useShell((s) => s.setLayerType);
  const confirmImport = useShell((s) => s.confirmImport);
  const cancelImport = useShell((s) => s.cancelImport);
  const stagingError = useShell((s) => s.stagingError);
  const manifest = useShell((s) => s.currentManifest);

  const { t } = useTranslation(["feasibility", "common"]);
  const { fmtLen } = useUnitFormat();
  // Resolve an I18nText to a display string: length params unit-formatted,
  // key-like string params translated, then the text key translated.
  const tr = useCallback(
    (text?: I18nText): string => {
      if (!text) return "";
      const params: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(text.params ?? {})) {
        if (Array.isArray(v)) params[k] = v.map((mm) => fmtLen(mm)).join(", ");
        else if (LEN_PARAMS.has(k) && typeof v === "number") params[k] = fmtLen(v);
        else if (typeof v === "string" && v.includes(":")) params[k] = t(v);
        else params[k] = v;
      }
      return t(text.key, params);
    },
    [t, fmtLen],
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
  // Per-file MANUAL hide toggles by staged INDEX (UI-only, not persisted).
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const overrides = manifest?.layer_colors;
  const profile = useSettings((s) => s.profile);

  // Required layers (the board outline) that must be assigned for a valid,
  // previewable board. While any are missing we skip the (expensive) mesh build
  // and prompt the user to assign them instead of rendering.
  const missing = useMemo(() => missingRequired(staged.map((f) => f.layerType)), [staged]);
  const hasRequired = missing.length === 0;

  // Build the full 3D board mesh in the Rust core (off the UI thread) from the
  // STAGED ZIP bytes — same path as the project view, so the import wizard no
  // longer freezes building geometry in JS and the silk is cut at drill holes.
  // Recomputes only when the file set or a layer-type assignment changes (NOT on
  // visibility toggles — those are a client-side show/hide in Board3D).
  // Hidden DRILL layers are dropped from the 3D mesh entirely (so their holes
  // leave the board, not just the barrels) — a server-side rebuild. Non-drill
  // layers toggle client-side via visibleKeys (instant, no refetch).
  const excludedDrillKeys = useMemo(
    () =>
      staged
        .map((f, i) => ({ f, i }))
        .filter(({ f, i }) => f.layerType === "drill" && hidden.has(i))
        .map(({ i }) => String(i)),
    [staged, hidden],
  );
  const layerTypesKey = staged.map((f) => f.layerType).join(",");
  const excludedKey = excludedDrillKeys.join(",");
  useEffect(() => {
    let cancelled = false;
    // No outline assigned → nothing valid to build; don't spend time on the mesh.
    if (staged.length === 0 || stagedZipPaths.length === 0 || !hasRequired) {
      setMesh(null);
      return;
    }
    const layerTypes = staged.map((f) => f.layerType);
    // Keep the previous mesh visible while recomputing (drill/type change) so the
    // 3D Canvas isn't torn down — that preserves the camera and avoids replaying
    // the intro animation. Only a genuinely empty staging clears it (above).
    (async () => {
      try {
        const buf = await api.stagedBoardMesh(stagedZipPaths, layerTypes, excludedDrillKeys);
        if (!cancelled) setMesh(parseBoardMesh(buf));
      } catch {
        if (!cancelled) setMesh(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stagedZipPaths, layerTypesKey, excludedKey]);

  // Measure manufacturing facts (cheap, off-thread) whenever the file set or a
  // layer-type assignment changes, but only once the required outline is present
  // (same gate as the mesh — nothing to measure without it).
  useEffect(() => {
    let cancelled = false;
    if (staged.length === 0 || stagedZipPaths.length === 0 || !hasRequired) {
      setMetrics(null);
      setMetricsLoading(false);
      return;
    }
    const layerTypes = staged.map((f) => f.layerType);
    setMetricsLoading(true);
    (async () => {
      try {
        const m = await api.stagedBoardMetrics(stagedZipPaths, layerTypes);
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
  }, [stagedZipPaths, layerTypesKey, hasRequired]);

  // Judge measured facts against the capability profile (instant, client-side —
  // re-runs when the profile thresholds change too).
  const findings = useMemo(() => evaluate(metrics, profile), [metrics, profile]);
  const verdict = overallVerdict(findings);

  // Effective visibility: 3D shows every side by default; 2D shows only the
  // selected side (+ shared layers). Manual hides apply in both modes.
  const isVisible = useCallback(
    (type: LayerType, i: number): boolean => {
      if (hidden.has(i)) return false;
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
      return staged.some(
        (f, i) =>
          types.includes(f.layerType) &&
          isVisible(f.layerType, i) &&
          (hside === "both" || sideOf(f.layerType) === hside),
      );
    },
    [staged, isVisible, side],
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
      const hs = findings.find((x) => x.id === fid)?.hotspots?.[hi]?.side;
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
          .map(({ h, i }) => ({
            key: `${f.id}#${i}`,
            a: h.a,
            b: h.b,
            value: fmtLen(h.v),
            label: tr(f.label),
            limit: tr(f.limit),
            detail: tr(f.detail) || undefined,
            severity: f.severity,
            // Line highlights aren't individually focusable (it's a bulk tint).
            focused: shape !== "line" && focus?.fid === f.id && focus?.hi === i,
            shape,
            widthMm: shape === "line" ? h.v : undefined,
          }));
        // Invisible per-cluster hover regions so a tooltip pops on any part of a
        // line-highlighted feature (without one hitbox per stroke).
        const hovers = (f.hoverBoxes ?? [])
          .filter((h) => markerVisible(f.category, h.side))
          .map((h, i) => ({
            key: `${f.id}~hover#${i}`,
            a: h.a,
            b: h.b,
            value: tr(f.measured),
            label: tr(f.label),
            limit: tr(f.limit),
            detail: tr(f.detail) || undefined,
            severity: f.severity,
            focused: false,
            shape: "hover" as const,
          }));
        return [...visual, ...hovers];
      }),
    [findings, focus, markerVisible, tr, fmtLen],
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
    if (f.highlightAll && f.hotspots && f.hotspots.length > 0) {
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
    const h = f.hotspots?.[focus.hi];
    if (!h) return null;
    return { p: [(h.a[0] + h.b[0]) / 2, (h.a[1] + h.b[1]) / 2], spanMm: 18, nonce: focusNonce.current };
  }, [focus, findings]);

  // Layers/drills visible in 3D = those not manually hidden (keyed by staging
  // index, matching the Rust mesh keys). Pure client-side filter — instant.
  const visibleKeys = useMemo(
    () => new Set(staged.map((_, i) => i).filter((i) => !hidden.has(i)).map(String)),
    [staged, hidden],
  );
  // Colour by staging index, for "other" 3D surface layers.
  const layerColors = useMemo(() => {
    const m: Record<string, string> = {};
    staged.forEach((f, i) => {
      m[String(i)] = colorFor(f.layerType, overrides);
    });
    return m;
  }, [staged, overrides]);

  // A drill layer has no SVG preview but DOES have holes to show/hide — treat it
  // as toggleable content just like the other layers.
  const rows: PanelRow[] = useMemo(
    () =>
      staged
        .map((f, i) => {
          const loading = f.svgStatus === "pending";
          const hasContent = f.svgStatus === "loaded" || (f.layerType === "drill" && f.holes.length > 0);
          return {
            key: String(i),
            index: i,
            filename: f.filename,
            type: f.layerType,
            color: colorFor(f.layerType, overrides),
            visible: hasContent && isVisible(f.layerType, i),
            hasPreview: hasContent,
            loading,
            drillError: f.drillError,
          };
        })
        // In 2D only list the selected side's layers (+ shared ones: contour,
        // drill, inner, other = side "both"); 3D lists everything.
        .filter((r) => mode === "3d" || sideOf(r.type) === side || sideOf(r.type) === "both")
        // Sort by physical stack (bottom → top); ties keep staging order.
        .sort((a, b) => stackOrder(a.type) - stackOrder(b.type) || a.index - b.index),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [staged, hidden, overrides, mode, side],
  );

  // Progress badge while per-layer SVGs stream in (2D only — 3D has its own
  // spinner until the mesh is ready).
  const svgTotal = staged.filter((f) => f.svgStatus !== "none").length;
  const svgLoaded = staged.filter((f) => f.svgStatus === "loaded").length;
  const previewNotice = mode === "2d" && svgTotal > 0 && svgLoaded < svgTotal ? `Слои ${svgLoaded}/${svgTotal}` : undefined;

  // Holes from the currently-visible drill layers (each drill file toggles its own).
  const visibleHoles = useMemo(
    () => staged.flatMap((f, i) => (f.layerType === "drill" && isVisible(f.layerType, i) ? f.holes : [])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [staged, hidden, mode, side],
  );

  const layers: StackLayer[] = useMemo(
    () =>
      staged
        .map((f, i) => ({ f, i }))
        .filter(({ f }) => f.svgBody && f.bbox)
        .map(({ f, i }) => ({
          key: String(i),
          svgBody: f.svgBody as string,
          bbox: f.bbox!,
          color: colorFor(f.layerType, overrides),
          visible: isVisible(f.layerType, i),
          type: f.layerType,
          snap: f.snap,
        })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [staged, hidden, overrides, mode, side],
  );

  const toggle = (index: number, visible: boolean) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (visible) next.delete(index);
      else next.add(index);
      return next;
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
        <div className="flex items-center gap-4">
          <h1 className="text-[13px] font-semibold text-foreground">Импорт герберов</h1>
          {hasRequired && (
            <SegmentedControl
              value={tab}
              onChange={setTab}
              options={[
                { value: "preview", label: "Превью" },
                {
                  value: "metrics",
                  label: "Характеристики",
                  icon: metricsLoading ? <Loader2 className="size-3 animate-spin" /> : undefined,
                },
                {
                  value: "feasibility",
                  label: "Проверка",
                  title: metricsLoading ? "Проверяем…" : metrics ? t(VERDICT_KEY[verdict]) : undefined,
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
              title="Открыть проверку"
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
                  <Loader2 className="size-3 animate-spin" /> Проверка…
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
          <Button variant="ghost" onClick={cancelImport}>
            Отмена
          </Button>
          <Button onClick={confirmImport} disabled={staged.length === 0 || !hasRequired}>
            Подтвердить
          </Button>
        </div>
      </div>
      {stagingError && (
        <p className="border-b border-border px-4 py-2 text-[12px] text-destructive">{stagingError}</p>
      )}
      {staging ? (
        <div className="flex min-h-0 flex-1">
          <LayerPanel rows={[]} loading onType={setLayerType} onToggle={toggle} />
          <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 text-[13px] text-muted-foreground">
            <Loader2 className="size-6 animate-spin text-primary" />
            Чтение архива…
          </div>
        </div>
      ) : staged.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <FileX2 className="size-12 text-muted-foreground/50" />
          <div className="text-[15px] font-semibold text-foreground">Не похоже на гербер-архив</div>
          <p className="max-w-sm text-[12px] leading-relaxed text-muted-foreground">
            В выбранном ZIP не найдено ни одного гербер-файла. Убедитесь, что это экспорт
            герберов (KiCad/Protel), а не другой архив.
          </p>
          <Button variant="ghost" onClick={cancelImport}>
            Назад
          </Button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <LayerPanel rows={rows} onType={setLayerType} onToggle={toggle} />
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
                <div className="text-[15px] font-semibold text-foreground">Назначьте обязательные слои</div>
                <p className="max-w-sm text-[12px] leading-relaxed text-muted-foreground">
                  Для построения платы нужно назначить:{" "}
                  <span className="text-foreground">{missing.map((t) => LAYER_LABELS[t]).join(", ")}</span>.
                  Выберите соответствующий тип у нужного файла в списке слева.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import {
  Sun,
  Loader2,
  Square,
  TriangleAlert,
  CheckCircle2,
  XCircle,
  RotateCcw,
} from "lucide-react";
import { api, type ExposeProgress, type ExposeSnapshot } from "@/lib/api";
import { buildExposeRequest } from "@/lib/exposeSnapshot";

// ── Stages that mean a run is active (not yet terminal). ────────────────────
const ACTIVE_STAGES = new Set(["composing", "discovering", "uploading", "starting", "exposing"]);
const TERMINAL_STAGES = new Set(["done", "stopped", "error"]);

// ── Compact countdown formatter ──────────────────────────────────────────────
function formatCountdown(sec: number): string {
  if (sec <= 0) return "0s";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

// ── Read-only panel footprint preview (pure SVG, no editing tools) ───────────

/** Minimal read-only panel preview: FR4 outline + placed design footprints.
 *  No Konva entanglement — just SVG rects scaled to fit. */
function PanelReadOnlyPreview({ snap }: { snap: ExposeSnapshot }) {
  const panel = snap.manifest?.panel;
  if (!panel || panel.width_mm <= 0 || panel.height_mm <= 0) return null;

  // Scale to fit into a fixed viewport.
  const VIEW_W = 480;
  const VIEW_H = 300;
  const scale = Math.min(VIEW_W / panel.width_mm, VIEW_H / panel.height_mm);
  const svgW = panel.width_mm * scale;
  const svgH = panel.height_mm * scale;

  // Collect (designId → first-occurrence index) for stable colour assignment.
  const designIndex: Map<string, number> = new Map();
  let idx = 0;
  for (const inst of panel.instances) {
    if (!designIndex.has(inst.design_id)) {
      designIndex.set(inst.design_id, idx++);
    }
  }
  // Simple palette cycling for footprint fills.
  const PALETTE = [
    "hsl(var(--primary)/.20)",
    "hsl(220 70% 55%/.20)",
    "hsl(160 60% 45%/.20)",
    "hsl(40 80% 55%/.20)",
  ];
  const STROKE_PALETTE = [
    "hsl(var(--primary)/.70)",
    "hsl(220 70% 55%/.70)",
    "hsl(160 60% 45%/.70)",
    "hsl(40 80% 55%/.70)",
  ];

  // Real per-design board extents (mm) carried in the snapshot (same source the
  // drill snapshot uses). Falls back to a small placeholder for a design whose
  // metrics haven't resolved yet (the actual outline is resolved in Rust at run).
  const FALLBACK_W = 20;
  const FALLBACK_H = 20;

  return (
    <div className="flex items-center justify-center py-2">
      <svg
        width={svgW}
        height={svgH}
        viewBox={`0 0 ${svgW} ${svgH}`}
        className="rounded"
        style={{ background: "hsl(var(--pcb-preview, 160 30% 12%))" }}
      >
        {/* Panel outline */}
        <rect
          x={0.5}
          y={0.5}
          width={svgW - 1}
          height={svgH - 1}
          fill="none"
          stroke="hsl(var(--primary)/.9)"
          strokeWidth={1.5}
          rx={2}
        />
        {/* Placed design footprints (real board size from snapshot.placedSizes) */}
        {panel.instances.map((inst) => {
          const ci = (designIndex.get(inst.design_id) ?? 0) % PALETTE.length;
          const size = snap.placedSizes[inst.design_id];
          const boardW = size?.w ?? FALLBACK_W;
          const boardH = size?.h ?? FALLBACK_H;
          // Footprint swaps W/H when the instance is rotated 90°/270°.
          const rotated = inst.rotation_deg === 90 || inst.rotation_deg === 270;
          const fw = (rotated ? boardH : boardW) * scale;
          const fh = (rotated ? boardW : boardH) * scale;
          const x = inst.x_mm * scale;
          const y = inst.y_mm * scale;
          // Clamp to panel bounds so the rect doesn't overflow the SVG.
          const clampedW = Math.min(fw, svgW - x);
          const clampedH = Math.min(fh, svgH - y);
          return (
            <rect
              key={inst.id}
              x={x}
              y={y}
              width={Math.max(clampedW, 2)}
              height={Math.max(clampedH, 2)}
              fill={PALETTE[ci]}
              stroke={STROKE_PALETTE[ci]}
              strokeWidth={1}
              rx={1}
            />
          );
        })}
      </svg>
    </div>
  );
}

// ── Expose params state ─────────────────────────────────────────────────────

interface ExposeParams {
  side: "top" | "bottom";
  mirror: boolean;
  invert: boolean;
  exposureS: number;
  pwm: number;
}

// ── Run state machine ───────────────────────────────────────────────────────

interface RunState {
  active: boolean;
  stage: string;
  message: string;
  progress: ExposeProgress | null;
}

const IDLE_RUN: RunState = { active: false, stage: "idle", message: "", progress: null };

// ── Main editor component ────────────────────────────────────────────────────

/** UV-exposure operation editor. Lives in the separate expose window, receives
 *  the project as a pushed `ExposeSnapshot`. Shows a read-only panel preview,
 *  editable exposure params, and run/progress/stop controls.
 *  Writes to the operation-run journal (best-effort, fire-and-forget). */
export function ExposeOperationEditor({ snapshot }: { snapshot: ExposeSnapshot }) {
  const { t } = useTranslation("expose");

  const hasProject = !!(snapshot.workingDir && snapshot.manifest);
  const panel = snapshot.manifest?.panel ?? null;
  const hasInstances = (panel?.instances.length ?? 0) > 0;

  // ── Params ──────────────────────────────────────────────────────────────
  const [params, setParams] = useState<ExposeParams>({
    side: snapshot.side,
    mirror: snapshot.mirror,
    invert: snapshot.invert,
    exposureS: snapshot.exposureS,
    pwm: snapshot.pwm,
  });

  // Fetch last run's params for this project (prefill defaults once per project).
  const prefillAppliedRef = useRef(false);
  const repeatPrefillRef = useRef(false);

  useEffect(() => {
    prefillAppliedRef.current = false;
    repeatPrefillRef.current = false;
    const path = snapshot.currentPath;
    if (!path) return;
    let active = true;
    void api.operationLog
      .lastParams(path, "expose")
      .then((json) => {
        if (!active || !json || repeatPrefillRef.current || prefillAppliedRef.current) return;
        try {
          const p = JSON.parse(json) as Partial<ExposeParams>;
          prefillAppliedRef.current = true;
          setParams((prev) => ({
            side: p.side ?? prev.side,
            mirror: p.mirror ?? prev.mirror,
            invert: p.invert ?? prev.invert,
            exposureS: p.exposureS ?? prev.exposureS,
            pwm: p.pwm ?? prev.pwm,
          }));
        } catch {
          /* malformed — ignore */
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [snapshot.currentPath]);

  // "Repeat run" prefill from main window (one-shot).
  useEffect(() => {
    let active = true;
    let unlisten: UnlistenFn | null = null;
    void api
      .onExposePrefill((json) => {
        if (!active) return;
        try {
          const p = JSON.parse(json) as Partial<ExposeParams>;
          repeatPrefillRef.current = true;
          prefillAppliedRef.current = true;
          setParams((prev) => ({
            side: p.side ?? prev.side,
            mirror: p.mirror ?? prev.mirror,
            invert: p.invert ?? prev.invert,
            exposureS: p.exposureS ?? prev.exposureS,
            pwm: p.pwm ?? prev.pwm,
          }));
        } catch {
          /* malformed — ignore */
        }
      })
      .then((un) => {
        if (active) unlisten = un;
        else un();
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  // Update params when snapshot changes (main window may update defaults).
  // Only update if not currently running and no repeat prefill is live.
  useEffect(() => {
    if (repeatPrefillRef.current) return;
    setParams((prev) => ({
      ...prev,
      side: snapshot.side,
      mirror: snapshot.mirror,
      invert: snapshot.invert,
      exposureS: snapshot.exposureS,
      pwm: snapshot.pwm,
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.side, snapshot.mirror, snapshot.invert, snapshot.exposureS, snapshot.pwm]);

  // ── Rotation warning ────────────────────────────────────────────────────
  // The compositor supports 0° and 180° (180° maps to the printer's native
  // orientation); only 90°/270° aren't rotated — they'd expose unrotated.
  const hasUnsupportedRotation = (panel?.instances ?? []).some(
    (inst) => inst.rotation_deg === 90 || inst.rotation_deg === 270,
  );

  // ── Run state ────────────────────────────────────────────────────────────
  const [run, setRun] = useState<RunState>(IDLE_RUN);
  const runUidRef = useRef<string | null>(null);

  // Re-attach on mount if a run is already in progress.
  useEffect(() => {
    void api.exposeRun.status().then((s) => {
      if (s.active) {
        setRun({ active: true, stage: s.stage, message: "", progress: null });
      }
    }).catch(() => {});
  }, []);

  // Subscribe to expose://state events.
  useEffect(() => {
    let active = true;
    let unlisten: UnlistenFn | null = null;
    void api.exposeRun
      .onState((p) => {
        if (!active) return;
        setRun((prev) => ({
          ...prev,
          active: ACTIVE_STAGES.has(p.stage),
          stage: p.stage,
          message: p.message,
        }));

        // Journal the terminal outcome (best-effort fire-and-forget).
        if (TERMINAL_STAGES.has(p.stage)) {
          const uid = runUidRef.current;
          if (uid) {
            runUidRef.current = null;
            const outcome =
              p.stage === "done" ? "completed" : p.stage === "error" ? "error" : "stopped";
            void api.operationLog.finish(uid, outcome, 1).catch(() => {});
          }
        }
      })
      .then((un) => {
        if (active) unlisten = un;
        else un();
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  // Subscribe to expose://progress events.
  useEffect(() => {
    let active = true;
    let unlisten: UnlistenFn | null = null;
    void api.exposeRun
      .onProgress((p) => {
        if (!active) return;
        setRun((prev) => ({ ...prev, progress: p }));
      })
      .then((un) => {
        if (active) unlisten = un;
        else un();
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  // ── Handlers ─────────────────────────────────────────────────────────────
  const handleStart = useCallback(async () => {
    const uid = crypto.randomUUID();
    const req = buildExposeRequest(snapshot, { ...params, runUid: uid });
    if (!req) return;

    // Journal start (best-effort, fire-and-forget).
    const projectPath = snapshot.currentPath;
    if (projectPath) {
      runUidRef.current = uid;
      const paramsJson = JSON.stringify(params);
      void api.operationLog
        .start({ runUid: uid, projectPath, opType: "expose", progressTotal: null, paramsJson })
        .catch(() => {});
    }

    setRun({ active: true, stage: "composing", message: "", progress: null });
    try {
      await api.exposeRun.start(req);
    } catch (e) {
      setRun({ active: false, stage: "error", message: String(e), progress: null });
      if (projectPath && runUidRef.current) {
        const u = runUidRef.current;
        runUidRef.current = null;
        void api.operationLog.finish(u, "error", 0).catch(() => {});
      }
    }
  }, [snapshot, params]);

  const handleStop = useCallback(() => {
    void api.exposeRun.stop().catch(() => {});
  }, []);

  // Clear the terminal run state back to idle so a new run can be launched
  // without reopening the window (mirrors the drill editor's run.reset()).
  const handleReset = useCallback(() => {
    setRun(IDLE_RUN);
  }, []);

  // ── Derived display values ────────────────────────────────────────────────
  const stageLabelKey = `stage.${run.stage}`;
  const stageLabel = t([stageLabelKey, "stage.unknown"]);

  const remainingS = run.progress?.remainingS ?? null;
  const percent = run.progress?.percent ?? null;
  const printerState = run.progress?.printerState ?? null;

  const isTerminal = !run.active && TERMINAL_STAGES.has(run.stage);
  const isIdle = !run.active && !TERMINAL_STAGES.has(run.stage);
  const canStart = hasProject && hasInstances && isIdle;

  // ── Empty state ───────────────────────────────────────────────────────────
  if (!hasProject) {
    return (
      <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
        {t("editor.noProject")}
      </div>
    );
  }
  if (!hasInstances) {
    return (
      <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
        {t("editor.noInstances")}
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[#0a0c10]">
      {/* Scrollable content area */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">

        {/* ── Panel preview ─────────────────────────────────────────────── */}
        <section>
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            <Sun className="size-3.5 text-amber-400/70" />
            {t("editor.preview.title")}
          </div>
          <div className="rounded-lg border border-border/50 bg-card/30">
            <PanelReadOnlyPreview snap={snapshot} />
            {panel && (
              <p className="pb-2 text-center text-[11px] text-muted-foreground">
                {t("editor.preview.size", {
                  w: panel.width_mm.toFixed(1),
                  h: panel.height_mm.toFixed(1),
                  n: panel.instances.length,
                })}
              </p>
            )}
          </div>
        </section>

        {/* ── Rotation warning ────────────────────────────────────────────── */}
        {hasUnsupportedRotation && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[12px] text-amber-300">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>{t("editor.rotationWarning")}</span>
          </div>
        )}

        {/* ── Exposure parameters ─────────────────────────────────────────── */}
        <section>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            {t("editor.params.title")}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {/* Side radio */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] text-muted-foreground">{t("editor.params.side")}</label>
              <div className="flex gap-2">
                {(["top", "bottom"] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={run.active}
                    onClick={() => setParams((p) => ({ ...p, side: s }))}
                    className={`flex-1 rounded-md border px-2 py-1 text-[12px] transition-colors ${
                      params.side === s
                        ? "border-primary/60 bg-primary/15 text-primary"
                        : "border-border text-muted-foreground hover:border-primary/30 hover:text-foreground"
                    } disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    {t(`editor.params.side_${s}`)}
                  </button>
                ))}
              </div>
            </div>

            {/* Exposure time */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] text-muted-foreground">{t("editor.params.exposureS")}</label>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={1}
                  max={600}
                  step={5}
                  disabled={run.active}
                  value={params.exposureS}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isNaN(v) && v >= 1) setParams((p) => ({ ...p, exposureS: v }));
                  }}
                  className="w-full rounded-md border border-border bg-input/30 px-2 py-1 text-[12px] text-foreground focus:border-primary/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                />
                <span className="shrink-0 text-[11px] text-muted-foreground">{t("editor.params.seconds")}</span>
              </div>
            </div>

            {/* PWM */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] text-muted-foreground">{t("editor.params.pwm")}</label>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={1}
                  max={255}
                  step={1}
                  disabled={run.active}
                  value={params.pwm}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isNaN(v) && v >= 1 && v <= 255) setParams((p) => ({ ...p, pwm: v }));
                  }}
                  className="w-full rounded-md border border-border bg-input/30 px-2 py-1 text-[12px] text-foreground focus:border-primary/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                />
                <span className="shrink-0 text-[11px] text-muted-foreground">/255</span>
              </div>
            </div>

            {/* Toggles: mirror + invert */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] text-muted-foreground">{t("editor.params.options")}</label>
              <div className="flex flex-col gap-1">
                {(["mirror", "invert"] as const).map((key) => (
                  <label key={key} className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      disabled={run.active}
                      checked={params[key]}
                      onChange={(e) => setParams((p) => ({ ...p, [key]: e.target.checked }))}
                      className="h-3.5 w-3.5 cursor-pointer rounded-sm accent-primary disabled:cursor-not-allowed disabled:opacity-50"
                    />
                    <span className="text-[12px] text-foreground">
                      {t(`editor.params.${key}`)}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ── Run status + progress ────────────────────────────────────────── */}
        {(run.active || TERMINAL_STAGES.has(run.stage)) && (
          <section className="rounded-lg border border-border/50 bg-card/30 px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                {run.active ? (
                  <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
                ) : run.stage === "done" ? (
                  <CheckCircle2 className="size-4 shrink-0 text-success" />
                ) : (
                  <XCircle className="size-4 shrink-0 text-destructive" />
                )}
                <div className="flex flex-col">
                  <span className="text-[12px] font-medium text-foreground">{stageLabel}</span>
                  {run.message && (
                    <span className="text-[11px] text-muted-foreground">{run.message}</span>
                  )}
                </div>
              </div>
              {/* Progress details */}
              {run.active && (
                <div className="flex flex-col items-end gap-0.5 text-right">
                  {percent != null && (
                    <span className="text-[12px] font-semibold tabular-nums text-foreground">
                      {percent.toFixed(0)}%
                    </span>
                  )}
                  {remainingS != null && remainingS > 0 && (
                    <span className="text-[11px] text-muted-foreground">
                      {t("editor.run.remaining", { t: formatCountdown(remainingS) })}
                    </span>
                  )}
                  {printerState && (
                    <span className="text-[10px] text-muted-foreground/70">{printerState}</span>
                  )}
                </div>
              )}
            </div>

            {/* Progress bar */}
            {run.active && percent != null && (
              <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-border/50">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300"
                  style={{ width: `${Math.min(percent, 100)}%` }}
                />
              </div>
            )}
          </section>
        )}
      </div>

      {/* ── Sticky action bar ─────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-border/50 px-4 py-3">
        {run.active ? (
          <button
            type="button"
            onClick={handleStop}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-destructive/50 bg-destructive/15 px-4 py-2.5 text-[13px] font-medium text-destructive transition-colors hover:bg-destructive/25"
          >
            <Square className="size-4" />
            {t("editor.run.stop")}
          </button>
        ) : isTerminal ? (
          <button
            type="button"
            onClick={handleReset}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-card/40 px-4 py-2.5 text-[13px] font-medium text-foreground transition-colors hover:border-primary/50 hover:bg-primary/10"
          >
            <RotateCcw className="size-4" />
            {t("editor.run.newRun")}
          </button>
        ) : (
          <button
            type="button"
            disabled={!canStart}
            onClick={() => void handleStart()}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Sun className="size-4" />
            {t("editor.run.start")}
          </button>
        )}
      </div>
    </div>
  );
}

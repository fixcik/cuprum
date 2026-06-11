import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, AlertTriangle } from "lucide-react";
import type { MillSnapshot } from "@/lib/api";
import { useMillPlan, type MillCutParams } from "@/hooks/useMillPlan";
import { MillMapCanvas } from "@/components/mill/MillMapCanvas";
import { MillParamsCard } from "@/components/mill/MillParamsCard";
import { MillPreflightSummary } from "@/components/mill/MillPreflightSummary";
import { useSettings } from "@/settingsStore";
import { useMachinePosition } from "@/hooks/useMachinePosition";
import { DATUM_CORNERS, type DatumCorner } from "@/lib/datum";

/** Isolation-milling operation editor. Renders the toolpath preview (left) and the
 *  cut-parameter inspector + preflight summary (right) from a pushed `MillSnapshot`
 *  (the editor lives in the separate mill window, so project data arrives via IPC).
 *  Cut params are persisted live to settings (`millDefaults`); the heavy planning is
 *  in Rust (`mill_plan`). Phase 4a is preview-only — the run button is a placeholder. */
export function MillOperationEditor({ snapshot }: { snapshot: MillSnapshot }) {
  const { t } = useTranslation("mill");

  // Cut params live in settings (persisted defaults) — edits write straight back so
  // the next open and the snapshot push stay in sync. The mill window has its own
  // store instance; the bridge re-pushes the snapshot when these change.
  const millDefaults = useSettings((s) => s.millDefaults);
  const setMillDefaults = useSettings((s) => s.setMillDefaults);
  const millDatumCorner = useSettings((s) => s.millDatumCorner);
  const setMillDatumCorner = useSettings((s) => s.setMillDatumCorner);

  const params: MillCutParams = useMemo(
    () => ({
      cutWidthMm: millDefaults.cutWidthMm,
      passes: millDefaults.passes,
      overlap: millDefaults.overlap,
      climb: millDefaults.climb,
      cutDepthMm: millDefaults.cutDepthMm,
      depthPerPassMm: millDefaults.depthPerPassMm,
      feedXyMmMin: millDefaults.feedXyMmMin,
      plungeMmMin: millDefaults.plungeMmMin,
    }),
    [millDefaults],
  );

  const onParamsChange = useCallback(
    (patch: Partial<MillCutParams>) => setMillDefaults(patch),
    [setMillDefaults],
  );

  const { result, extent, hasSource, loading } = useMillPlan(snapshot, params);

  const machineWork = useMachinePosition();

  const hasProject = !!(snapshot.workingDir && snapshot.manifest);

  if (!hasProject || (!loading && !hasSource)) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[#0a0c10] text-slate-500 text-sm">
        {loading ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : (
          <span>{!hasProject ? t("empty.noProject") : t("empty.noCopper")}</span>
        )}
      </div>
    );
  }

  const violationCount = result?.violations.length ?? 0;

  return (
    <div className="relative flex h-full w-full bg-[#0a0c10]">
      {loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#0a0c10]/60">
          <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
        </div>
      )}

      {/* Canvas column */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-3 py-1.5">
          <span className="text-[11px] text-slate-500">{t("toolbar.previewHint")}</span>
        </div>
        <div className="relative flex-1 overflow-hidden">
          {result && extent && (
            <MillMapCanvas
              widthMm={extent.widthMm}
              heightMm={extent.heightMm}
              paths={result.paths}
              violations={result.violations}
              datum={millDatumCorner}
              machineWork={machineWork}
            />
          )}
        </div>
      </div>

      {/* Inspector sidebar */}
      <div className="flex w-[340px] shrink-0 flex-col overflow-y-auto border-l border-border bg-[#0b0e13]">
        <div className="flex flex-col gap-3 p-3">
          {/* Datum corner selector */}
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-card/40 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t("datum.label")}
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {DATUM_CORNERS.map((corner: DatumCorner) => (
                <button
                  key={corner}
                  type="button"
                  onClick={() => setMillDatumCorner(corner)}
                  className={
                    "h-8 rounded-md border px-2 text-[12px] transition-colors " +
                    (millDatumCorner === corner
                      ? "border-primary/50 bg-primary/10 text-slate-100"
                      : "border-border text-muted-foreground hover:border-primary/40")
                  }
                >
                  {t(`datum.${corner}`)}
                </button>
              ))}
            </div>
          </div>

          {/* Cut parameters */}
          <MillParamsCard params={params} onChange={onParamsChange} />
        </div>

        {/* Preflight summary */}
        {result && <MillPreflightSummary estimate={result.estimate} passes={params.passes} />}

        {/* DFM violation warning */}
        {violationCount > 0 && (
          <div className="mx-4 mb-3 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-[12px] text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{t("violations.warning", { count: violationCount })}</span>
          </div>
        )}

        {/* Run button — Phase 4b placeholder (execution not implemented yet) */}
        <div className="mt-auto border-t border-border p-4">
          <button
            type="button"
            disabled
            className="h-10 w-full cursor-not-allowed rounded-lg border border-border bg-muted/30 text-[13px] font-semibold text-muted-foreground"
          >
            {t("run.soon")}
          </button>
          <p className="mt-2 text-center text-[11px] text-muted-foreground/70">
            {t("run.soonHint")}
          </p>
        </div>
      </div>
    </div>
  );
}

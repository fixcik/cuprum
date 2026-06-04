import { useEffect, useMemo, useRef, useState } from "react";
import { api, type GerberFile, type PanelDoc, type Stackup } from "@/lib/api";
import { evaluate, overallVerdict, type Verdict } from "@/lib/feasibility";
import { missingRequired } from "@/lib/layerColors";
import type { CapabilityProfile } from "@/lib/capabilityProfile";
import { useSettings } from "@/settingsStore";
import { drillBitsFromTools } from "@/lib/toolLibrary";

export interface DesignVerdict {
  /** DFM verdict, or null until the required layers (outline + copper) are present. */
  verdict: Verdict | null;
  /** Measured board extent (mm), or null on error. */
  size: { w: number; h: number } | null;
  /** True once metrics have resolved or errored — for progress UIs. */
  settled: boolean;
}

/** Fetch a design's board metrics and derive its DFM verdict + size — the shared
 *  effect behind the gallery card and the add-design picker row, which both did
 *  `projectBoardMetrics → overallVerdict(evaluate(...))` with a cancel guard.
 *
 *  Keyed by the gerber set (path+type), so an unrelated manifest replace handing
 *  the component a fresh `gerbers` array does not re-fetch. */
export function useDesignVerdict(
  workingDir: string | null | undefined,
  gerbers: GerberFile[],
  profile: CapabilityProfile,
  opts: {
    /** Panel to check board fit against (size finding). */
    panel?: PanelDoc | null;
    stackup?: Stackup | null;
    /** Import-time trace token (undefined for disk-opened designs). */
    traceSession?: number;
    /** Called with the metrics' `fresh` flag — e.g. to schedule an artifact flush. */
    onMetrics?: (fresh: boolean) => void;
  } = {},
): DesignVerdict {
  const { panel = null, stackup = null, traceSession, onMetrics } = opts;
  const tools = useSettings((s) => s.tools);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [settled, setSettled] = useState(false);

  const gerbersKey = useMemo(
    () => gerbers.map((g) => `${g.path}:${g.layer_type}`).join(","),
    [gerbers],
  );

  // onMetrics may change identity each render; keep the latest out of the deps.
  const onMetricsRef = useRef(onMetrics);
  onMetricsRef.current = onMetrics;

  useEffect(() => {
    let cancelled = false;
    if (!workingDir) return;
    const hasRequired = missingRequired(gerbers.map((g) => g.layer_type)).length === 0;
    setSettled(false);
    api
      .projectBoardMetrics(
        workingDir,
        gerbers.map((g) => ({ rel: g.path, layerType: g.layer_type })),
        traceSession,
      )
      .then((m) => {
        if (cancelled) return;
        setSize({ w: m.metrics.board.widthMm, h: m.metrics.board.heightMm });
        setVerdict(hasRequired ? overallVerdict(evaluate(m.metrics, profile, panel, stackup, drillBitsFromTools(tools))) : null);
        onMetricsRef.current?.(m.fresh);
        setSettled(true);
      })
      .catch(() => {
        if (cancelled) return;
        setSize(null);
        setVerdict(null);
        setSettled(true); // settled-on-error so progress rings complete
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gerbersKey stands in for `gerbers`
  }, [workingDir, gerbersKey, profile, tools, panel, stackup, traceSession]);

  return { verdict, size, settled };
}

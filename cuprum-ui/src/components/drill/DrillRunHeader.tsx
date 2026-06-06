import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Pause, Wrench, Check } from "lucide-react";
import type { DrillRunPhase } from "@/lib/drillRunState";
import type { DrillRoute } from "@/lib/drillRoute";
import { activeGroupForHole, orderedHoleList } from "@/lib/drillRoute";
import type { DatumCorner } from "@/lib/datum";
import { machinePoint } from "@/lib/datum";
import { groupColor } from "@/components/drill/DrillMapCanvas";
import { useUnitFormat } from "@/i18n/useUnitFormat";

export interface DrillRunHeaderProps {
  phase: DrillRunPhase;
  holesCompleted: number;
  holesTotal: number;
  currentHoleIndex: number | null;
  runStartedAt: number | null;
  route: DrillRoute;
  datum: DatumCorner;
  panelWidthMm: number;
  panelHeightMm: number;
  totalEstimateSec: number;
}

function fmtMmSs(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACTIVE_PHASES: Set<DrillRunPhase> = new Set(["running", "pausing", "stopping"]);

export function DrillRunHeader({
  phase,
  holesCompleted,
  holesTotal,
  currentHoleIndex,
  runStartedAt,
  route,
  datum,
  panelWidthMm,
  panelHeightMm,
  totalEstimateSec,
}: DrillRunHeaderProps) {
  const { t } = useTranslation("drill");
  const { fmtLen } = useUnitFormat();

  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    if (runStartedAt == null || !ACTIVE_PHASES.has(phase)) return;
    const tick = () => setElapsedSec(Math.floor((Date.now() - runStartedAt) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [runStartedAt, phase]);

  const pct = holesTotal > 0 ? holesCompleted / holesTotal : 0;
  const r = 44;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - pct);

  const activeGroup = activeGroupForHole(route, currentHoleIndex);
  const ringColor = activeGroup ? groupColor(activeGroup.gi) : "#4f9cf9";

  const holes = orderedHoleList(route);
  const currentHole =
    currentHoleIndex != null &&
    currentHoleIndex >= 0 &&
    currentHoleIndex < holes.length
      ? holes[currentHoleIndex]
      : null;

  const remaining = Math.max(0, Math.round(totalEstimateSec * (1 - pct)));
  const elapsed = fmtMmSs(elapsedSec);
  const remainingFmt = fmtMmSs(remaining);

  const statusLabel = () => {
    switch (phase) {
      case "running":
      case "pausing":
      case "stopping":
        return t("runHeader.drilling");
      case "paused":
        return t("runHeader.paused");
      case "awaitingToolChange":
        return t("runHeader.toolChange");
      case "done":
        return t("runHeader.done");
      default:
        return null;
    }
  };

  const statusIcon = () => {
    switch (phase) {
      case "running":
      case "pausing":
      case "stopping":
        return <Loader2 className="h-3.5 w-3.5 animate-spin" />;
      case "paused":
        return <Pause className="h-3.5 w-3.5" />;
      case "awaitingToolChange":
        return <Wrench className="h-3.5 w-3.5" />;
      case "done":
        return <Check className="h-3.5 w-3.5" />;
      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col items-center gap-3 px-4 pt-4 pb-3 border-b border-border">
      {/* Progress ring */}
      <svg width={110} height={110} viewBox="0 0 110 110" className="shrink-0">
        {/* Track */}
        <circle
          cx={55}
          cy={55}
          r={r}
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth={6}
        />
        {/* Progress arc */}
        <circle
          cx={55}
          cy={55}
          r={r}
          fill="none"
          stroke={ringColor}
          strokeWidth={6}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 55 55)"
          style={{ transition: "stroke-dashoffset 0.4s ease, stroke 0.3s ease" }}
        />
        {/* Percent text */}
        <text
          x={55}
          y={55}
          textAnchor="middle"
          dominantBaseline="central"
          className="font-mono tabular-nums"
          fill="currentColor"
          fontSize={18}
          fontWeight={600}
        >
          {Math.round(pct * 100)}%
        </text>
      </svg>

      {/* Status label */}
      {statusLabel() && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {statusIcon()}
          <span>{statusLabel()}</span>
        </div>
      )}

      {/* Hole counter */}
      <div className="text-2xl font-semibold tabular-nums text-foreground">
        {holesCompleted}/{holesTotal}
      </div>

      {/* Current bit chip */}
      {activeGroup && (
        <div className="flex items-center gap-1.5 rounded-full border border-border bg-muted/30 px-2.5 py-1 text-xs">
          <span
            className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: groupColor(activeGroup.gi) }}
          />
          <span className="tabular-nums text-slate-300">
            Ø{fmtLen(activeGroup.group.diameterMm)}
          </span>
        </div>
      )}

      {/* Current hole coords */}
      {currentHole && (
        <div className="text-xs tabular-nums text-muted-foreground">
          {(() => {
            const [mx, my] = machinePoint(
              currentHole.xMm,
              currentHole.yMm,
              datum,
              panelWidthMm,
              panelHeightMm,
            );
            return `X${mx.toFixed(2)} Y${my.toFixed(2)}`;
          })()}
        </div>
      )}

      {/* Elapsed / remaining time */}
      {runStartedAt != null && (
        <div className="text-[11px] text-muted-foreground/70">
          {t("runHeader.elapsed", { elapsed, remaining: remainingFmt })}
        </div>
      )}
    </div>
  );
}

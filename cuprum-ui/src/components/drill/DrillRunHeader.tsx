import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Pause, Check } from "lucide-react";
import type { DrillRunPhase } from "@/lib/drillRunState";
import { machineElapsedMs } from "@/lib/drillRunState";
import type { DrillRoute } from "@/lib/drillRoute";
import { activeGroupForHole, orderedHoleList } from "@/lib/drillRoute";
import type { DatumCorner } from "@/lib/datum";
import { machinePoint } from "@/lib/datum";
import { groupColor } from "@/components/drill/DrillMapCanvas";
import { formatDuration } from "@/lib/formatDuration";
import { useUnitFormat } from "@/i18n/useUnitFormat";

export interface DrillRunHeaderProps {
  phase: DrillRunPhase;
  holesCompleted: number;
  holesTotal: number;
  currentHoleIndex: number | null;
  runStartedAt: number | null;
  /** Machine clock (see `DrillRunState`): banked active ms + the start of the in-flight
   *  running interval (null while parked). The displayed "прошло" counts only machine
   *  time, freezing during manual tool changes / pauses. */
  machineActiveMs: number;
  activeSince: number | null;
  /** First tool change of the run (work-Z not bound yet). On the first change the
   *  status reads «Привязка Z», not «Смена сверла» — there is no previous bit to
   *  swap, the operator is just binding Z for bit #1. */
  firstToolChange: boolean;
  route: DrillRoute;
  datum: DatumCorner;
  panelWidthMm: number;
  panelHeightMm: number;
  totalEstimateSec: number;
}


// Ring geometry — compact 92px so the header reads as one horizontal row.
const RING = 92;
const RING_R = 34;
const RING_SW = 7;

export function DrillRunHeader({
  phase,
  holesCompleted,
  holesTotal,
  currentHoleIndex,
  runStartedAt,
  machineActiveMs,
  activeSince,
  firstToolChange,
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
    // "Прошло" tracks MACHINE time only (movement + drilling), frozen during manual
    // tool changes / pauses. While the clock runs (`activeSince` set) tick every second;
    // while parked the value is constant, so one recompute is enough — no interval.
    if (runStartedAt == null) return;
    const tick = () =>
      setElapsedSec(Math.floor(machineElapsedMs(machineActiveMs, activeSince, Date.now()) / 1000));
    tick();
    if (activeSince == null) return;
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [runStartedAt, machineActiveMs, activeSince]);

  const pct = holesTotal > 0 ? holesCompleted / holesTotal : 0;
  const circumference = 2 * Math.PI * RING_R;
  const offset = circumference * (1 - pct);

  // While awaiting a tool change `currentHoleIndex` still points at the just-finished
  // hole (null at the very start), so the chip + coords would show the previous bit
  // or vanish. The bit being installed drills the UPCOMING hole (run-index ===
  // holesCompleted) — show that one, so the Z touch-off header still reads the new
  // bit + its coords.
  const holes = orderedHoleList(route);
  const displayHoleIndex =
    phase === "awaitingToolChange" ? holesCompleted : currentHoleIndex;

  const activeGroup = activeGroupForHole(route, displayHoleIndex);
  // Progress arc takes the current bit's colour; falls back to the Z-axis blue.
  const ringColor = activeGroup ? groupColor(activeGroup.gi) : "hsl(var(--axis-z))";

  const currentHole =
    displayHoleIndex != null &&
    displayHoleIndex >= 0 &&
    displayHoleIndex < holes.length
      ? holes[displayHoleIndex]
      : null;

  const minAbbr = t("preflight.minAbbr");
  const secAbbr = t("preflight.secAbbr");
  const remaining = Math.max(0, Math.round(totalEstimateSec * (1 - pct)));
  const elapsed = formatDuration(elapsedSec, minAbbr, secAbbr);
  const remainingFmt = formatDuration(remaining, minAbbr, secAbbr);

  const statusLabel = (): string | null => {
    switch (phase) {
      // `pausing` still cuts (the bit finishes the current hole), so it reads as
      // drilling; `stopping` is a soft halt → its own label, matching the marker.
      case "running":
      case "pausing":
        return t("runHeader.drilling");
      case "stopping":
        return t("runHeader.stopping");
      case "paused":
        return t("runHeader.paused");
      case "awaitingToolChange":
        return firstToolChange ? t("runHeader.zBind") : t("runHeader.toolChange");
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
        return <Loader2 className="size-3.5 animate-spin" />;
      case "paused":
      case "awaitingToolChange":
      case "stopping":
        return <Pause className="size-3.5" />;
      case "done":
        return <Check className="size-3.5" />;
      default:
        return null;
    }
  };

  const statusCls = (): string => {
    switch (phase) {
      case "paused":
      case "stopping":
        return "text-muted-foreground";
      case "awaitingToolChange":
        return "text-warning";
      case "done":
        return "text-primary";
      default:
        return "text-foreground";
    }
  };

  const label = statusLabel();

  return (
    <div className="border-b border-border px-3 py-3">
      <div className="flex items-center gap-3">
        {/* Progress ring with the percent centred inside */}
        <div className="relative grid shrink-0 place-items-center">
          <svg width={RING} height={RING} viewBox={`0 0 ${RING} ${RING}`} className="-rotate-90">
            <circle
              cx={RING / 2}
              cy={RING / 2}
              r={RING_R}
              fill="none"
              stroke="hsl(var(--muted))"
              strokeWidth={RING_SW}
            />
            <circle
              cx={RING / 2}
              cy={RING / 2}
              r={RING_R}
              fill="none"
              stroke={ringColor}
              strokeWidth={RING_SW}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={offset}
              style={{ transition: "stroke-dashoffset 0.3s ease, stroke 0.3s ease" }}
            />
          </svg>
          <div className="absolute text-center">
            <div className="text-[18px] font-bold leading-none tabular-nums text-foreground">
              {Math.round(pct * 100)}
              <span className="text-[11px] font-medium">%</span>
            </div>
          </div>
        </div>

        {/* Status · counter · bit chip + coords */}
        <div className="min-w-0 flex-1">
          {label && (
            <div className={`flex items-center gap-1.5 text-[12px] font-semibold ${statusCls()}`}>
              {statusIcon()}
              <span>{label}</span>
            </div>
          )}

          <div className="mt-0.5 text-[20px] font-bold tabular-nums text-foreground">
            {holesCompleted}
            <span className="text-[13px] font-medium text-muted-foreground"> / {holesTotal}</span>
          </div>

          <div className="mt-1 flex items-center gap-2 text-[11px]">
            {activeGroup && (
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-2 py-0.5">
                <span
                  className="inline-block size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: groupColor(activeGroup.gi) }}
                />
                <span className="tabular-nums text-foreground">
                  {fmtLen(activeGroup.group.diameterMm)}
                </span>
              </span>
            )}
            {currentHole && (
              <span className="truncate tabular-nums text-muted-foreground">
                {(() => {
                  const [mx, my] = machinePoint(
                    currentHole.xMm,
                    currentHole.yMm,
                    datum,
                    panelWidthMm,
                    panelHeightMm,
                  );
                  return `X ${mx.toFixed(1)} Y ${my.toFixed(1)}`;
                })()}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Elapsed / remaining */}
      {runStartedAt != null && (
        <div className="mt-3 flex items-center justify-between text-[11px] tabular-nums text-muted-foreground">
          <span>{t("runHeader.elapsedShort", { elapsed })}</span>
          <span>{t("runHeader.remainingShort", { remaining: remainingFmt })}</span>
        </div>
      )}
    </div>
  );
}

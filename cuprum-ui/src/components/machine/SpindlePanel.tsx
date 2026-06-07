import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Play, Square } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";
import { api } from "@/lib/api";
import { canMove } from "@/lib/machineControls";

/** SVG ring showing the current spindle output as a percent arc over [0, max].
 *  GRBL reports the S word (clamped to $30), not true shaft RPM, so the friendly
 *  reading is its share of the firmware ceiling: 100 % at S === max. */
function SpindleRing({ rpm, max, size = 64 }: { rpm: number; max: number; size?: number }) {
  const r = (size - 12) / 2;
  const c = 2 * Math.PI * r;
  const k = max > 0 ? Math.min(1, rpm / max) : 0;
  const cx = size / 2;
  const { t } = useTranslation("machine");
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      <circle cx={cx} cy={cx} r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth="5" />
      <circle
        cx={cx}
        cy={cx}
        r={r}
        fill="none"
        stroke="hsl(var(--primary))"
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - k)}
        transform={`rotate(-90 ${cx} ${cx})`}
        style={{ transition: "stroke-dashoffset .12s linear" }}
      />
      <text
        x={cx}
        y={cx - 1}
        textAnchor="middle"
        fontSize="15"
        fontWeight="600"
        fill="hsl(var(--foreground))"
        style={{ fontVariantNumeric: "tabular-nums", fontFamily: "ui-monospace, monospace" }}
      >
        {Math.round(k * 100)}%
      </text>
      <text x={cx} y={cx + 11} textAnchor="middle" fontSize="8" fill="hsl(var(--muted-foreground))">
        {t("spindle.power")}
      </text>
    </svg>
  );
}

/** Redesigned spindle panel: power ring + target slider (when speed is
 *  controllable) + On/Off. The gauge scale is GRBL's max spindle speed ($30,
 *  read on connect) so a maxed spindle reads 100 %; it falls back to the
 *  profile's spindleMaxRpm until $30 is known. On a stock 3018
 *  (`spindleControllable === false`) the slider is hidden and On uses the max. */
export function SpindlePanel() {
  const { t } = useTranslation("machine");
  const cnc = useSettings((s) => s.cncProfile);
  const connected = useMachine((s) => s.connected);
  const state = useMachine((s) => s.status.state);
  const spindle = useMachine((s) => s.status.spindle);
  const grblMax = useMachine((s) => s.maxSpindleRpm);
  const enabled = canMove(state, connected);
  // Real scale: GRBL's $30 once known, else the profile estimate.
  const max = grblMax ?? cnc.spindleMaxRpm;
  // Target RPM is a transient UI choice; default to max. Only meaningful when the
  // spindle speed is controllable. Clamp to the live scale ($30 may be lower).
  const [target, setTarget] = useState(max);
  const clampedTarget = Math.min(target, max);
  const on = spindle > 0;
  // What RPM `On` commands: the chosen target when controllable, else the max.
  const commandRpm = cnc.spindleControllable ? clampedTarget : max;

  // If the spindle is already running, apply the chosen target live by re-commanding
  // M3 S<rpm> — GRBL updates the speed without an off/on cycle. Fired on release
  // (pointer-up / key-up), not on every drag tick, to avoid flooding the serial
  // buffer with intermediate values.
  const applyLive = () => {
    if (on) void api.machine.spindle(true, clampedTarget);
  };

  return (
    <div className="flex items-center gap-3">
      <SpindleRing rpm={spindle} max={max} />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        {cnc.spindleControllable ? (
          <>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground">{t("spindle.target")}</span>
              <span className="font-mono text-[13px] font-semibold tabular-nums text-foreground">
                {clampedTarget}{" "}
                <span className="text-[10px] font-normal text-muted-foreground">{t("spindle.rpm")}</span>
              </span>
            </div>
            <input
              type="range"
              className="w-full accent-primary disabled:opacity-40"
              min={0}
              max={max}
              step={100}
              value={clampedTarget}
              disabled={!enabled}
              onChange={(e) => setTarget(Number(e.target.value))}
              onPointerUp={applyLive}
              onKeyUp={applyLive}
            />
          </>
        ) : (
          <div className="text-[11px] text-muted-foreground">{t("spindle.manual")}</div>
        )}
        <div className="flex items-center gap-2">
          <Button
            variant={on ? "default" : "outline"}
            size="sm"
            className="flex-1"
            disabled={!enabled}
            onClick={() => void api.machine.spindle(true, commandRpm)}
          >
            <Play className="size-3.5" />
            {t("spindle.on")}
          </Button>
          <Button
            variant={!on ? "secondary" : "outline"}
            size="sm"
            className="flex-1"
            disabled={!connected}
            onClick={() => void api.machine.spindle(false, 0)}
          >
            <Square className="size-3.5" />
            {t("spindle.off")}
          </Button>
        </div>
      </div>
    </div>
  );
}

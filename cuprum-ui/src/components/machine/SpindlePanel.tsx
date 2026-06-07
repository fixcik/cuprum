import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Play, Square } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";
import { api } from "@/lib/api";
import { canMove } from "@/lib/machineControls";

/** SVG ring showing current spindle RPM as an arc over [0, max]. */
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
        {Math.round(rpm)}
      </text>
      <text x={cx} y={cx + 11} textAnchor="middle" fontSize="8" fill="hsl(var(--muted-foreground))">
        {t("spindle.rpm")}
      </text>
    </svg>
  );
}

/** Redesigned spindle panel: RPM ring + target slider (when speed is
 *  controllable) + On/Off. On a stock 3018 (`spindleControllable === false`) the
 *  slider is hidden and On uses the profile's max RPM, matching SpindleControl. */
export function SpindlePanel() {
  const { t } = useTranslation("machine");
  const cnc = useSettings((s) => s.cncProfile);
  const connected = useMachine((s) => s.connected);
  const state = useMachine((s) => s.status.state);
  const spindle = useMachine((s) => s.status.spindle);
  const enabled = canMove(state, connected);
  const max = cnc.spindleMaxRpm;
  // Target RPM is a transient UI choice; default to max. Only meaningful when the
  // spindle speed is controllable.
  const [target, setTarget] = useState(max);
  const on = spindle > 0;
  // What RPM `On` commands: the chosen target when controllable, else profile max.
  const commandRpm = cnc.spindleControllable ? target : max;

  return (
    <div className="flex items-center gap-3">
      <SpindleRing rpm={spindle} max={max} />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        {cnc.spindleControllable ? (
          <>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground">{t("spindle.target")}</span>
              <span className="font-mono text-[13px] font-semibold tabular-nums text-foreground">
                {target}{" "}
                <span className="text-[10px] font-normal text-muted-foreground">{t("spindle.rpm")}</span>
              </span>
            </div>
            <input
              type="range"
              className="w-full accent-primary"
              min={0}
              max={max}
              step={100}
              value={target}
              onChange={(e) => setTarget(Number(e.target.value))}
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

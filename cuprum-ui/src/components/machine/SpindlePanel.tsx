import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Play, Square } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";
import { api } from "@/lib/api";
import { canMove } from "@/lib/machineControls";
import { spindleFraction, rpmToSWord, sWordToRpm } from "@/lib/spindle";

/** SVG ring showing the current spindle output as a percent arc over [0, 1].
 *  GRBL reports the S word (clamped to $30), not true shaft RPM, so the friendly
 *  reading is its share of the firmware ceiling: 100 % at S === $30. */
function SpindleRing({ fraction, size = 64 }: { fraction: number; size?: number }) {
  const r = (size - 12) / 2;
  const c = 2 * Math.PI * r;
  const k = Math.min(1, Math.max(0, fraction));
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
 *  controllable) + On/Off. The slider edits REAL shaft RPM (0..physMax from the
 *  profile's spindleMaxRpm); the gauge reads the live power fraction (reported S
 *  over GRBL's $30). Real RPM and the S word are distinct scales, so the target
 *  is converted to an S word before commanding — at $30=1000, physMax=12000 a
 *  12000-RPM target commands M3 S1000 (100 % PWM). On a stock 3018
 *  (`spindleControllable === false`) the slider is hidden and On runs full power. */
export function SpindlePanel() {
  const { t } = useTranslation("machine");
  const cnc = useSettings((s) => s.cncProfile);
  const connected = useMachine((s) => s.connected);
  const state = useMachine((s) => s.status.state);
  const spindle = useMachine((s) => s.status.spindle);
  const grblMax = useMachine((s) => s.maxSpindleRpm);
  const grblMin = useMachine((s) => s.minSpindleRpm);
  const enabled = canMove(state, connected);
  // Physical scale (real RPM at 100 %) — what the slider and readout speak.
  const physMax = cnc.spindleMaxRpm;
  // GRBL S-word ceiling ($30) once known, else assume the firmware already speaks
  // real RPM (sMax === physMax → conversions are identity).
  const sMax = grblMax ?? physMax;
  // GRBL min-speed floor ($31, S-word) as real RPM: below this (but above 0) the
  // spindle still spins at its slowest, so it's the lowest meaningful target. 0
  // (or unknown $31) means no floor. Capped below physMax to stay a valid range.
  const minRpm = Math.min(grblMin ? sWordToRpm(grblMin, physMax, sMax) : 0, physMax);
  // Target is real RPM; default to full. Only meaningful when speed is controllable.
  const [target, setTarget] = useState(physMax);
  const clampedTarget = Math.min(Math.max(target, minRpm), physMax);
  const on = spindle > 0;
  // Live power fraction from the reported S word (0..1) → ring + percent.
  const fraction = spindleFraction(spindle, sMax);
  // What `On` commands, as an S word: the chosen target (scaled) when controllable,
  // else full power ($30).
  const commandS = cnc.spindleControllable ? rpmToSWord(clampedTarget, physMax, sMax) : sMax;

  // If the spindle is already running, apply the chosen target live by re-commanding
  // M3 S<s> — GRBL updates the speed without an off/on cycle. Fired on release
  // (pointer-up / key-up), not on every drag tick, to avoid flooding the serial
  // buffer with intermediate values.
  const applyLive = () => {
    if (on && enabled) void api.machine.spindle(true, commandS);
  };

  return (
    <div className="flex items-center gap-3">
      <SpindleRing fraction={fraction} />
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
              min={minRpm}
              max={physMax}
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
            onClick={() => void api.machine.spindle(true, commandS)}
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

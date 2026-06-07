import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Minus, Plus, ShieldAlert, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";
import { api } from "@/lib/api";

type Axis = "x" | "y" | "z";
const AXES: Axis[] = ["x", "y", "z"];

/** Jog steps (mm) offered while nudging off a stuck switch. Deliberately small —
 *  protection is disabled in this mode, so moves must be deliberate. */
const STEPS_MM = [1, 5] as const;

/** Recovery flow for a stuck limit switch (typically the *far* end after a crash:
 *  both end switches of an axis share one GRBL pin, so the controller can't tell
 *  which end is engaged and `$H` can't pull off it on its own).
 *
 *  Shown whenever a limit pin is reported active (`Pn:` → status.pins). Before
 *  homing, motion is blocked three ways at once — the homing-required lock ($22),
 *  soft limits ($20, whose envelope is meaningless on an unreferenced frame) and
 *  hard limits ($21, the active switch). So "Free the switch" runs `$X` → `$20=0`
 *  → `$21=0`, then offers small RAW jogs (bypassing useJog's envelope clamp, which
 *  would otherwise zero out the very move needed since the position is fake) on the
 *  affected axis in both directions. Once the pin clears, it restores `$20=1`/`$21=1`
 *  and kicks off homing.
 *
 *  Safety: $20/$21 are EEPROM settings, so the disabled state is restored in every
 *  exit path — done/cancel and an unmount/disconnect cleanup — with SoftLimitsNotice
 *  re-asserting on reconnect as a backstop. */
export function LimitRecoveryNotice() {
  const { t } = useTranslation("machine");
  const connected = useMachine((s) => s.connected);
  const pins = useMachine((s) => s.status.pins);
  const runHoming = useMachine((s) => s.runHoming);
  const feed = useSettings((s) => s.cncProfile.jogFeedMmMin);

  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepMm, setStepMm] = useState<number>(STEPS_MM[0]);
  // Axes that were stuck when recovery started; jog controls stay pinned to these
  // even after a pin clears (so an overshoot can be corrected).
  const [recoverAxes, setRecoverAxes] = useState<Axis[]>([]);
  // True while $20/$21 are disabled — drives the restore-on-exit safety net.
  const limitsDisabled = useRef(false);

  const stuck = AXES.filter((a) => pins?.[a]);

  // Best-effort restore if the panel unmounts while protection is still off.
  useEffect(() => {
    return () => {
      if (limitsDisabled.current) {
        void api.machine.sendAwaitOk("$20=1").catch(() => {});
        void api.machine.sendAwaitOk("$21=1").catch(() => {});
        limitsDisabled.current = false;
      }
    };
  }, []);

  // Connection lost mid-recovery: the restore writes would fail, so just drop the
  // local mode. SoftLimitsNotice re-asserts $20 on the next connect.
  useEffect(() => {
    if (!connected && (active || limitsDisabled.current)) {
      limitsDisabled.current = false;
      setActive(false);
    }
  }, [connected, active]);

  if (!connected || (stuck.length === 0 && !active)) return null;

  // Enter recovery: clear the lock, then disable soft + hard limits so the axis
  // can be jogged off the engaged switch. Each write is ok-acked; abort on the
  // first failure so we never think protection is off when it isn't.
  const enter = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.machine.sendAwaitOk("$X");
      await api.machine.sendAwaitOk("$20=0");
      // Mark as soon as the first protection write lands, BEFORE $21=0: if that
      // next write is rejected/dropped, the exit-path restore must still fire
      // (otherwise $20 stays disabled in EEPROM with no cleanup).
      limitsDisabled.current = true;
      await api.machine.sendAwaitOk("$21=0");
      setRecoverAxes(stuck.length > 0 ? stuck : AXES);
      setActive(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // Raw relative jog on one axis — NOT through useJog, whose envelope clamp uses
  // the (currently fake) machine position and would cancel the move.
  const nudge = (axis: Axis, dir: 1 | -1) => {
    if (!active || busy) return;
    const d = dir * stepMm;
    void api.machine.jog(axis === "x" ? d : 0, axis === "y" ? d : 0, axis === "z" ? d : 0, feed);
  };

  const restoreLimits = async () => {
    await api.machine.sendAwaitOk("$20=1");
    await api.machine.sendAwaitOk("$21=1");
    limitsDisabled.current = false;
  };

  // Restore protection and start homing (only enabled once every pin is clear).
  const finishAndHome = async () => {
    setBusy(true);
    setError(null);
    try {
      await restoreLimits();
      setActive(false);
      void runHoming();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // Restore protection and leave recovery without homing.
  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await restoreLimits();
      setActive(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const axesLabel = stuck.map((a) => a.toUpperCase()).join(", ");

  // Prompt: a limit pin is active but we haven't entered recovery yet.
  if (!active) {
    return (
      <div className="anim-in flex flex-col gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-2 text-[12px] text-amber-500">
        <div className="flex items-center gap-2.5">
          <ShieldAlert className="size-4 shrink-0" />
          <span className="flex-1 font-medium">{t("limitRecovery.message", { axes: axesLabel })}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            className="border-amber-500/40 text-amber-500 hover:bg-amber-500/20"
            onClick={() => void enter()}
          >
            {busy ? t("limitRecovery.entering") : t("limitRecovery.enter")}
          </Button>
        </div>
        {error && (
          <span className="pl-[26px] text-[11px] text-red-400">
            {t("limitRecovery.error", { error })}
          </span>
        )}
      </div>
    );
  }

  // Active: protection off, jog the affected axes off the switch.
  return (
    <div className="anim-in flex flex-col gap-2.5 rounded-lg border border-destructive/50 bg-destructive/15 px-3 py-2.5 text-[12px] text-destructive">
      <div className="flex items-center gap-2.5">
        <ShieldOff className="size-4 shrink-0" />
        <span className="flex-1 font-medium">{t("limitRecovery.warning")}</span>
      </div>

      <div className="flex items-center gap-2 pl-[26px]">
        <span className="text-[11px] text-muted-foreground">{t("limitRecovery.step")}</span>
        {STEPS_MM.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStepMm(s)}
            className={`rounded-md border px-2 py-0.5 text-[11px] tabular-nums transition-colors ${
              stepMm === s
                ? "border-destructive/60 bg-destructive/25 text-destructive"
                : "border-border text-muted-foreground hover:bg-foreground/10"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-1.5 pl-[26px]">
        {recoverAxes.map((axis) => {
          const lit = !!pins?.[axis];
          return (
            <div key={axis} className="flex items-center gap-2">
              <span className="w-12 font-mono text-[12px] text-foreground">
                {t("limitRecovery.axis", { axis: axis.toUpperCase() })}
              </span>
              <span
                className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${
                  lit ? "bg-destructive/25 text-destructive" : "bg-emerald-500/20 text-emerald-500"
                }`}
              >
                <span className={`size-1.5 rounded-full ${lit ? "bg-destructive" : "bg-emerald-500"}`} />
                {lit ? t("limitRecovery.stuck") : t("limitRecovery.clear")}
              </span>
              <div className="ml-auto flex items-center gap-1">
                <Button variant="outline" size="sm" disabled={busy} onClick={() => nudge(axis, -1)}>
                  <Minus className="size-3.5" />
                </Button>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => nudge(axis, 1)}>
                  <Plus className="size-3.5" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2 pl-[26px]">
        <Button
          variant="default"
          size="sm"
          disabled={busy || stuck.length > 0}
          onClick={() => void finishAndHome()}
        >
          {t("limitRecovery.home")}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void cancel()}>
          {t("limitRecovery.cancel")}
        </Button>
      </div>

      {error && (
        <span className="pl-[26px] text-[11px] text-red-400">
          {t("limitRecovery.error", { error })}
        </span>
      )}
    </div>
  );
}

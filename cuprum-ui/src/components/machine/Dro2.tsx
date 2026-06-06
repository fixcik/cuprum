import { useTranslation } from "react-i18next";
import { Bookmark, Crosshair, Home, LocateFixed } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";
import { api } from "@/lib/api";
import { canMove } from "@/lib/machineControls";
import { workZeroFromStatus } from "@/lib/workZero";
import { restoreWorkZero } from "@/lib/restoreWorkZero";
import { gotoWorkZero } from "@/lib/gotoZero";
import { cn } from "@/lib/utils";

type Axis = "x" | "y" | "z";
const AXES: Axis[] = ["x", "y", "z"];
const AXIS_LABEL: Record<Axis, string> = { x: "X", y: "Y", z: "Z" };
const AXIS_INDEX: Record<Axis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };
/** axis → CSS var token for the badge background (`--axis-x/y/z`). */
const AXIS_VAR: Record<Axis, string> = { x: "var(--axis-x)", y: "var(--axis-y)", z: "var(--axis-z)" };

/** Leading NBSP for non-negative values keeps the sign column from jumping. */
function signed(v: number, digits = 3): string {
  return `${v >= 0 ? " " : ""}${v.toFixed(digits)}`;
}

function AxisRow({
  axis,
  work,
  machine,
  size,
  movable,
  safeZMm,
}: {
  axis: Axis;
  work: number;
  machine: number;
  size: "md" | "lg";
  movable: boolean;
  safeZMm: number;
}) {
  const { t } = useTranslation("machine");
  const label = AXIS_LABEL[axis];
  const numCls = size === "lg" ? "text-[40px]" : "text-[32px]";

  return (
    <div className="group flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-foreground/[0.03]">
      <span
        className="grid size-7 shrink-0 place-items-center rounded-md text-[13px] font-bold text-background"
        style={{ background: `hsl(${AXIS_VAR[axis]})` }}
      >
        {label}
      </span>
      <div className="flex min-w-0 flex-1 items-baseline">
        <span
          className={cn("font-mono font-semibold leading-none tabular-nums text-foreground", numCls)}
          style={{ letterSpacing: "-0.02em" }}
        >
          {signed(work)}
        </span>
      </div>
      <div className="flex flex-col items-end">
        <span className="text-[9px] uppercase tracking-wide text-muted-foreground/60">
          {t("dro.machineShort")}
        </span>
        <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
          {machine.toFixed(3)}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1 opacity-70 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          title={t("dro.zeroAxis", { axis: label })}
          disabled={!movable}
          onClick={() => void api.machine.setZero(axis === "x", axis === "y", axis === "z")}
          className="grid size-7 place-items-center rounded-md border border-border bg-background text-[11px] font-semibold text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        >
          0
        </button>
        <button
          type="button"
          title={t("dro.gotoAxis", { axis: label })}
          disabled={!movable}
          onClick={() => gotoWorkZero([axis], safeZMm)}
          className="grid size-7 place-items-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        >
          <LocateFixed className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

/** Redesigned hero DRO: large mono work coordinates with small machine readouts,
 *  axis colour badges, per-axis zero/goto buttons, and the work-zero action block
 *  (zero XYZ, go to XY, save zero, home+restore). Reuses the existing work-zero
 *  save/restore logic (workZeroMm, restoreWorkZero, homingAvailable). */
export function Dro2({ size = "lg" }: { size?: "md" | "lg" }) {
  const { t } = useTranslation("machine");
  const status = useMachine((s) => s.status);
  const connected = useMachine((s) => s.connected);
  const state = useMachine((s) => s.status.state);
  const homingAvailable = useMachine((s) => s.homingAvailable);
  const cncProfile = useSettings((s) => s.cncProfile);
  const setCncProfile = useSettings((s) => s.setCncProfile);
  // Zeroing sets the WCS — GRBL rejects it outside Idle/Jog, so gate it with the
  // same canMove() used for jog/home/spindle rather than just `connected`.
  const movable = canMove(state, connected);
  const { workZeroMm, safeZMm } = cncProfile;

  function handleSaveZero() {
    setCncProfile({ workZeroMm: workZeroFromStatus(status.mpos, status.wpos) });
  }

  function handleRestoreZero() {
    if (!workZeroMm) return;
    void (async () => {
      try {
        await restoreWorkZero(workZeroMm);
      } catch (e) {
        useMachine.getState().pushLine({ dir: "rx", text: `restore failed: ${String(e)}` });
      }
    })();
  }

  const canRestore = connected && homingAvailable && workZeroMm !== null && movable;

  return (
    <div className="flex flex-col gap-0.5">
      <div className="mb-1 flex items-center px-2 text-[10px] uppercase tracking-wide text-muted-foreground/60">
        <span className="flex-1">{t("dro.work")}</span>
        <span className="mr-[88px]">{t("dro.wcs")}</span>
      </div>
      {AXES.map((axis) => (
        <AxisRow
          key={axis}
          axis={axis}
          work={status.wpos[AXIS_INDEX[axis]]}
          machine={status.mpos[AXIS_INDEX[axis]]}
          size={size}
          movable={movable}
          safeZMm={safeZMm}
        />
      ))}

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button
          variant="secondary"
          disabled={!movable}
          onClick={() => void api.machine.setZero(true, true, true)}
        >
          <Crosshair className="text-primary" />
          {t("dro.zeroAll")}
        </Button>
        <Button variant="secondary" disabled={!movable} onClick={() => gotoWorkZero(["x", "y"], safeZMm)}>
          <LocateFixed />
          {t("dro.gotoXY")}
        </Button>
        <Button variant="outline" size="sm" disabled={!movable} onClick={handleSaveZero}>
          <Bookmark className="size-3.5" />
          {t("dro.saveZero")}
        </Button>
        <Button variant="outline" size="sm" disabled={!canRestore} onClick={handleRestoreZero}>
          <Home className="size-3.5" />
          {t("dro.restoreZeroShort")}
        </Button>
      </div>

      {workZeroMm && (
        <div className="mt-2 flex items-center gap-1.5 px-2 text-[11px] text-muted-foreground">
          <Bookmark className="size-3 text-muted-foreground/70" />
          {t("dro.zeroSaved", { x: workZeroMm.x.toFixed(3), y: workZeroMm.y.toFixed(3) })}
        </div>
      )}

      {connected && !homingAvailable && workZeroMm && (
        <div className="mt-1 px-2 text-[11px] text-muted-foreground">{t("dro.homingUnavailable")}</div>
      )}
    </div>
  );
}

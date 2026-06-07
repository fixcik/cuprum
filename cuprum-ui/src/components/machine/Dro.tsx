import { useTranslation } from "react-i18next";
import { Crosshair, LocateFixed } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";
import { api } from "@/lib/api";
import { canMove } from "@/lib/machineControls";
import { gotoWorkZero, safeRetractMachineZ } from "@/lib/gotoZero";
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
  canAutoMove,
  retractZ,
  machineZ,
}: {
  axis: Axis;
  work: number;
  machine: number;
  size: "md" | "lg";
  movable: boolean;
  /** Whether machine-coordinate auto-moves (G53 retract) are allowed (homed). */
  canAutoMove: boolean;
  /** Machine-Z target for the safe retract (clearance above work zero, capped). */
  retractZ: number;
  /** Current machine-Z, so the goto can skip the safe-Z lift when already clear. */
  machineZ: number;
}) {
  const { t } = useTranslation("machine");
  const label = AXIS_LABEL[axis];
  const numCls = size === "lg" ? "text-[28px]" : "text-[22px]";

  return (
    <div className="group flex items-center gap-2.5 rounded-lg px-1.5 py-1 transition-colors hover:bg-foreground/[0.03]">
      <span
        className="grid size-6 shrink-0 place-items-center rounded-md text-[12px] font-bold text-background"
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
          className="grid size-6 place-items-center rounded-md border border-border bg-background text-[11px] font-semibold text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        >
          0
        </button>
        <button
          type="button"
          title={canAutoMove ? t("dro.gotoAxis", { axis: label }) : t("controls.homeFirst")}
          disabled={!movable || !canAutoMove}
          onClick={() => void gotoWorkZero([axis], retractZ, machineZ, canAutoMove)}
          className="grid size-6 place-items-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        >
          <LocateFixed className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

/** Hero DRO: large mono work coordinates with small machine readouts, per-axis
 *  colour badges, per-axis zero/goto buttons, and two action buttons — Zero XYZ
 *  (api.machine.setZero) and Go to XY (gotoWorkZero). Persisting/restoring the
 *  work zero is intentionally not here: the datum is set per operation. */
export function Dro({ size = "lg" }: { size?: "md" | "lg" }) {
  const { t } = useTranslation("machine");
  const status = useMachine((s) => s.status);
  const connected = useMachine((s) => s.connected);
  const state = useMachine((s) => s.status.state);
  const homed = useMachine((s) => s.homed);
  const cncProfile = useSettings((s) => s.cncProfile);
  // Zeroing sets the WCS — GRBL rejects it outside Idle/Jog, so gate it with the
  // same canMove() used for jog/home/spindle rather than just `connected`.
  const movable = canMove(state, connected);
  // Machine-coordinate auto-moves (G53 retracts) additionally require a homed
  // frame — otherwise the safe-Z target is meaningless.
  const canAutoMove = movable && homed;
  const { safeZMm, machineSafeZMm } = cncProfile;
  // Safe retract: a clearance above the work-zero surface, capped at the machine
  // ceiling. wcoZ = machine Z of work zero (mpos.z − wpos.z).
  const wcoZ = status.mpos[2] - status.wpos[2];
  const retractZ = safeRetractMachineZ(wcoZ, safeZMm, machineSafeZMm);

  return (
    <div className="flex flex-col gap-0.5">
      <div className="mb-1 flex items-center px-1.5 text-[10px] uppercase tracking-wide text-muted-foreground/60">
        <span className="flex-1">{t("dro.work")}</span>
        <span className="mr-[78px]">{t("dro.wcs")}</span>
      </div>
      {AXES.map((axis) => (
        <AxisRow
          key={axis}
          axis={axis}
          work={status.wpos[AXIS_INDEX[axis]]}
          machine={status.mpos[AXIS_INDEX[axis]]}
          size={size}
          movable={movable}
          canAutoMove={canAutoMove}
          retractZ={retractZ}
          machineZ={status.mpos[2]}
        />
      ))}

      <div className="mt-2 grid grid-cols-2 gap-2">
        <Button
          variant="secondary"
          disabled={!movable}
          onClick={() => void api.machine.setZero(true, true, true)}
        >
          <Crosshair className="text-primary" />
          {t("dro.zeroAll")}
        </Button>
        <Button
          variant="secondary"
          disabled={!canAutoMove}
          title={canAutoMove ? undefined : t("controls.homeFirst")}
          onClick={() => void gotoWorkZero(["x", "y"], retractZ, status.mpos[2], canAutoMove)}
        >
          <LocateFixed />
          {t("dro.gotoXY")}
        </Button>
      </div>

      {connected && !homed && (
        <div className="mt-1 px-2 text-[11px] text-amber-500">{t("dro.notHomed")}</div>
      )}
    </div>
  );
}

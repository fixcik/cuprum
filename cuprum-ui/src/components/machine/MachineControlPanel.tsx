import { useTranslation } from "react-i18next";
import { Fan, LocateFixed, Move, Move3d, SlidersHorizontal, Zap } from "lucide-react";
import { useSettings } from "@/settingsStore";
import { useMachine } from "@/machineStore";
import { canMove } from "@/lib/machineControls";
import { gotoWorkZero, safeRetractMachineZ } from "@/lib/gotoZero";
import { MachineToolbar } from "@/components/machine/MachineToolbar";
import { AlarmBanner } from "@/components/machine/AlarmBanner";
import { SoftLimitsNotice } from "@/components/machine/SoftLimitsNotice";
import { Card } from "@/components/machine/Card";
import { Dro } from "@/components/machine/Dro";
import { JogPad } from "@/components/machine/JogPad";
import { SpindlePanel } from "@/components/machine/SpindlePanel";
import { Overrides } from "@/components/machine/Overrides";
import { QuickActions } from "@/components/machine/QuickActions";
import { FieldPanel } from "@/components/machine/FieldPanel";
import { ConsoleDrawer } from "@/components/machine/ConsoleDrawer";
import { HomingOverlay } from "@/components/machine/HomingOverlay";

/** Live machine control surface, "Classic" layout: a status/connection toolbar,
 *  the alarm banner, a fixed-width control column (coordinates / jog / spindle /
 *  actions) beside the work-field, and a slide-in console drawer. The console
 *  toggle lives in the editor's tab row; its state is passed in.
 *
 *  Keyboard jog (arrows / PgUp·PgDn / 1·2·3) is handled globally inside JogPad,
 *  so it works whenever the panel is mounted and focus isn't in a text field. */
export function MachineControlPanel({
  consoleOpen = false,
  onCloseConsole,
}: {
  consoleOpen?: boolean;
  onCloseConsole?: () => void;
}) {
  const { t } = useTranslation("machine");
  const safeZMm = useSettings((s) => s.cncProfile.safeZMm);
  const machineSafeZMm = useSettings((s) => s.cncProfile.machineSafeZMm);
  const connected = useMachine((s) => s.connected);
  const state = useMachine((s) => s.status.state);
  const machineZ = useMachine((s) => s.status.mpos[2]);
  const workZ = useMachine((s) => s.status.wpos[2]);
  const homed = useMachine((s) => s.homed);
  const homing = useMachine((s) => s.homing);
  const movable = canMove(state, connected);
  // The header "go to zero" runs a machine-frame (G53) retract, so it requires
  // a homed frame in addition to a movable state.
  const canAutoMove = movable && homed;
  // Safe retract: a clearance above the work-zero surface, capped at the machine
  // ceiling. wcoZ = machine Z of work zero (mpos.z − wpos.z).
  const retractZ = safeRetractMachineZ(machineZ - workZ, safeZMm, machineSafeZMm);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MachineToolbar />
      {/* relative anchors the console drawer; on narrow widths the column and
       *  field stack and scroll, on wide (xl) they sit side by side and fill. */}
      <div className="relative flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4 xl:flex-row xl:overflow-hidden">
        {homing && <HomingOverlay />}
        <div className="flex flex-col gap-3 xl:w-[440px] xl:flex-none xl:overflow-auto">
          <AlarmBanner />
          <SoftLimitsNotice />
          <Card
            title={t("dro.coordinates")}
            icon={Move3d}
            right={
              <button
                type="button"
                title={canAutoMove ? t("dro.gotoZero") : t("controls.homeFirst")}
                disabled={!canAutoMove}
                onClick={() => void gotoWorkZero(["z", "x", "y"], retractZ, machineZ, canAutoMove)}
                className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              >
                <LocateFixed className="size-3.5" />
                {t("dro.gotoZero")}
              </button>
            }
          >
            <Dro />
          </Card>
          <Card title={t("jog.title")} icon={Move}>
            <JogPad />
          </Card>
          <Card title={t("spindle.title")} icon={Fan}>
            <SpindlePanel />
          </Card>
          <Card title={t("overrides.title")} icon={SlidersHorizontal}>
            <Overrides />
          </Card>
          <Card title={t("controls.title")} icon={Zap}>
            <QuickActions />
          </Card>
        </div>
        <FieldPanel className="min-h-[20rem] flex-1 xl:min-h-0" />
        <ConsoleDrawer open={consoleOpen} onClose={() => onCloseConsole?.()} />
      </div>
    </div>
  );
}

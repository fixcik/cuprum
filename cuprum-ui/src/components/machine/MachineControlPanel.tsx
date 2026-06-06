import { useTranslation } from "react-i18next";
import { Fan, LocateFixed, Move, Move3d, Zap } from "lucide-react";
import { useSettings } from "@/settingsStore";
import { gotoWorkZero } from "@/lib/gotoZero";
import { MachineToolbar } from "@/components/machine/MachineToolbar";
import { AlarmBanner } from "@/components/machine/AlarmBanner";
import { Card } from "@/components/machine/Card";
import { Dro } from "@/components/machine/Dro";
import { JogPad } from "@/components/machine/JogPad";
import { SpindlePanel } from "@/components/machine/SpindlePanel";
import { QuickActions } from "@/components/machine/QuickActions";
import { FieldPanel } from "@/components/machine/FieldPanel";
import { ConsoleDrawer } from "@/components/machine/ConsoleDrawer";

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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MachineToolbar />
      {/* relative anchors the console drawer; on narrow widths the column and
       *  field stack and scroll, on wide (xl) they sit side by side and fill. */}
      <div className="relative flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4 xl:flex-row xl:overflow-hidden">
        <div className="flex flex-col gap-3 xl:w-[440px] xl:flex-none xl:overflow-auto">
          <AlarmBanner />
          <Card
            title={t("dro.coordinates")}
            icon={Move3d}
            right={
              <button
                type="button"
                title={t("dro.gotoZero")}
                onClick={() => gotoWorkZero(["z", "x", "y"], safeZMm)}
                className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
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

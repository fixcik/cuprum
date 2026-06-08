import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Terminal } from "lucide-react";
import { api } from "@/lib/api";
import { useSettings } from "@/settingsStore";
import { NumberField } from "@/components/settings/fields";
import { CncMachineFields } from "@/components/settings/CncMachineFields";
import { MachineControlPanel } from "@/components/machine/MachineControlPanel";
import type { Machine } from "@/lib/machine";

type CncTab = "config" | "control";

/** Right detail pane of the equipment section: the editor for the selected
 *  machine, dispatched by kind. Empty state when nothing is selected. */
export function MachineEditor({ machine }: { machine: Machine | null }) {
  const { t } = useTranslation("settings");
  const update = useSettings((s) => s.updateMachine);
  // Sub-tabs only apply to CNC machines; reset implicitly when the selected
  // machine changes via the keyed remount in EquipmentSection.
  const [tab, setTab] = useState<CncTab>("config");
  // Console drawer visibility — toggled from the tab row, rendered inside the
  // control panel. Persisted so it survives remounts/tab switches.
  const [consoleOpen, setConsoleOpen] = useState(
    () => localStorage.getItem("cnc.console") === "1",
  );
  const setConsole = (open: boolean) => {
    setConsoleOpen(open);
    localStorage.setItem("cnc.console", open ? "1" : "0");
  };

  // Whether the console is open in its own OS window. Driven by authoritative
  // signals (console:ready / Rust console:closed), same as elsewhere.
  const [consoleWindowOpen, setConsoleWindowOpen] = useState(false);
  useEffect(() => {
    const ps = [
      api.onConsoleReady(() => setConsoleWindowOpen(true)),
      api.onConsoleClosed(() => setConsoleWindowOpen(false)),
    ];
    return () => ps.forEach((p) => void p.then((f) => f()));
  }, []);
  // Auto-hide the in-app drawer once the console pops out to its own window —
  // a stub taking up the sidebar is just clutter when the real console is elsewhere.
  useEffect(() => {
    if (consoleWindowOpen) setConsole(false);
  }, [consoleWindowOpen]);

  // Tab-row button: focus the separate window if it's open, otherwise toggle the
  // in-app drawer. Pop-out (from the drawer header) opens the window, which trips
  // the auto-hide above.
  const onConsoleButton = () => {
    if (consoleWindowOpen) void api.openConsoleWindow();
    else setConsole(!consoleOpen);
  };
  const popOutConsole = () => {
    void api.openConsoleWindow();
    setConsoleWindowOpen(true);
  };

  if (machine === null) {
    return (
      <div className="p-6">
        <p className="text-[12px] text-muted-foreground">{t("equipment.empty")}</p>
      </div>
    );
  }

  if (machine.kind === "cnc") {
    const tabs: CncTab[] = ["config", "control"];
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-border px-6 pt-4">
          <h3 className="mr-2 text-[13px] font-semibold text-foreground">{machine.name}</h3>
          <div className="flex items-center gap-1">
            {tabs.map((tb) => (
              <button
                key={tb}
                type="button"
                onClick={() => setTab(tb)}
                className={`relative px-3 py-2.5 text-[12px] transition-colors ${
                  tab === tb ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t(`equipment.tab.${tb}`)}
                {tab === tb && (
                  <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />
                )}
              </button>
            ))}
          </div>
          {tab === "control" && (
            <button
              type="button"
              onClick={onConsoleButton}
              className={`ml-auto mb-2 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] transition-colors ${
                consoleOpen || consoleWindowOpen
                  ? "border-border bg-muted text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              }`}
            >
              <Terminal className="size-3.5" />
              {t("equipment.console")}
            </button>
          )}
        </div>
        {tab === "config" ? (
          <div className="min-h-0 flex-1 overflow-auto p-6">
            <CncMachineFields machine={machine} />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            <MachineControlPanel
              consoleOpen={consoleOpen}
              onCloseConsole={() => setConsole(false)}
              onPopOut={popOutConsole}
            />
          </div>
        )}
      </div>
    );
  }

  // UV LCD: no sub-tabs, just the screen settings.
  return (
    <div className="min-h-0 flex-1 overflow-auto p-6">
      <h3 className="mb-3 text-[13px] font-semibold text-foreground">{machine.name}</h3>
      <div className="divide-y divide-border/60">
        <NumberField
          label={t("equipment.screenWidth")}
          value={machine.screenWidthMm}
          dim="coarse"
          onChange={(screenWidthMm) => update(machine.id, { screenWidthMm })}
        />
        <NumberField
          label={t("equipment.screenHeight")}
          value={machine.screenHeightMm}
          dim="coarse"
          onChange={(screenHeightMm) => update(machine.id, { screenHeightMm })}
        />
      </div>
    </div>
  );
}

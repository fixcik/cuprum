import { useTranslation } from "react-i18next";
import { SquareTerminal } from "lucide-react";
import { api } from "@/lib/api";

/** Recovery actions shown on any machine alarm/error banner: unlock the machine
 *  ($X) and pop open the console window to inspect the GRBL traffic. Styled with
 *  `currentColor` so it blends into whatever banner hosts it (destructive machine
 *  alarm, rose drill-run error). Direct backend calls — works in any window,
 *  needs no MachineActionsProvider.
 *
 *  `onUnlock` runs right after $X — banners that don't auto-hide on machine state
 *  (e.g. the drill run-error banner, gated on the run's own error phase) pass a
 *  dismiss callback so unlocking also clears the banner. */
export function AlarmActions({
  showUnlock = true,
  onUnlock,
}: {
  showUnlock?: boolean;
  onUnlock?: () => void;
}) {
  const { t } = useTranslation("machine");
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {showUnlock && (
        <button
          type="button"
          onClick={() => {
            void api.machine.unlock();
            onUnlock?.();
          }}
          className="rounded-md border border-current/40 px-2 py-1 text-[11px] font-medium hover:bg-current/10"
        >
          {t("controls.unlock")}
        </button>
      )}
      <button
        type="button"
        title={t("controls.openConsole")}
        aria-label={t("controls.openConsole")}
        onClick={() => void api.openConsoleWindow()}
        className="grid size-7 place-items-center rounded-md hover:bg-current/10"
      >
        <SquareTerminal className="size-4" />
      </button>
    </div>
  );
}

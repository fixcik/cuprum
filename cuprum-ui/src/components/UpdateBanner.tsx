import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useUpdater } from "@/updaterStore";

/** How long the transient "up to date" / "error" toast stays before auto-clearing. */
const TOAST_MS = 4000;

/** Non-intrusive bottom-center banner. Persistent while an update is available /
 *  downloading / restarting (dismissable for the session); plus a transient toast
 *  for the loud manual-check outcomes (up-to-date / error) that auto-clears.
 *  Hidden in idle / checking. */
export function UpdateBanner() {
  const { t } = useTranslation("updater");
  const phase = useUpdater((s) => s.phase);
  const dismissed = useUpdater((s) => s.dismissed);
  const install = useUpdater((s) => s.install);
  const dismiss = useUpdater((s) => s.dismiss);
  const reset = useUpdater((s) => s.reset);

  const transient = phase.kind === "upToDate" || phase.kind === "error";
  const persistent =
    !dismissed &&
    (phase.kind === "available" || phase.kind === "downloading" || phase.kind === "restarting");

  // Auto-clear the transient toast after a few seconds.
  useEffect(() => {
    if (!transient) return;
    const id = setTimeout(reset, TOAST_MS);
    return () => clearTimeout(id);
    // `transient` already derives from phase.kind — listing phase.kind too would
    // double-fire the effect on entry (and can misfire under concurrent rendering).
  }, [transient, reset]);

  if (!transient && !persistent) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center">
      <div className="pointer-events-auto flex min-w-[320px] max-w-[440px] flex-col gap-2 rounded-lg border border-border bg-card px-4 py-3 shadow-lg">
        {phase.kind === "available" && (
          <div className="flex items-center gap-3">
            <span className="flex-1 text-[13px] text-foreground">
              {t("available", { version: phase.version })}
            </span>
            <Button size="sm" onClick={() => void install()}>
              {t("update")}
            </Button>
            <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={t("dismiss")} onClick={dismiss}>
              <X />
            </Button>
          </div>
        )}

        {phase.kind === "downloading" && (
          <div className="flex flex-col gap-2">
            <span className="text-[13px] text-foreground">
              {t("downloading", { percent: phase.percent })}
            </span>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-[width] duration-150"
                style={{ width: `${phase.percent}%` }}
              />
            </div>
          </div>
        )}

        {phase.kind === "restarting" && (
          <span className="text-[13px] text-foreground">{t("restarting")}</span>
        )}

        {transient && (
          <div className="flex items-center gap-3">
            <span className="flex-1 text-[13px] text-foreground">
              {t(phase.kind === "upToDate" ? "upToDate" : "error")}
            </span>
            <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={t("dismiss")} onClick={reset}>
              <X />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

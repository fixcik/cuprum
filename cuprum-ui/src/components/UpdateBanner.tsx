import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useUpdater } from "@/updaterStore";

/** Non-intrusive bottom-center banner announcing an available update, its download
 *  progress, and the post-install restart. Hidden in every other phase (idle /
 *  checking / upToDate / error) and once the user dismisses it for the session. */
export function UpdateBanner() {
  const { t } = useTranslation("updater");
  const phase = useUpdater((s) => s.phase);
  const dismissed = useUpdater((s) => s.dismissed);
  const install = useUpdater((s) => s.install);
  const dismiss = useUpdater((s) => s.dismiss);

  const show =
    !dismissed &&
    (phase.kind === "available" || phase.kind === "downloading" || phase.kind === "restarting");
  if (!show) return null;

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
      </div>
    </div>
  );
}

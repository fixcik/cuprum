import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";
import { issueUrl } from "@/lib/crashReport";
import { useBridgeListeners } from "@/hooks/useTauriListeners";

interface PendingCrash {
  id: number;
  ts: string;
  kind: string;
  message: string;
}

/** Non-intrusive bottom-right banner shown when unreported crashes exist from
 *  the previous session. Offers to open a prefilled GitHub issue or dismiss.
 *  Must be mounted only in the main window. */
export function CrashPrompt() {
  const { t } = useTranslation("crash");
  const [crash, setCrash] = useState<PendingCrash | null>(null);
  const [logDir, setLogDir] = useState<string>("");
  const [visible, setVisible] = useState(false);

  // Check for pending crashes on mount.
  useEffect(() => {
    void api.crash.listPending().then((pending) => {
      if (pending.length > 0) {
        setCrash(pending[0]);
        setVisible(true);
      }
    });
  }, []);

  /** Build report for a specific crash id, open GitHub, mark as reported. */
  const handleReport = async (id: number) => {
    try {
      const report = await api.crash.buildReport(id);
      setLogDir(report.logDir);
      await openUrl(issueUrl(report.title, report.body));
      await api.crash.markReported(id);
    } finally {
      setVisible(false);
    }
  };

  /** Dismiss the crash without reporting. */
  const handleLater = async (id: number) => {
    await api.crash.dismiss(id);
    setVisible(false);
  };

  /** Handle the native menu "Report an Issue…" item: build a report (or empty
   *  template if no crashes) and open GitHub. */
  const handleMenuReport = async () => {
    const report = await api.crash.buildReport(null);
    setLogDir(report.logDir);
    await openUrl(issueUrl(report.title, report.body));
    if (report.id !== null) {
      await api.crash.markReported(report.id);
      setVisible(false);
    }
  };

  // Native menu "Report an Issue…" event — only registered in the main window.
  useBridgeListeners(() => [api.onMenuReportIssue(() => void handleMenuReport())]);

  if (!visible || crash === null) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center">
      <div className="pointer-events-auto flex min-w-[320px] max-w-[440px] flex-col gap-2 rounded-lg border border-border bg-card px-4 py-3 shadow-lg">
        <div className="flex items-start gap-3">
          <div className="flex flex-1 flex-col gap-0.5">
            <span className="text-[13px] font-medium text-foreground">{t("prompt.title")}</span>
            <span className="text-[12px] text-muted-foreground">{t("prompt.body")}</span>
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 shrink-0"
            aria-label={t("prompt.later")}
            onClick={() => void handleLater(crash.id)}
          >
            <X />
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void handleReport(crash.id)}>
            {t("prompt.report")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void handleLater(crash.id)}>
            {t("prompt.later")}
          </Button>
          {logDir && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto text-[12px]"
              onClick={() => void revealItemInDir(logDir)}
            >
              {t("openLogs")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

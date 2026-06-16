import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
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

interface PrefetchedReport {
  id: number | null;
  title: string;
  body: string;
  logDir: string;
}

/** Non-intrusive bottom-right banner shown when unreported crashes exist from
 *  the previous session. Offers to open a prefilled GitHub issue or dismiss.
 *  Must be mounted only in the main window. */
export function CrashPrompt() {
  const { t } = useTranslation("crash");
  const [crash, setCrash] = useState<PendingCrash | null>(null);
  // Prefetched on mount so the report (and its logDir) is ready before any click:
  // building it inside the click handler then flipping `visible` off batched the
  // logDir state update away, leaving the reveal button permanently unreachable.
  const [report, setReport] = useState<PrefetchedReport | null>(null);
  const [visible, setVisible] = useState(false);

  // Check for pending crashes on mount; if any, prefetch the report for the
  // latest one so the reveal-logs button is shown immediately and the report
  // click reuses it. A prefetch failure degrades silently (no logs button; the
  // report click rebuilds in its own try/catch).
  useEffect(() => {
    void (async () => {
      try {
        const pending = await api.crash.listPending();
        if (pending.length === 0) return;
        const latest = pending[pending.length - 1];
        setCrash(latest);
        setVisible(true);
        try {
          const r = await api.crash.buildReport(latest.id);
          setReport(r);
        } catch (e) {
          console.error("[crash] prefetch report failed", e);
        }
      } catch (e) {
        console.error("[crash] listPending failed", e);
      }
    })();
  }, []);

  /** Report the prompted crash: reuse the prefetched report when available,
   *  else rebuild on the fly. Guarded so an openUrl/build reject does not surface
   *  as a global unhandledrejection (which would log a false crash record). */
  const handleReport = async (id: number) => {
    try {
      const r = report ?? (await api.crash.buildReport(id));
      await openUrl(issueUrl(r.title, r.body));
      await api.crash.markReported(id);
    } catch (e) {
      console.error("[crash] report failed", e);
    } finally {
      setVisible(false);
    }
  };

  /** Dismiss the crash without reporting. */
  const handleLater = async (id: number) => {
    try {
      await api.crash.dismiss(id);
    } catch (e) {
      console.error("[crash] dismiss failed", e);
    } finally {
      setVisible(false);
    }
  };

  /** Handle the native menu "Report an Issue…" item: build a report (or empty
   *  template if no crashes) and open GitHub. Guarded so a reject does not surface
   *  as a global unhandledrejection (which would log a false crash record). */
  const handleMenuReport = async () => {
    try {
      const r = await api.crash.buildReport(null);
      await openUrl(issueUrl(r.title, r.body));
      if (r.id !== null) {
        await api.crash.markReported(r.id);
        setVisible(false);
      }
    } catch (e) {
      console.error("[crash] menu report failed", e);
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
          {report?.logDir && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto text-[12px]"
              onClick={() => void revealItemInDir(report.logDir).catch((e) => console.error("[crash] reveal failed", e))}
            >
              {t("openLogs")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

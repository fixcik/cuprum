import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Home } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useMachine } from "@/machineStore";

/** Full-cover overlay shown over the control surface while a homing cycle runs.
 *  GRBL is silent during homing (no position updates), so the progress is an
 *  indeterminate spinner plus an elapsed-seconds counter. The only available
 *  action is aborting (soft-reset) via cancelHoming. Rendered only while
 *  `homing` is true, so the elapsed timer restarts with each cycle. */
export function HomingOverlay() {
  const { t } = useTranslation("machine");
  const cancelHoming = useMachine((s) => s.cancelHoming);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="flex w-[18rem] flex-col items-center gap-4 rounded-xl border border-border bg-card p-6 text-center shadow-lg">
        <div className="relative flex size-14 items-center justify-center">
          <Loader2 className="absolute size-14 animate-spin text-primary/70" />
          <Home className="size-6 text-primary" />
        </div>
        <div>
          <div className="text-sm font-medium">{t("homing.inProgress")}</div>
          <div className="mt-1 tabular-nums text-xs text-muted-foreground">
            {t("homing.elapsed", { seconds: elapsed })}
          </div>
        </div>
        <Button variant="destructive" className="w-full" onClick={cancelHoming}>
          {t("homing.abort")}
        </Button>
      </div>
    </div>
  );
}

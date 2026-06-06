import { useTranslation } from "react-i18next";
import type { MachineStateName } from "@/lib/api";
import { useMachine } from "@/machineStore";
import { cn } from "@/lib/utils";

type Tone = "success" | "info" | "primary" | "warning" | "destructive" | "muted";

/** GRBL state → display tone. States not listed fall back to "muted". */
const STATE_TONE: Partial<Record<MachineStateName, Tone>> = {
  idle: "success",
  jog: "info",
  run: "primary",
  hold: "warning",
  home: "info",
  alarm: "destructive",
  door: "warning",
};

/** Soft (tinted) classes per tone — translucent background + matching text/border. */
const TONE_SOFT: Record<Tone, string> = {
  success: "bg-success/15 text-success border-success/30",
  info: "bg-info/15 text-info border-info/30",
  primary: "bg-primary/15 text-primary border-primary/30",
  warning: "bg-warning/15 text-warning border-warning/30",
  destructive: "bg-destructive/15 text-destructive border-destructive/30",
  muted: "bg-muted/40 text-muted-foreground border-border",
};

const DOT_BG: Record<Tone, string> = {
  success: "bg-success",
  info: "bg-info",
  primary: "bg-primary",
  warning: "bg-warning",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground",
};

/** Compact pill showing the live GRBL machine state, colour-coded by tone.
 *  run / home / jog get a pulsing indicator ring to signal active motion. */
export function StatusPill({ big = false }: { big?: boolean }) {
  const { t } = useTranslation("machine");
  const state = useMachine((s) => s.status.state);
  const tone = STATE_TONE[state] ?? "muted";
  const pulsing = state === "run" || state === "home" || state === "jog";

  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-md border px-2.5 font-semibold",
        big ? "h-9 text-[13px]" : "h-7 text-[12px]",
        TONE_SOFT[tone],
      )}
    >
      <span className={cn("relative flex", big ? "size-2.5" : "size-2")}>
        {pulsing && (
          <span
            className={cn(
              "pulse-ring absolute inline-flex h-full w-full rounded-full opacity-60",
              DOT_BG[tone],
            )}
            style={{ animation: "pulseRing 1.1s ease-in-out infinite" }}
          />
        )}
        <span
          className={cn(
            "relative inline-flex rounded-full",
            big ? "size-2.5" : "size-2",
            DOT_BG[tone],
          )}
        />
      </span>
      {t(`state.${state}`)}
    </div>
  );
}

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, ChevronUp } from "lucide-react";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";
import { api } from "@/lib/api";
import { canMove } from "@/lib/machineControls";

export function JogPad() {
  const { t } = useTranslation("machine");
  const cnc = useSettings((s) => s.cncProfile);
  const setCnc = useSettings((s) => s.setCncProfile);
  const connected = useMachine((s) => s.connected);
  const state = useMachine((s) => s.status.state);
  const enabled = canMove(state, connected);
  // Active jog step — transient UI choice (not persisted); default to the middle
  // step if present, else the first.
  const [step, setStep] = useState(cnc.jogStepsMm[Math.min(1, cnc.jogStepsMm.length - 1)] ?? 1);

  const go = (dx: number, dy: number, dz: number) => {
    if (enabled) void api.machine.jog(dx * step, dy * step, dz * step, cnc.jogFeedMmMin);
  };

  // Keyboard arrow jog: only when enabled and focus is not in an input/textarea.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!enabled) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          go(0, 1, 0);
          break;
        case "ArrowDown":
          e.preventDefault();
          go(0, -1, 0);
          break;
        case "ArrowLeft":
          e.preventDefault();
          go(-1, 0, 0);
          break;
        case "ArrowRight":
          e.preventDefault();
          go(1, 0, 0);
          break;
        case "PageUp":
          e.preventDefault();
          go(0, 0, 1);
          break;
        case "PageDown":
          e.preventDefault();
          go(0, 0, -1);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // go is stable per render; re-register when enabled/step/feed changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, step, cnc.jogFeedMmMin]);

  const cell = "grid size-12 place-items-center rounded-md border border-border bg-card text-foreground hover:bg-accent disabled:opacity-30";

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 text-xs font-medium text-muted-foreground">{t("jog.title")}</div>
      <div className="flex items-start gap-6">
        {/* XY cross */}
        <div className="grid grid-cols-3 grid-rows-3 gap-1.5">
          <div /><button className={cell} disabled={!enabled} onClick={() => go(0, 1, 0)}><ArrowUp className="size-5" /></button><div />
          <button className={cell} disabled={!enabled} onClick={() => go(-1, 0, 0)}><ArrowLeft className="size-5" /></button>
          <div className="grid size-12 place-items-center text-xs text-muted-foreground">XY</div>
          <button className={cell} disabled={!enabled} onClick={() => go(1, 0, 0)}><ArrowRight className="size-5" /></button>
          <div /><button className={cell} disabled={!enabled} onClick={() => go(0, -1, 0)}><ArrowDown className="size-5" /></button><div />
        </div>
        {/* Z column */}
        <div className="flex flex-col gap-1.5">
          <button className={cell} disabled={!enabled} onClick={() => go(0, 0, 1)}><ChevronUp className="size-5" /></button>
          <div className="grid size-12 place-items-center text-xs text-muted-foreground">Z</div>
          <button className={cell} disabled={!enabled} onClick={() => go(0, 0, -1)}><ChevronDown className="size-5" /></button>
        </div>
      </div>
      {/* Step selector */}
      <div className="mt-4 flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{t("jog.step")}</span>
        {cnc.jogStepsMm.map((s) => (
          <button
            key={s}
            onClick={() => setStep(s)}
            className={`rounded-md px-2.5 py-1 text-xs ${step === s ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground"}`}
          >
            {s}
          </button>
        ))}
        <span className="ml-3 text-xs text-muted-foreground">{t("jog.feed")}</span>
        <input
          type="number"
          value={cnc.jogFeedMmMin}
          onChange={(e) => setCnc({ jogFeedMmMin: Number(e.target.value) })}
          className="h-7 w-20 rounded-md border border-border bg-card px-2 text-xs"
        />
      </div>
    </div>
  );
}

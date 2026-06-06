import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export interface DrillFeedSliderProps {
  value: number;
  grblPct: number | undefined;
  onChange: (pct: number) => void;
  disabled?: boolean;
}

export function DrillFeedSlider({ value, grblPct, onChange, disabled }: DrillFeedSliderProps) {
  const { t } = useTranslation("drill");
  const inputRef = useRef<HTMLInputElement>(null);

  // Local state for the live drag display; committed on release.
  const [draft, setDraft] = useState<number | null>(null);
  const display = draft ?? value;

  const commit = () => {
    if (!inputRef.current) return;
    const v = parseInt(inputRef.current.value, 10);
    setDraft(null);
    onChange(v);
  };

  return (
    <div className={`flex flex-col gap-1.5 ${disabled ? "opacity-50 pointer-events-none" : ""}`}>
      {/* Label + live value */}
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{t("feed.label")}</span>
        <span className="tabular-nums font-medium text-foreground">{display}%</span>
      </div>

      {/* Range input: updates draft on every change, commits only on release */}
      <input
        ref={inputRef}
        type="range"
        min={40}
        max={200}
        step={1}
        value={display}
        disabled={disabled}
        className="w-full accent-primary"
        onChange={(e) => setDraft(parseInt(e.target.value, 10))}
        onMouseUp={commit}
        onTouchEnd={commit}
        onBlur={commit}
      />

      {/* GRBL readout when it diverges from the slider value */}
      {grblPct != null && grblPct !== value && (
        <span className="text-[10px] tabular-nums text-muted-foreground/70">
          {t("feed.grbl", { pct: grblPct })}
        </span>
      )}
    </div>
  );
}

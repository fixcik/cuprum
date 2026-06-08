import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export interface DrillFeedSliderProps {
  value: number;
  onChange: (pct: number) => void;
  disabled?: boolean;
}

const FEED_MIN = 40;
const FEED_MAX = 200;
// Track fraction (%) of a feed value — used to place the scale labels under the
// thumb (the native range maps min→max linearly, so 100% is NOT at the centre).
const trackPct = (v: number) => ((v - FEED_MIN) / (FEED_MAX - FEED_MIN)) * 100;

export function DrillFeedSlider({ value, onChange, disabled }: DrillFeedSliderProps) {
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
        min={FEED_MIN}
        max={FEED_MAX}
        step={5}
        value={display}
        disabled={disabled}
        className="w-full accent-primary"
        onChange={(e) => setDraft(parseInt(e.target.value, 10))}
        onMouseUp={commit}
        onTouchEnd={commit}
        onBlur={commit}
      />

      {/* Scale labels positioned at their real track fraction so each sits under the
          thumb at that value (100% is left of centre on a 40–200 range). */}
      <div className="relative h-3 text-[9px] tabular-nums text-muted-foreground">
        <span className="absolute left-0">40%</span>
        <span className="absolute -translate-x-1/2" style={{ left: `${trackPct(100)}%` }}>
          100%
        </span>
        <span className="absolute right-0">200%</span>
      </div>
    </div>
  );
}

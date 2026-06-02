import { cn } from "@/lib/utils";

/** Determinate circular progress (SVG ring). `value` is 0..1, clamped. Stroke
 *  follows currentColor; sized via `className` (set width/height/text color). */
export function ProgressRing({
  value,
  className,
  strokeWidth = 3,
}: {
  value: number;
  className?: string;
  strokeWidth?: number;
}) {
  const v = Math.max(0, Math.min(1, value));
  const r = 50 - strokeWidth * 5; // viewBox 0 0 100 100
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 100 100" className={cn("text-primary", className)} aria-hidden>
      <circle cx="50" cy="50" r={r} fill="none" stroke="currentColor" strokeOpacity={0.2} strokeWidth={strokeWidth} />
      <circle
        cx="50"
        cy="50"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - v)}
        transform="rotate(-90 50 50)"
        style={{ transition: "stroke-dashoffset 200ms linear" }}
      />
    </svg>
  );
}

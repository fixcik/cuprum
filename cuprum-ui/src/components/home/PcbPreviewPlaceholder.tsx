import { cn } from "@/lib/utils";

/** Full-bleed SVG placeholder until a real Gerber preview is available. */
export function PcbPreviewPlaceholder({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 140 105"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("size-full", className)}
      aria-hidden
    >
      <rect width="140" height="105" fill="hsl(var(--pcb-preview))" />

      <g stroke="hsl(158 30% 22%)" strokeWidth="0.5">
        {Array.from({ length: 8 }, (_, i) => (
          <line key={`v${i}`} x1={i * 20} y1="0" x2={i * 20} y2="105" />
        ))}
        {Array.from({ length: 6 }, (_, i) => (
          <line key={`h${i}`} x1="0" y1={i * 21} x2="140" y2={i * 21} />
        ))}
      </g>

      <g
        stroke="hsl(var(--primary))"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.55"
        fill="none"
      >
        <path d="M28 52 H52 L68 36 H92" />
        <path d="M48 68 H72 L88 52 H112" />
        <path d="M36 78 H60 L76 62" />
      </g>

      <g fill="hsl(var(--primary))" opacity="0.7">
        <circle cx="28" cy="52" r="3.5" />
        <circle cx="52" cy="52" r="3.5" />
        <circle cx="68" cy="36" r="3.5" />
        <circle cx="92" cy="36" r="3.5" />
        <circle cx="48" cy="68" r="3.5" />
        <circle cx="72" cy="68" r="3.5" />
        <circle cx="112" cy="52" r="3.5" />
        <circle cx="36" cy="78" r="3.5" />
        <circle cx="60" cy="78" r="3.5" />
      </g>

      <rect
        x="58"
        y="44"
        width="24"
        height="18"
        rx="1.5"
        stroke="hsl(var(--primary))"
        strokeWidth="1"
        fill="hsl(158 40% 18%)"
        opacity="0.9"
      />
      <g fill="hsl(var(--primary))" opacity="0.5">
        {[0, 1, 2, 3].map((i) => (
          <rect key={`lp${i}`} x={60 + i * 5} y="42" width="2" height="2" rx="0.5" />
        ))}
        {[0, 1, 2, 3].map((i) => (
          <rect key={`rp${i}`} x={60 + i * 5} y="62" width="2" height="2" rx="0.5" />
        ))}
      </g>

      <g fill="hsl(var(--background))" opacity="0.6">
        <circle cx="10" cy="10" r="3" />
        <circle cx="130" cy="10" r="3" />
        <circle cx="10" cy="95" r="3" />
        <circle cx="130" cy="95" r="3" />
      </g>
    </svg>
  );
}

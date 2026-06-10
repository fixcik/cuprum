import { Maximize, Minus, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/** Standard zoom step for the +/- buttons (20% in/out). */
export const ZOOM_STEP = 1.2;

interface ZoomToolbarProps {
  /** Current zoom as an already-rounded percentage. */
  zoomPct: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  /** Center button: resets the view (fit-to-screen or real-size, per canvas). */
  onReset: () => void;
  /** Trailing fit-all button. */
  onFit: () => void;
  /** Title/aria for the center reset button; defaults to "Fit". */
  resetLabel?: string;
  /** Leading slot for canvas-specific toggles (e.g. a coordinate crosshair). */
  children?: ReactNode;
  /** Extra classes merged onto the floating container. */
  className?: string;
}

/** Floating bottom-right zoom bar shared by the Konva canvases (editor preview,
 *  panel blank, drill map). The center button shows the live zoom percent and
 *  resets the view; `children` fills a leading slot for canvas-specific toggles.
 *  Positioned bottom-right, clear of the left/top rulers, so no ruler offset is
 *  needed. */
export function ZoomToolbar({
  zoomPct,
  onZoomOut,
  onZoomIn,
  onReset,
  onFit,
  resetLabel,
  children,
  className,
}: ZoomToolbarProps) {
  const { t } = useTranslation("common");
  const reset = resetLabel ?? t("viewer.fitAll");
  return (
    <div
      className={`absolute bottom-2 right-2 flex items-center gap-0.5 rounded-md border border-border bg-card/90 p-0.5 text-muted-foreground [&_button]:cursor-pointer ${className ?? ""}`}
    >
      {children}
      <button
        className="rounded p-1 hover:bg-muted/60"
        aria-label={t("viewer.zoomOut")}
        title={t("viewer.zoomOut")}
        onClick={onZoomOut}
      >
        <Minus className="size-4" />
      </button>
      <button
        className="min-w-12 rounded px-1.5 py-1 text-center text-[11px] tabular-nums hover:bg-muted/60"
        aria-label={reset}
        title={reset}
        onClick={onReset}
      >
        {zoomPct}%
      </button>
      <button
        className="rounded p-1 hover:bg-muted/60"
        aria-label={t("viewer.zoomIn")}
        title={t("viewer.zoomIn")}
        onClick={onZoomIn}
      >
        <Plus className="size-4" />
      </button>
      <button
        className="rounded p-1 hover:bg-muted/60"
        aria-label={t("viewer.fitAll")}
        title={t("viewer.fitAll")}
        onClick={onFit}
      >
        <Maximize className="size-4" />
      </button>
    </div>
  );
}

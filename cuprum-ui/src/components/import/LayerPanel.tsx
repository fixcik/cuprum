import { Loader2 } from "lucide-react";
import type { LayerType } from "@/lib/api";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { Skeleton } from "@/components/ui/Skeleton";
import { LAYER_LABELS, LAYER_ORDER } from "@/lib/layerColors";

export interface PanelRow {
  key: string;
  /** Staged index — the stable identity used by onType/onToggle. */
  index: number;
  filename: string;
  type: LayerType;
  color: string;
  visible: boolean;
  hasPreview: boolean;
  /** This layer's SVG preview is still rendering. */
  loading?: boolean;
  /** Set when a drill file couldn't be parsed (shown as a parse-error badge). */
  drillError?: string | null;
}

export function LayerPanel({
  rows,
  onType,
  onToggle,
  loading = false,
}: {
  rows: PanelRow[];
  onType: (index: number, type: LayerType) => void;
  onToggle: (index: number, visible: boolean) => void;
  /** Whole-panel skeleton while the file list is being classified. */
  loading?: boolean;
}) {
  return (
    <div className="flex h-full w-72 shrink-0 flex-col border-r border-border bg-panel">
      <div className="flex items-center justify-between border-b border-border px-3 py-3">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Слои
        </span>
      </div>
      <ul className="min-h-0 flex-1 overflow-auto">
        {loading
          ? Array.from({ length: 6 }).map((_, i) => (
              <li key={`sk${i}`} className="flex items-center gap-2 border-b border-border px-3 py-2">
                <Skeleton className="size-3 shrink-0 rounded-sm" />
                <div className="min-w-0 flex-1">
                  <Skeleton className="h-3 w-32" />
                  <Skeleton className="mt-1.5 h-7 w-full" />
                </div>
                <Skeleton className="h-5 w-9 rounded-full" />
              </li>
            ))
          : rows.map((r) => (
              <li key={r.key} className="flex items-center gap-2 border-b border-border px-3 py-2">
                <span
                  className="size-3 shrink-0 rounded-sm"
                  style={{ backgroundColor: r.color }}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] text-foreground" title={r.filename}>
                    {r.filename}
                  </div>
                  <Select
                    value={r.type}
                    onChange={(e) => onType(r.index, e.target.value as LayerType)}
                    className="mt-1 h-7"
                  >
                    {LAYER_ORDER.map((t) => (
                      <option key={t} value={t}>
                        {LAYER_LABELS[t]}
                      </option>
                    ))}
                  </Select>
                  {r.loading ? (
                    <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                      <Loader2 className="size-3 animate-spin" /> рендер превью…
                    </div>
                  ) : (
                    !r.hasPreview &&
                    (r.drillError ? (
                      <div className="mt-1 text-[10px] text-destructive" title={r.drillError}>
                        ошибка парсинга
                      </div>
                    ) : (
                      <div className="mt-1 text-[10px] text-muted-foreground">
                        {r.type === "drill" ? "нет отверстий" : "превью недоступно"}
                      </div>
                    ))
                  )}
                </div>
                {r.loading ? (
                  <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <Switch
                    checked={r.visible}
                    onCheckedChange={(v) => onToggle(r.index, v)}
                    disabled={!r.hasPreview}
                  />
                )}
              </li>
            ))}
      </ul>
    </div>
  );
}

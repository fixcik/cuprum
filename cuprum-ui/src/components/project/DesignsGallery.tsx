import { useCallback, useEffect, useState } from "react";
import { Plus, Search, FilePlus2, FolderOpen, Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { DesignCard } from "./DesignCard";
import { DashedAddTile } from "@/components/ui/DashedAddTile";
import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/TextInput";
import { ProgressRing } from "@/components/ui/ProgressRing";
import { Skeleton } from "@/components/ui/Skeleton";
import { rollupVerdicts } from "@/lib/designSummary";
import type { Verdict } from "@/lib/feasibility";
import { useShell } from "@/shellStore";
import { api } from "@/lib/api";

export function DesignsGallery() {
  const { t } = useTranslation("project");
  const manifest = useShell((s) => s.currentManifest);
  const addDesignsFromZips = useShell((s) => s.addDesignsFromZips);
  const addDesignsFromPaths = useShell((s) => s.addDesignsFromPaths);
  const removeDesign = useShell((s) => s.removeDesign);
  const importingCount = useShell((s) => s.importingCount);
  const [dragOver, setDragOver] = useState(false);
  const [query, setQuery] = useState("");
  const [verdicts, setVerdicts] = useState<Record<string, Verdict | null>>({});
  const handleVerdict = useCallback(
    (id: string, v: Verdict | null) => setVerdicts((m) => (m[id] === v ? m : { ...m, [id]: v })),
    [],
  );

  // OS drag-and-drop: drop .zip fab packages straight onto the gallery. The
  // webview event is window-global, but DesignsGallery is only mounted while the
  // Designs tab is active, so the drop target is effectively this view.
  useEffect(() => {
    // `active` guards the narrow window between unmount (tab switch) and the
    // async unlisten() resolving — a late drop event must not import on a stale
    // mount. Mirrors the pattern in AddDesignWindow.
    let active = true;
    const pending = getCurrentWebview().onDragDropEvent((e) => {
      if (!active) return;
      if (e.payload.type === "enter" || e.payload.type === "over") {
        setDragOver(true);
      } else if (e.payload.type === "leave") {
        setDragOver(false);
      } else if (e.payload.type === "drop") {
        setDragOver(false);
        const zips = e.payload.paths.filter((p) => p.toLowerCase().endsWith(".zip"));
        if (zips.length > 0) void addDesignsFromPaths(zips);
      }
    });
    return () => {
      active = false;
      void pending.then((unlisten) => unlisten());
    };
  }, [addDesignsFromPaths]);

  if (!manifest) return null;

  const designs = manifest.designs;
  const q = query.trim().toLowerCase();
  const filtered = q ? designs.filter((d) => d.source_name.toLowerCase().includes(q)) : designs;
  const roll = rollupVerdicts(designs.map((d) => verdicts[d.id]));
  const hasDesigns = designs.length > 0;

  if (!hasDesigns) {
    return (
      <div className="relative h-full">
        <div className="flex h-full items-center justify-center p-6">
          <div className="flex w-full max-w-[460px] flex-col items-center gap-5 rounded-2xl border-2 border-dashed border-border bg-card/30 px-8 py-12 text-center">
            <div className="grid size-14 place-items-center rounded-2xl border border-border bg-card text-primary">
              <FilePlus2 className="size-7" />
            </div>
            <div>
              <div className="text-[15px] font-semibold text-foreground">{t("designs.empty.title")}</div>
              <p className="mx-auto mt-1.5 max-w-[22rem] text-[12px] leading-relaxed text-muted-foreground">{t("designs.empty.desc")}</p>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => void addDesignsFromZips()}>
                <Plus className="size-4" />
                {t("designs.empty.cta")}
              </Button>
              <Button variant="outline" onClick={() => void addDesignsFromZips()}>
                <FolderOpen className="size-4" />
                {t("designs.empty.pick")}
              </Button>
            </div>
          </div>
        </div>
        <DragOverlay show={dragOver} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Sub-header */}
      <div className="shrink-0 border-b border-border px-6 py-3">
        <div className="mx-auto flex max-w-[1120px] items-center gap-3">
          <h1 className="text-[15px] font-semibold text-foreground">{t("designs.title")}</h1>
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">
            {designs.length}
          </span>
          <div className="mx-1 hidden h-4 w-px bg-border sm:block" />
          <div className="hidden items-center text-[11px] text-muted-foreground sm:flex">
            {/* DFM rollup — non-zero counts only, separated by · */}
            {(() => {
              const parts: ReactNode[] = [];
              if (roll.ok)
                parts.push(
                  <span key="ok" className="inline-flex items-center gap-1 text-success">
                    <span className="size-1.5 rounded-full bg-success" />
                    {t("designs.rollup.ok", { count: roll.ok })}
                  </span>,
                );
              if (roll.warn)
                parts.push(
                  <span key="warn" className="inline-flex items-center gap-1 text-warning">
                    <span className="size-1.5 rounded-full bg-warning" />
                    {t("designs.rollup.warn", { count: roll.warn })}
                  </span>,
                );
              if (roll.block)
                parts.push(
                  <span key="block" className="inline-flex items-center gap-1 text-destructive">
                    <span className="size-1.5 rounded-full bg-destructive" />
                    {t("designs.rollup.block", { count: roll.block })}
                  </span>,
                );
              return parts.map((p, i) => (
                <span key={i} className="inline-flex items-center">
                  {i > 0 && <span className="px-1.5 text-border">·</span>}
                  {p}
                </span>
              ));
            })()}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <TextInput
              icon={<Search className="size-3.5" />}
              placeholder={t("designs.search")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-56"
            />
            <Button size="sm" onClick={() => void addDesignsFromZips()}>
              <Plus className="size-3.5" />
              {t("designs.add")}
            </Button>
          </div>
        </div>
      </div>
      {/* Content */}
      <div className="relative min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[1120px] px-6 py-5">
          <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
            <DashedAddTile
              onClick={() => void addDesignsFromZips()}
              icon={<Plus className="size-7" />}
              title={t("designs.addDesign")}
              subtitle={t("designs.dropHintShort")}
              className="min-h-[210px]"
            />
            {Array.from({ length: importingCount }).map((_, i) => (
              <ImportSkeletonCard key={`imp-${i}`} />
            ))}
            {filtered.map((d) => (
              <DesignCard
                key={d.id}
                design={d}
                onOpen={() => void api.openInspectorWindow(d.id)}
                onDelete={() => removeDesign(d.id)}
                onVerdict={handleVerdict}
              />
            ))}
          </div>
          {q && filtered.length === 0 && (
            <p className="mt-4 text-center text-[12px] text-muted-foreground">{t("designs.noResults")}</p>
          )}
        </div>
        <DragOverlay show={dragOver} />
      </div>
    </div>
  );
}

function DragOverlay({ show }: { show: boolean }) {
  const { t } = useTranslation("project");
  if (!show) return null;
  return (
    <div className="pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-primary/10">
      <div className="flex flex-col items-center gap-2 text-primary">
        <Download className="size-8" />
        <span className="text-[14px] font-medium">{t("designs.dropOverlay")}</span>
      </div>
    </div>
  );
}

function ImportSkeletonCard() {
  const { t } = useTranslation("project");
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="grid aspect-[4/3] w-full place-items-center bg-muted/20">
        <div className="flex flex-col items-center gap-2">
          <ProgressRing value={0.45} className="size-10 text-primary" />
          <span className="text-[11px] text-muted-foreground">{t("designs.preparingArtifacts", { done: 0, total: 1 })}</span>
        </div>
      </div>
      <div className="space-y-2 p-3">
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-2.5 w-1/2" />
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import { X, Search } from "lucide-react";
import { api, type AddDesignSnapshot, type ProjectDesign } from "@/lib/api";
import { DesignPickerRow } from "@/components/project/DesignPickerRow";
import { Button } from "@/components/ui/Button";

/** Root of the separate "Add design to panel" window (label "add-design"). */
export function AddDesignWindow() {
  const { t } = useTranslation("project");
  const [snap, setSnap] = useState<AddDesignSnapshot | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    getCurrentWindow().setTitle(t("panel.add.window.title")).catch(() => {});
  }, [t]);

  // Subscribe to snapshots, then announce readiness so the main window sends one.
  // The listener must be live BEFORE we emit `ready`, or the main window's reply
  // can land before the listener is registered and the snapshot is dropped.
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    void api
      .onAddDesignSnapshot((s) => {
        if (active) setSnap(s);
      })
      .then((un) => {
        if (!active) {
          un();
          return;
        }
        unlisten = un;
        void api.emitAddDesignReady(); // emit only after the listener is live
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const designs: ProjectDesign[] = snap?.designs ?? [];
  const workingDir = snap?.workingDir ?? null;
  const panel = snap?.panel ?? { widthMm: 100, heightMm: 100 };
  const filtered = designs.filter((d) =>
    d.source_name.toLowerCase().includes(query.toLowerCase()),
  );
  const selected =
    selectedId && designs.some((d) => d.id === selectedId) ? selectedId : null;
  const selectedDesign = designs.find((d) => d.id === selected) ?? null;

  return (
    <div className="relative flex h-screen w-screen flex-col bg-card text-foreground">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="text-[13px] font-semibold">{t("panel.add.window.title")}</div>
        <button
          type="button"
          onClick={() => void getCurrentWindow().close()}
          aria-label={t("panel.add.close")}
          className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* left: list */}
        <div className="flex w-[320px] shrink-0 flex-col border-r border-border bg-panel">
          <div className="border-b border-border p-3">
            <div className="relative w-full">
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground">
                <Search className="size-3.5" />
              </span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("panel.add.searchPlaceholder")}
                className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <div className="mt-2 px-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t("panel.add.designsHeader")}{" "}
              <span className="font-normal normal-case text-muted-foreground/70">· {designs.length}</span>
            </div>
          </div>
          <ul className="min-h-0 flex-1 space-y-0.5 overflow-auto p-2">
            {workingDir && filtered.length > 0 ? (
              filtered.map((d) => (
                <DesignPickerRow
                  key={d.id}
                  design={d}
                  workingDir={workingDir}
                  panel={panel}
                  selected={d.id === selected}
                  onSelect={() => setSelectedId(d.id)}
                />
              ))
            ) : (
              <li className="px-2 py-6 text-center text-[12px] text-muted-foreground">
                {t("panel.add.empty")}
              </li>
            )}
          </ul>
          {/* import zone — wired in Task 4 */}
        </div>

        {/* right: light preview card (schematic render is Phase 3) */}
        <div className="min-w-0 flex-1 p-6">
          {selectedDesign ? (
            <div className="flex h-full flex-col">
              <div className="flex-1" />
              <div className="text-[15px] font-semibold text-foreground">{selectedDesign.source_name}</div>
              <div className="mt-1 text-[12px] text-muted-foreground">
                {t("designs.layerCount", { count: selectedDesign.gerbers.length })}
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-center text-[12px] text-muted-foreground">
              {t("panel.add.pickHint")}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
        <span className="text-[11px] text-muted-foreground">
          {selectedDesign ? t("panel.add.footerHint") : t("panel.add.footerPick")}
        </span>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => void getCurrentWindow().close()}>
            {t("panel.add.cancel")}
          </Button>
          {/* real add handler wired in Task 5 */}
          <Button size="sm" disabled>
            {t("panel.add.add")}
          </Button>
        </div>
      </div>
    </div>
  );
}

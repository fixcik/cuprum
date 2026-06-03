import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useTranslation } from "react-i18next";
import { X, Search, UploadCloud, Download } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, type AddDesignSnapshot, type ProjectDesign, type PanelDoc } from "@/lib/api";
import { DesignPickerRow } from "@/components/project/DesignPickerRow";
import { Button } from "@/components/ui/Button";
import { evaluate, overallVerdict, type Verdict } from "@/lib/feasibility";
import { missingRequired } from "@/lib/layerColors";
import { useSettings } from "@/settingsStore";
import { VerdictBadge } from "@/components/preview/VerdictBadge";

/** Root of the separate "Add design to panel" window (label "add-design"). */
export function AddDesignWindow() {
  const { t } = useTranslation("project");
  const [snap, setSnap] = useState<AddDesignSnapshot | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const prevIdsRef = useRef<Set<string>>(new Set());
  const snapReceivedRef = useRef(false);
  const profile = useSettings((s) => s.profile);

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

  // Auto-select a freshly imported design when the snapshot updates with a new id.
  useEffect(() => {
    const ids = new Set(designs.map((d) => d.id));
    const freshIds = designs.filter((d) => !prevIdsRef.current.has(d.id));
    if (snapReceivedRef.current && freshIds.length > 0) {
      // Select the most recently imported design (appended last).
      setSelectedId(freshIds[freshIds.length - 1].id);
    }
    snapReceivedRef.current = true;
    prevIdsRef.current = ids;
  }, [designs]);

  // Verdict for the currently selected design (mirrors DesignPickerRow logic).
  const [selVerdict, setSelVerdict] = useState<Verdict | null>(null);
  useEffect(() => {
    setSelVerdict(null);
    if (!selectedDesign || !workingDir) return;
    let cancelled = false;
    const hasRequired = missingRequired(selectedDesign.gerbers.map((g) => g.layer_type)).length === 0;
    const panelDoc: PanelDoc = {
      schema_version: 1,
      width_mm: panel.widthMm,
      height_mm: panel.heightMm,
      origin_x_mm: 0,
      origin_y_mm: 0,
      instances: [],
      tooling_holes: [],
    };
    api
      .projectBoardMetrics(
        workingDir,
        selectedDesign.gerbers.map((g) => ({ rel: g.path, layerType: g.layer_type })),
      )
      .then((m) => {
        if (!cancelled && hasRequired) {
          setSelVerdict(overallVerdict(evaluate(m.metrics, profile, panelDoc)));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedDesign, workingDir, profile, panel.widthMm, panel.heightMm]);

  // Toast state for the add-to-panel result.
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const pending = api.onAddDesignResult((r) => {
      if (r.ok) {
        void getCurrentWindow().close();
      } else {
        setToast(t(r.messageKey, r.params as Record<string, string> | undefined));
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        toastTimerRef.current = setTimeout(() => setToast(null), 2600);
      }
    });
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      void pending.then((un) => un());
    };
  }, [t]);

  const addToPanel = () => {
    if (selected) void api.emitAddDesignAddToPanel(selected);
  };

  const pickZips = useCallback(async () => {
    const picked = await openDialog({
      multiple: true,
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (paths.length > 0) void api.emitAddDesignImport(paths);
  }, []);

  // OS drag-and-drop: accept ZIP files dropped onto this window.
  useEffect(() => {
    const pending = getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === "enter" || e.payload.type === "over") setDragOver(true);
      else if (e.payload.type === "leave") setDragOver(false);
      else if (e.payload.type === "drop") {
        setDragOver(false);
        const zips = e.payload.paths.filter((p) => p.toLowerCase().endsWith(".zip"));
        if (zips.length > 0) void api.emitAddDesignImport(zips);
      }
    });
    return () => void pending.then((un) => un());
  }, []);

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
          <div className="border-t border-border p-2">
            <button
              type="button"
              onClick={() => void pickZips()}
              className="flex w-full flex-col items-center gap-1 rounded-md border-2 border-dashed border-border px-3 py-3 text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
            >
              <UploadCloud className="size-5" />
              <span className="text-[12px] font-medium">{t("panel.add.importTitle")}</span>
              <span className="text-[11px] text-muted-foreground/70">{t("panel.add.importHint")}</span>
            </button>
          </div>
        </div>

        {/* right: preview card with verdict badge */}
        <div className="min-w-0 flex-1 p-6">
          {selectedDesign ? (
            <div className="flex h-full flex-col">
              <div className="flex-1" />
              <div className="text-[15px] font-semibold text-foreground">{selectedDesign.source_name}</div>
              <div className="mt-1 text-[12px] text-muted-foreground">
                {t("designs.layerCount", { count: selectedDesign.gerbers.length })}
              </div>
              {selVerdict && (
                <div className="mt-3">
                  <VerdictBadge verdict={selVerdict} />
                </div>
              )}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-center text-[12px] text-muted-foreground">
              {t("panel.add.pickHint")}
            </div>
          )}
        </div>
      </div>

      {dragOver && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-primary/10">
          <div className="flex flex-col items-center gap-2 text-primary">
            <Download className="size-7" />
            <span className="text-[13px] font-medium">{t("panel.add.dropHint")}</span>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
        <span className="text-[11px] text-muted-foreground">
          {selectedDesign ? t("panel.add.footerHint") : t("panel.add.footerPick")}
        </span>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => void getCurrentWindow().close()}>
            {t("panel.add.cancel")}
          </Button>
          <Button size="sm" disabled={!selected} onClick={addToPanel}>
            {t("panel.add.add")}
          </Button>
        </div>
      </div>

      {toast && (
        <div className="absolute bottom-16 left-1/2 z-20 -translate-x-1/2 rounded-md border border-border bg-popover px-3 py-2 text-[12px] text-foreground shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}

import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import { Loader2, Sun } from "lucide-react";
import { api, type ExposeSnapshot } from "@/lib/api";
import { useSnapshotSubscription } from "@/hooks/useTauriListeners";
import { useShowWindowWhenReady } from "@/hooks/useShowWindowWhenReady";

/** Placeholder panel shown while Phase 4 builds out the real editor. */
function ExposePlaceholder({ snap }: { snap: ExposeSnapshot }) {
  const { t } = useTranslation("expose");
  const panel = snap.manifest?.panel;
  const name = snap.manifest?.name ?? "";
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-6 text-center">
      <div className="flex flex-col items-center gap-3">
        <Sun className="size-12 text-amber-400/70" />
        <h1 className="text-2xl font-semibold text-foreground">{name || t("window.noProject")}</h1>
        {panel && (
          <p className="text-[13px] text-muted-foreground">
            {t("window.panelSize", { w: panel.width_mm.toFixed(1), h: panel.height_mm.toFixed(1) })}
          </p>
        )}
        <p className="mt-2 rounded-md border border-dashed border-border/60 px-4 py-2 text-[12px] text-muted-foreground">
          {t("window.phase4Placeholder")}
        </p>
      </div>
    </div>
  );
}

/** Root of the separate UV-exposure-operation window (label `expose`). Receives
 *  the project as a pushed snapshot from the main window and shows a placeholder
 *  until Phase 4 wires the real editor and run commands. */
export function ExposeWindow() {
  const { t } = useTranslation("expose");

  // Subscribe to project snapshots, announcing readiness only after the listener
  // is live (so the main window's reply can't arrive before it and be dropped).
  const snap = useSnapshotSubscription<ExposeSnapshot>(
    api.onExposeSnapshot,
    api.emitExposeReady,
  );

  // Window is created hidden; reveal it once the first snapshot has rendered.
  useShowWindowWhenReady(snap !== null);

  useEffect(() => {
    getCurrentWindow().setTitle(t("window.title")).catch(() => {});
  }, [t]);

  return (
    <div className="h-screen w-screen overflow-hidden bg-[#0a0c10]">
      {snap ? (
        <ExposePlaceholder snap={snap} />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-slate-500">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      )}
    </div>
  );
}

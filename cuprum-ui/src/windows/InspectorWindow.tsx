import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Loader2 } from "lucide-react";
import { api, type InspectorSnapshot } from "@/lib/api";
import { DesignInspector } from "@/components/project/DesignInspector";
import { useSnapshotSubscription } from "@/hooks/useTauriListeners";
import { useShowWindowWhenReady } from "@/hooks/useShowWindowWhenReady";

/** Root of a per-design inspector window (label `inspector-<designId>`). Thin
 *  remote view: it receives live project snapshots from the main window and sends
 *  edit intents back, while heavy rendering (svg/mesh/metrics) runs locally. */
export function InspectorWindow({ designId }: { designId: string }) {
  const { t } = useTranslation("project");
  // Subscribe first, then announce readiness so the main window's reply can't beat
  // the listener (same ordering as the add-design window).
  const snap = useSnapshotSubscription<InspectorSnapshot>(api.onInspectorSnapshot, api.emitInspectorReady);
  // Window is created hidden; reveal it once the preview has real content (not just
  // the manifest snapshot — the design preview streams in after), so it never
  // flashes the blank webview + boot spinner or an empty/loading preview.
  const [contentReady, setContentReady] = useState(false);
  useShowWindowWhenReady(contentReady);
  // Stable identity so DesignInspector's ready-effect doesn't re-fire on every
  // re-render (snapshots arrive repeatedly); setContentReady(true) is idempotent.
  const onReady = useCallback(() => setContentReady(true), []);

  const manifest = snap?.manifest ?? null;
  const workingDir = snap?.workingDir ?? null;
  const design = manifest?.designs.find((d) => d.id === designId) ?? null;

  // Close when the project goes away or the design is deleted — but only after the
  // first snapshot has arrived (until then `snap` is null = still loading).
  useEffect(() => {
    if (!snap) return;
    if (!manifest || !workingDir || !design) {
      void getCurrentWindow().close();
    }
  }, [snap, manifest, workingDir, design]);

  // Reflect the design name in the OS title bar (updates live on rename).
  useEffect(() => {
    if (design) {
      void getCurrentWindow().setTitle(t("inspector.window.title", { name: design.source_name }));
    }
  }, [design, t]);

  if (!manifest || !workingDir || !design) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-card text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="h-screen w-screen bg-card text-foreground">
      <DesignInspector
        designId={designId}
        manifest={manifest}
        workingDir={workingDir}
        onRenameDesign={(name) => api.emitInspectorRename(designId, name)}
        onSetLayerType={(path, type) => api.emitInspectorSetLayerType(designId, path, type)}
        onArtifactsFresh={(fresh) => api.emitInspectorArtifactsFresh(fresh)}
        onReady={onReady}
      />
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { useShell } from "@/shellStore";
import { api } from "@/lib/api";

const EMPTY: never[] = [];

/** Unique design ids placed on the panel that aren't loaded/in-flight yet. */
export function designIdsToLoad(
  instances: { design_id: string }[],
  known: Record<string, unknown>,
): string[] {
  return Array.from(new Set(instances.map((i) => i.design_id))).filter((id) => !(id in known));
}

/** Decoded top-composite preview images keyed by design id for every placed
 *  instance. Each unique design is fetched once (the composite PNG is disk-cached
 *  in the .cuprum, so the call is cheap) and the decoded HTMLImageElement is shared
 *  across all of its panelized instances; pruned when a design is no longer placed. */
export function useDesignPreviewImages(): Record<string, HTMLImageElement> {
  const instances = useShell((s) => s.currentManifest?.panel?.instances ?? EMPTY);
  const designs = useShell((s) => s.currentManifest?.designs ?? EMPTY);
  const workingDir = useShell((s) => s.workingDir);
  const [images, setImages] = useState<Record<string, HTMLImageElement>>({});
  // In-flight ids: the instances array changes on every placement edit, so without
  // this an in-flight design would be re-fetched/re-decoded before its first load.
  const inFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!workingDir) return;
    let cancelled = false;
    const known: Record<string, unknown> = { ...images };
    inFlight.current.forEach((id) => (known[id] = true));
    designIdsToLoad(instances, known).forEach((id) => {
      const d = designs.find((x) => x.id === id);
      if (!d) return;
      inFlight.current.add(id);
      api
        .renderDesignPreview(
          workingDir,
          id,
          d.gerbers.map((g) => ({ rel: g.path, layerType: g.layer_type })),
        )
        .then(({ pngDataUrl }) => {
          if (cancelled) {
            inFlight.current.delete(id);
            return;
          }
          const img = new Image();
          img.onload = () => {
            inFlight.current.delete(id);
            if (!cancelled) setImages((prev) => ({ ...prev, [id]: img }));
          };
          img.onerror = () => inFlight.current.delete(id);
          img.src = pngDataUrl;
        })
        .catch(() => inFlight.current.delete(id));
    });
    // Prune images + in-flight for designs no longer placed.
    const liveIds = new Set(instances.map((i) => i.design_id));
    inFlight.current.forEach((id) => {
      if (!liveIds.has(id)) inFlight.current.delete(id);
    });
    setImages((prev) => {
      const entries = Object.entries(prev).filter(([id]) => liveIds.has(id));
      return entries.length === Object.keys(prev).length ? prev : Object.fromEntries(entries);
    });
    return () => {
      cancelled = true;
    };
    // `images` read inside only to skip already-loaded ids; omitting it avoids
    // re-running on every fetch completion (mirrors usePlacedBoardSizes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingDir, instances, designs]);

  return images;
}

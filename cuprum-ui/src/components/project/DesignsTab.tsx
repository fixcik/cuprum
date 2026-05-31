import { useEffect, useMemo, useState } from "react";
import { Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { type StackLayer } from "@/components/import/LayerStack";
import { PreviewPane, type PreviewMode } from "@/components/preview/PreviewPane";
import { colorFor, sideOf } from "@/lib/layerColors";
import { api, type Hole } from "@/lib/api";
import { parseBoardMesh, type BoardMeshData } from "@/lib/boardMesh";
import { useShell } from "@/shellStore";

/** Reference library of imported Designs: composite 2D/3D gerber preview plus a
 *  per-Design file list. Designs are added from the panel editor (Phase 2); this
 *  tab is read-only reference. */
export function DesignsTab() {
  const { t } = useTranslation(["project", "layers"]);
  const manifest = useShell((s) => s.currentManifest);
  const workingDir = useShell((s) => s.workingDir);
  const addDesignsFromZips = useShell((s) => s.addDesignsFromZips);

  const [layers, setLayers] = useState<StackLayer[]>([]);
  const [settled, setSettled] = useState(0);
  const [holes, setHoles] = useState<Hole[]>([]);
  const [mesh, setMesh] = useState<BoardMeshData | null>(null);
  const [mode, setMode] = useState<PreviewMode>("2d");
  const [side, setSide] = useState<"top" | "bottom">("top");

  const layerColors = useMemo(() => {
    const m: Record<string, string> = {};
    if (manifest) {
      for (const design of manifest.designs) {
        for (const g of design.gerbers) m[g.path] = colorFor(g.layer_type, manifest.layer_colors);
      }
    }
    return m;
  }, [manifest]);

  const shownLayers = useMemo(
    () =>
      layers.map((l) => {
        const s = sideOf(l.type);
        return { ...l, visible: mode === "3d" || s === side || s === "both" };
      }),
    [layers, mode, side],
  );

  useEffect(() => {
    let cancelled = false;
    if (!manifest || !workingDir) {
      setLayers([]);
      return;
    }
    const gerbers = manifest.designs.flatMap((design) =>
      design.gerbers.filter((g) => g.layer_type !== "drill"),
    );
    const slots: (StackLayer | null)[] = gerbers.map(() => null);
    setLayers([]);
    setSettled(0);
    const markSettled = () => {
      if (!cancelled) setSettled((n) => n + 1);
    };
    gerbers.forEach((g, idx) => {
      api
        .renderGerberSvg(workingDir, g.path)
        .then((geo) => {
          if (cancelled) return;
          slots[idx] = {
            key: g.path,
            svgBody: geo.svgBody,
            bbox: geo.bbox,
            color: colorFor(g.layer_type, manifest.layer_colors),
            visible: sideOf(g.layer_type) !== "bottom",
            type: g.layer_type,
            snap: geo.snap,
          };
          setLayers(slots.filter(Boolean) as StackLayer[]);
        })
        .catch(() => {})
        .finally(markSettled);
    });
    return () => {
      cancelled = true;
    };
  }, [manifest, workingDir]);

  const renderableTotal = useMemo(
    () =>
      manifest
        ? manifest.designs.reduce(
            (n, design) => n + design.gerbers.filter((g) => g.layer_type !== "drill").length,
            0,
          )
        : 0,
    [manifest],
  );
  const totalGerbers = useMemo(
    () => (manifest ? manifest.designs.reduce((n, design) => n + design.gerbers.length, 0) : 0),
    [manifest],
  );
  const previewNotice =
    mode === "2d" && renderableTotal > 0 && settled < totalGerbers
      ? t("layersProgress", { loaded: layers.length, total: renderableTotal })
      : undefined;

  useEffect(() => {
    let cancelled = false;
    if (!manifest || !workingDir) {
      setHoles([]);
      return;
    }
    setHoles([]);
    (async () => {
      const allHoles: Hole[] = [];
      for (const design of manifest.designs) {
        for (const g of design.gerbers) {
          if (g.layer_type === "drill") {
            try {
              const h = await api.readDrill(workingDir, g.path);
              allHoles.push(...h);
            } catch {
              // Skip unreadable drill files.
            }
          }
        }
      }
      if (!cancelled) setHoles(allHoles);
    })();
    return () => {
      cancelled = true;
    };
  }, [manifest, workingDir]);

  useEffect(() => {
    let cancelled = false;
    if (!manifest || !workingDir) {
      setMesh(null);
      return;
    }
    setMesh(null);
    const gerbers = manifest.designs.flatMap((design) =>
      design.gerbers.map((g) => ({ rel: g.path, layerType: g.layer_type })),
    );
    (async () => {
      try {
        const buf = await api.projectBoardMesh(workingDir, gerbers);
        if (!cancelled) setMesh(parseBoardMesh(buf));
      } catch {
        if (!cancelled) setMesh(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [manifest, workingDir]);

  if (!manifest) return null;

  return (
    <div className="flex h-full min-h-0">
      <div className="w-80 shrink-0 overflow-auto border-r border-border p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t("importedPackages")}
          </span>
          <Button variant="ghost" size="sm" onClick={addDesignsFromZips}>
            <Upload className="size-4" /> {t("importZip")}
          </Button>
        </div>
        {manifest.designs.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">{t("noPackages")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {manifest.designs.map((design) => (
              <li key={design.id} className="rounded-lg border border-border bg-card p-3">
                <div className="text-[13px] font-medium text-foreground">{design.source_name}</div>
                <ul className="mt-1 flex flex-col gap-1">
                  {design.gerbers.map((g) => (
                    <li key={g.path} className="flex items-center gap-2 text-[11px]">
                      <span
                        className="size-2.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: colorFor(g.layer_type, manifest.layer_colors) }}
                        aria-hidden
                      />
                      <span className="truncate text-foreground">{g.path.split("/").pop()}</span>
                      <span className="ml-auto shrink-0 text-muted-foreground">{t(`layers:${g.layer_type}`)}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <PreviewPane
          layers={shownLayers}
          holes={holes}
          mesh={mesh}
          layerColors={layerColors}
          side={side}
          onSideChange={setSide}
          mode={mode}
          onModeChange={setMode}
          notice={previewNotice}
        />
      </div>
    </div>
  );
}

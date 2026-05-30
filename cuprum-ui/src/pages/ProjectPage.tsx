import { useEffect, useMemo, useState } from "react";
import { Upload } from "lucide-react";
import { InlineEditableField } from "@/components/ui/InlineEditableField";
import { Button } from "@/components/ui/Button";
import { type StackLayer } from "@/components/import/LayerStack";
import { PreviewPane, type PreviewMode } from "@/components/preview/PreviewPane";
import { colorFor, LAYER_LABELS, sideOf } from "@/lib/layerColors";
import { api, type Hole } from "@/lib/api";
import { parseBoardMesh, type BoardMeshData } from "@/lib/boardMesh";
import { useShell } from "@/shellStore";

const DESCRIPTION_PLACEHOLDER = "Нажмите чтобы отредактировать описание.";

export function ProjectPage() {
  const manifest = useShell((s) => s.currentManifest);
  const currentPath = useShell((s) => s.currentPath);
  const updateProjectMetadata = useShell((s) => s.updateProjectMetadata);
  const startImport = useShell((s) => s.startImport);
  const error = useShell((s) => s.error);

  const [layers, setLayers] = useState<StackLayer[]>([]);
  const [holes, setHoles] = useState<Hole[]>([]);
  const [mesh, setMesh] = useState<BoardMeshData | null>(null);
  const [mode, setMode] = useState<PreviewMode>("2d");
  const [side, setSide] = useState<"top" | "bottom">("top");

  // Colour by gerber rel path, for "other" 3D surface layers.
  const layerColors = useMemo(() => {
    const m: Record<string, string> = {};
    if (manifest) {
      for (const imp of manifest.imports) {
        for (const g of imp.gerbers) m[g.path] = colorFor(g.layer_type, manifest.layer_colors);
      }
    }
    return m;
  }, [manifest]);

  // 3D shows both sides; 2D shows the top side only (no side toggle on this page).
  // 3D shows both sides; 2D shows the selected side (+ shared layers).
  const shownLayers = useMemo(
    () =>
      layers.map((l) => {
        const s = sideOf(l.type);
        return { ...l, visible: mode === "3d" || s === side || s === "both" };
      }),
    [layers, mode, side],
  );

  // Render every imported gerber to SVG for the composite 2D preview — in
  // PARALLEL, filling layers in as each resolves (slotted by index so the stack
  // order stays stable), so the viewer isn't blocked on the whole set.
  useEffect(() => {
    let cancelled = false;
    if (!manifest || !currentPath) {
      setLayers([]);
      return;
    }
    const gerbers = manifest.imports.flatMap((imp) => imp.gerbers);
    const slots: (StackLayer | null)[] = gerbers.map(() => null);
    setLayers([]);
    gerbers.forEach((g, idx) => {
      api
        .renderGerberSvg(currentPath, g.path)
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
        .catch(() => {
          // Non-renderable (e.g. drill) — skip in the 2D preview.
        });
    });
    return () => {
      cancelled = true;
    };
  }, [manifest, currentPath]);

  // Renderable gerbers (everything but drills) — for the 2D load-progress badge.
  const renderableTotal = useMemo(
    () =>
      manifest
        ? manifest.imports.reduce(
            (n, imp) => n + imp.gerbers.filter((g) => g.layer_type !== "drill").length,
            0,
          )
        : 0,
    [manifest],
  );
  const previewNotice =
    mode === "2d" && renderableTotal > 0 && layers.length < renderableTotal
      ? `Слои ${layers.length}/${renderableTotal}`
      : undefined;

  // Fetch drill holes for the 3D view.
  useEffect(() => {
    let cancelled = false;
    if (!manifest || !currentPath) {
      setHoles([]);
      return;
    }
    (async () => {
      const allHoles: Hole[] = [];
      for (const imp of manifest.imports) {
        for (const g of imp.gerbers) {
          if (g.layer_type === "drill") {
            try {
              const h = await api.readDrill(currentPath, g.path);
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
  }, [manifest, currentPath]);

  // Build the FULL 3D board mesh in the Rust core (off the UI thread): every
  // layer triangulated with drill holes subtracted (silk included), plus the
  // FR4 substrate and plated bores. Returned as one binary blob; the frontend
  // only uploads buffers. Recomputes only when the project changes — visibility
  // toggles are a pure client-side show/hide in Board3D, no recompute.
  useEffect(() => {
    let cancelled = false;
    if (!manifest || !currentPath) {
      setMesh(null);
      return;
    }
    const gerbers = manifest.imports.flatMap((imp) =>
      imp.gerbers.map((g) => ({ rel: g.path, layerType: g.layer_type })),
    );
    // Keep the previous mesh while recomputing so the 3D Canvas (camera, intro
    // state) survives — see ImportWizardPage for the rationale.
    (async () => {
      try {
        const buf = await api.projectBoardMesh(currentPath, gerbers);
        if (!cancelled) setMesh(parseBoardMesh(buf));
      } catch {
        if (!cancelled) setMesh(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [manifest, currentPath]);

  if (!manifest) {
    return <div className="flex-1 p-6 text-[13px] text-muted-foreground">Проект не открыт.</div>;
  }

  const saveName = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === manifest.name) return;
    updateProjectMetadata(trimmed, manifest.description);
  };
  const saveDescription = (description: string) => {
    const trimmed = description.trim();
    if (trimmed === manifest.description) return;
    updateProjectMetadata(manifest.name, trimmed);
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-start justify-between gap-4 border-b border-border p-6">
        <div className="min-w-0">
          <InlineEditableField
            value={manifest.name}
            onCommit={saveName}
            placeholder={manifest.name}
            ariaLabel="Project name"
            displayClassName="text-lg font-semibold text-foreground"
            inputClassName="text-lg font-semibold"
          />
          <InlineEditableField
            value={manifest.description}
            onCommit={saveDescription}
            placeholder={DESCRIPTION_PLACEHOLDER}
            multiline
            ariaLabel="Project description"
            displayClassName="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted-foreground"
            inputClassName="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted-foreground"
          />
          {error && <p className="mt-2 text-[12px] text-destructive">{error}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={startImport}>
            <Upload className="size-4" /> Импорт ZIP
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="w-80 shrink-0 overflow-auto border-r border-border p-4">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Импортированные пакеты
          </div>
          {manifest.imports.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">
              Пакетов пока нет. Нажмите «Импорт ZIP».
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {manifest.imports.map((imp) => (
                <li key={imp.id} className="rounded-lg border border-border bg-card p-3">
                  <div className="text-[13px] font-medium text-foreground">{imp.source_name}</div>
                  <ul className="mt-1 flex flex-col gap-1">
                    {imp.gerbers.map((g) => (
                      <li key={g.path} className="flex items-center gap-2 text-[11px]">
                        <span
                          className="size-2.5 shrink-0 rounded-sm"
                          style={{ backgroundColor: colorFor(g.layer_type, manifest.layer_colors) }}
                          aria-hidden
                        />
                        <span className="truncate text-foreground">{g.path.split("/").pop()}</span>
                        <span className="ml-auto shrink-0 text-muted-foreground">
                          {LAYER_LABELS[g.layer_type]}
                        </span>
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
    </div>
  );
}

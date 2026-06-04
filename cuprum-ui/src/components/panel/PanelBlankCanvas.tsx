import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer, Rect, Group, Text } from "react-konva";
import Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";
import { Maximize, Plus, Minus, LocateFixed } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { PanelToolPalette, type PanelTool } from "@/components/panel/PanelToolPalette";
import { AdaptiveGrid } from "@/components/editor/AdaptiveGrid";
import { RulersOverlay, type Viewport } from "@/components/editor/RulersOverlay";
import {
  MIN_SCALE,
  MAX_SCALE,
  COPPER_STROKE,
  COPPER_FILL,
  NO_COPPER_STROKE,
  RULER_TOP,
  RULER_LEFT,
} from "@/components/editor/canvasStyle";
import { useSettings } from "@/settingsStore";
import { useUnitFormat } from "@/i18n/useUnitFormat";
import { useShell } from "@/shellStore";
import { usePanelSelection } from "@/panelSelectionStore";
import { instanceBounds, clampDeltaToPanel, marqueeHits, snapAngle, boxesForInstances, alignInstances, distributeInstances, type AlignEdge } from "@/lib/panelPlacement";
import { PanelAlignBar } from "@/components/panel/PanelAlignBar";
import { SelectionOverlay } from "@/components/panel/SelectionOverlay";
import { RotationHandle } from "@/components/panel/RotationHandle";
import { usePlacedBoardSizes } from "@/hooks/usePlacedBoardSizes";
import type { BoardInstance, ProjectDesign } from "@/lib/api";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/ContextMenu";

const EDGE_KEEP = 64; // px of the blank that must stay on-canvas while panning

// Stable empty fallbacks so the store selectors keep a constant reference when
// the panel/designs are absent (avoids re-running the sizes effect every render).
const EMPTY_INSTANCES: BoardInstance[] = [];
const EMPTY_DESIGNS: ProjectDesign[] = [];

/** Schematic preview of an empty FR4 blank, in the dark CAD-canvas style of the
 *  exposure editor. Copper-clad side → solid amber outline + faint fill + "Cu";
 *  bare side → dashed grey outline + "no copper". Top always has copper; the
 *  bottom only when double-sided. Driven purely by props (no exposure store). */
export function PanelBlankCanvas({
  widthMm,
  heightMm,
  doubleSided,
  side,
  onSideChange,
}: {
  widthMm: number;
  heightMm: number;
  doubleSided: boolean;
  // Visible side is owned by PanelEditor so Ctrl+A can scope to it; the canvas
  // drives the toggle through onSideChange.
  side: "top" | "bottom";
  onSideChange: (side: "top" | "bottom") => void;
}) {
  const { t } = useTranslation(["project", "common"]);
  const pxPerMm = useShell((s) => s.pxPerMm);
  const { fmtLen } = useUnitFormat();
  // Machine bed limit (mm) → dashed work-area rectangle on the canvas.
  const maxPanelW = useSettings((s) => s.profile.maxPanelWidthMm);
  const maxPanelH = useSettings((s) => s.profile.maxPanelHeightMm);
  const instances = useShell((s) => s.currentManifest?.panel?.instances ?? EMPTY_INSTANCES);
  const designs = useShell((s) => s.currentManifest?.designs ?? EMPTY_DESIGNS);
  const moveInstances = useShell((s) => s.moveInstances);
  const rotateInstancesBy = useShell((s) => s.rotateInstancesBy);
  const selected = usePanelSelection((s) => s.selected);
  const setSelection = usePanelSelection((s) => s.set);
  const toggleSelection = usePanelSelection((s) => s.toggle);
  const clearSelection = usePanelSelection((s) => s.clear);
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  // The mm fit-group: getRelativePointerPosition() maps the pointer into panel mm,
  // accounting for the parent stage pan/zoom and this group's fit scale.
  const fitGroupRef = useRef<Konva.Group>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [zoomPct, setZoomPct] = useState(100);
  // Screen-space viewport descriptor mirrored into React state so the (SVG) rulers
  // overlay can follow the imperative Konva stage transform. Cursor position (CSS
  // px) drives the hover crosshair/readout; null when the pointer is off-canvas.
  const [viewport, setViewport] = useState<Viewport>({ pxPerMm: 0, originX: 0, originY: 0 });
  const [hoverPx, setHoverPx] = useState<{ x: number; y: number } | null>(null);
  // The hover crosshair + readout is opt-in (off by default — it's busy and most
  // placement is done by eye/snap).
  const [showCrosshair, setShowCrosshair] = useState(false);
  // Coalesce hover updates to one per animation frame: a bare mousemove handler
  // would re-render the whole instance tree on every pixel of movement. The latest
  // pointer lives in a ref; the frame flushes whatever is freshest.
  const hoverRaf = useRef<number | null>(null);
  const pendingHover = useRef<{ x: number; y: number } | null>(null);
  const queueHover = useCallback((p: { x: number; y: number } | null) => {
    pendingHover.current = p;
    if (p === null) {
      if (hoverRaf.current != null) {
        cancelAnimationFrame(hoverRaf.current);
        hoverRaf.current = null;
      }
      setHoverPx(null);
      return;
    }
    if (hoverRaf.current != null) return;
    hoverRaf.current = requestAnimationFrame(() => {
      hoverRaf.current = null;
      setHoverPx(pendingHover.current);
    });
  }, []);
  useEffect(() => () => { if (hoverRaf.current != null) cancelAnimationFrame(hoverRaf.current); }, []);
  const [spaceDown, setSpaceDown] = useState(false);
  const [tool, setTool] = useState<PanelTool>("select");
  const panMode = tool === "pan" || spaceDown;
  // Resolved board extents (mm) keyed by design id — shared hook, fetched once per design.
  const sizes = usePlacedBoardSizes();
  // Live drag preview (mm). While dragging selected instances we shift their render
  // by this delta and commit a single moveInstances on drag end; null when idle.
  const [dragDelta, setDragDelta] = useState<{ dx: number; dy: number } | null>(null);
  // Pointer-mm position where the current instance drag started.
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  // Live marquee rect (mm), drawn while drag-selecting over empty canvas; null when idle.
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const marqueeStart = useRef<{ x: number; y: number } | null>(null);
  // Live rotation preview: snapped delta (deg) applied to every selected instance's
  // render while the rotation knob is dragged; null when idle. Committed once on release.
  const [rotPreview, setRotPreview] = useState<number | null>(null);

  // O(1) design lookup for the instance render loop + labels.
  const designById = useMemo(() => new Map(designs.map((d) => [d.id, d])), [designs]);

  // Prune the ephemeral selection to ids still present (e.g. after a delete or an
  // undo that dropped instances). Cheap; runs whenever the instance set changes.
  useEffect(() => {
    usePanelSelection.getState().retain(new Set(instances.map((i) => i.id)));
  }, [instances]);

  // Visible instances on the current side (with resolved extents) — the candidate
  // set for marquee hit-testing and selection.
  const visibleInstances = useMemo(
    () =>
      instances.filter((i) => {
        const instSide = i.layer_ref === "Bottom" ? "bottom" : "top";
        return instSide === side && sizes[i.design_id];
      }),
    [instances, side, sizes],
  );

  const W = Math.max(widthMm, 1);
  const H = Math.max(heightMm, 1);
  const hasCopper = side === "top" || doubleSided;

  // Fit the blank into the plot area (right of / below the ruler bands) so it never
  // sits under the rulers.
  const fit = useMemo(
    () => Math.min((size.w - RULER_LEFT) / W, (size.h - RULER_TOP) / H) * 0.9,
    [size.w, size.h, W, H],
  );

  // Mirror the imperative Konva stage transform into React state for the rulers
  // overlay: screen px/mm = stage scale × fit; world origin (mm 0,0) = stage pos.
  const syncViewport = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    setViewport({ pxPerMm: stage.scaleX() * fit, originX: stage.x(), originY: stage.y() });
  }, [fit]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (down: boolean) => (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      e.preventDefault();
      setSpaceDown(down);
    };
    const kd = onKey(true);
    const ku = onKey(false);
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    return () => {
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
    };
  }, []);

  const clampPos = useCallback(
    (x: number, y: number, scale: number) => {
      const sw = W * fit * scale;
      const sh = H * fit * scale;
      return {
        x: Math.min(size.w - EDGE_KEEP, Math.max(EDGE_KEEP - sw, x)),
        y: Math.min(size.h - EDGE_KEEP, Math.max(EDGE_KEEP - sh, y)),
      };
    },
    [fit, size.w, size.h, W, H],
  );

  const centerAt = useCallback(
    (scale: number, animate: boolean) => {
      const stage = stageRef.current;
      if (!stage) return;
      const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
      // Centre within the plot area (offset by the ruler bands).
      const pos = clampPos(
        RULER_LEFT + (size.w - RULER_LEFT - W * fit * s) / 2,
        RULER_TOP + (size.h - RULER_TOP - H * fit * s) / 2,
        s,
      );
      if (animate) {
        stage.to({ x: pos.x, y: pos.y, scaleX: s, scaleY: s, duration: 0.16, easing: Konva.Easings.EaseOut, onUpdate: syncViewport, onFinish: syncViewport });
      } else {
        stage.scale({ x: s, y: s });
        stage.position(pos);
        stage.batchDraw();
        syncViewport();
      }
      setZoomPct(Math.round((fit * s / pxPerMm) * 100));
    },
    [clampPos, fit, size.w, size.h, W, H, pxPerMm, syncViewport],
  );

  const fitView = useCallback(() => centerAt(1, true), [centerAt]);
  const realSize = useCallback(() => centerAt(pxPerMm / fit, true), [centerAt, pxPerMm, fit]);

  // Fit the view on first layout and whenever the blank size (or viewport)
  // changes. In the setup wizard width/height are edited live, so re-framing
  // keeps the resized blank fully in view; manual zoom is intentionally reset.
  const framed = useRef("");
  useEffect(() => {
    const key = `${W}:${H}:${size.w}:${size.h}`;
    if (size.w === 0 || framed.current === key) return;
    framed.current = key;
    centerAt(1, false);
  }, [W, H, size.w, size.h, centerAt]);

  const zoomAt = useCallback(
    (pointer: { x: number; y: number }, factor: number, animate = false) => {
      const stage = stageRef.current;
      if (!stage) return;
      const oldScale = stage.scaleX();
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, oldScale * factor));
      if (newScale === oldScale) return;
      const wx = (pointer.x - stage.x()) / oldScale;
      const wy = (pointer.y - stage.y()) / oldScale;
      const pos = clampPos(pointer.x - wx * newScale, pointer.y - wy * newScale, newScale);
      if (animate) {
        stage.to({ x: pos.x, y: pos.y, scaleX: newScale, scaleY: newScale, duration: 0.16, easing: Konva.Easings.EaseOut, onUpdate: syncViewport, onFinish: syncViewport });
      } else {
        stage.scale({ x: newScale, y: newScale });
        stage.position(pos);
        stage.batchDraw();
        syncViewport();
      }
      setZoomPct(Math.round((fit * newScale / pxPerMm) * 100));
    },
    [clampPos, fit, pxPerMm, syncViewport],
  );

  const onWheel = (e: KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    zoomAt(pointer, Math.exp(-e.evt.deltaY * 0.0015));
  };

  const zoomButton = (factor: number) => zoomAt({ x: size.w / 2, y: size.h / 2 }, factor, true);

  const dragBound = (pos: { x: number; y: number }) => {
    const stage = stageRef.current;
    return clampPos(pos.x, pos.y, stage ? stage.scaleX() : 1);
  };
  const setCursor = (c: string) => {
    const el = containerRef.current;
    if (el) el.style.cursor = c;
  };

  const labelMm = Math.max(Math.min(W, H) * 0.08, 2);

  // Pointer position in panel mm via the fit-group's local coordinate system.
  const pointerMm = useCallback(() => fitGroupRef.current?.getRelativePointerPosition() ?? null, []);

  // AABBs (mm) of the currently selected instances — used to clamp drags/marquee.
  const selectedBoxes = useCallback(
    () =>
      instances
        .filter((i) => selected.has(i.id) && sizes[i.design_id])
        .map((i) => {
          const sz = sizes[i.design_id];
          return instanceBounds({ xMm: i.x_mm, yMm: i.y_mm, boardW: sz.w, boardH: sz.h, rotationDeg: i.rotation_deg });
        }),
    [instances, selected, sizes],
  );

  // Union AABB (mm) of the selection, INCLUDING the live rotation preview, so the
  // rotation knob tracks the selection while it spins. null when nothing selected.
  const selectionBBox = useMemo(() => {
    const boxes = instances
      .filter((i) => selected.has(i.id) && sizes[i.design_id])
      .map((i) => {
        const sz = sizes[i.design_id];
        const rot = i.rotation_deg + (rotPreview ?? 0);
        return instanceBounds({ xMm: i.x_mm, yMm: i.y_mm, boardW: sz.w, boardH: sz.h, rotationDeg: rot });
      });
    if (boxes.length === 0) return null;
    return {
      minX: Math.min(...boxes.map((b) => b.minX)),
      minY: Math.min(...boxes.map((b) => b.minY)),
      maxX: Math.max(...boxes.map((b) => b.maxX)),
      maxY: Math.max(...boxes.map((b) => b.maxY)),
    };
  }, [instances, selected, sizes, rotPreview]);

  // Pull a (possibly just-rotated) selection back inside the panel with one move.
  const clampSelectionIntoPanel = useCallback(
    async (ids: string[]) => {
      const panel = useShell.getState().currentManifest?.panel;
      if (!panel) return;
      const sel = new Set(ids);
      const boxes = panel.instances
        .filter((i) => sel.has(i.id) && sizes[i.design_id])
        .map((i) => {
          const sz = sizes[i.design_id];
          return instanceBounds({ xMm: i.x_mm, yMm: i.y_mm, boardW: sz.w, boardH: sz.h, rotationDeg: i.rotation_deg });
        });
      const { dx, dy } = clampDeltaToPanel(boxes, 0, 0, W, H);
      if (dx !== 0 || dy !== 0) await moveInstances(ids, dx, dy);
    },
    [sizes, W, H, moveInstances],
  );

  // --- Rotation knob (select tool only) ---
  const onRotatePreview = useCallback((deltaDeg: number, fine: boolean) => {
    // Snap the DELTA to the 15°/1° grid, then re-sign into (−180,180] so a small
    // backwards turn stays negative rather than wrapping near 360°.
    const snapped = snapAngle(deltaDeg, fine);
    setRotPreview(snapped > 180 ? snapped - 360 : snapped);
  }, []);

  const onRotateCommit = useCallback(() => {
    const delta = rotPreview;
    setRotPreview(null);
    if (delta == null || delta === 0) return;
    const ids = [...selected];
    void (async () => {
      await rotateInstancesBy(ids, delta);
      // Rotating about each board's centre can push the rotated AABB off-panel;
      // pull the whole selection back inside with a single follow-up move.
      await clampSelectionIntoPanel(ids);
    })();
  }, [rotPreview, selected, rotateInstancesBy, clampSelectionIntoPanel]);

  // --- Context-menu actions (act on current selection) ---
  const rotateSelectionBy = useCallback(
    (deltaDeg: number) => {
      const ids = [...usePanelSelection.getState().selected];
      if (!ids.length) return;
      void (async () => {
        await rotateInstancesBy(ids, deltaDeg);
        await clampSelectionIntoPanel(ids);
      })();
    },
    [rotateInstancesBy, clampSelectionIntoPanel],
  );

  const resetSelectionRotation = useCallback(() => {
    const ids = [...usePanelSelection.getState().selected];
    if (!ids.length) return;
    void (async () => {
      await useShell.getState().rotateInstances(ids, 0);
      await clampSelectionIntoPanel(ids);
    })();
  }, [clampSelectionIntoPanel]);

  const deleteSelected = useCallback(() => {
    const ids = [...usePanelSelection.getState().selected];
    if (!ids.length) return;
    void useShell.getState().removeInstances(ids);
    usePanelSelection.getState().clear();
  }, []);

  // Build AlignItem array for the current selection (instances with resolved sizes).
  const selectedAlignItems = useCallback(
    () => {
      const sel = usePanelSelection.getState().selected;
      return instances
        .filter((i) => sel.has(i.id) && sizes[i.design_id])
        .map((i) => {
          const sz = sizes[i.design_id];
          return {
            id: i.id, x_mm: i.x_mm, y_mm: i.y_mm,
            box: instanceBounds({ xMm: i.x_mm, yMm: i.y_mm, boardW: sz.w, boardH: sz.h, rotationDeg: i.rotation_deg }),
          };
        });
    },
    [instances, sizes],
  );

  const alignSelected = useCallback(
    (edge: AlignEdge) => {
      const items = selectedAlignItems();
      if (items.length < 2) return;
      void useShell.getState().setInstancePoses(alignInstances(items, edge));
    },
    [selectedAlignItems],
  );

  const distributeSelected = useCallback(
    (axis: "h" | "v") => {
      const items = selectedAlignItems();
      if (items.length < 3) return;
      void useShell.getState().setInstancePoses(distributeInstances(items, axis));
    },
    [selectedAlignItems],
  );

  // Duplicate the current selection with a clamped offset so copies stay within
  // the panel bounds. Re-selects the new copies on completion.
  const duplicateSelected = useCallback(() => {
    const sel = [...usePanelSelection.getState().selected];
    if (!sel.length) return;
    const instById = new Map(instances.map((i) => [i.id, i]));
    const picked = sel.map((id) => instById.get(id)).filter(Boolean) as typeof instances;
    const { dx, dy } = clampDeltaToPanel(boxesForInstances(picked, sizes), 2, 2, W, H);
    void useShell.getState().duplicateInstances(sel, dx, dy).then((ids) => usePanelSelection.getState().set(ids));
  }, [instances, sizes, W, H]);

  // --- Instance interaction (select tool only) ---
  const onInstanceClick = (id: string) => (e: KonvaEventObject<MouseEvent>) => {
    if (tool !== "select") return;
    e.cancelBubble = true; // don't trigger the empty-canvas click → clear
    const native = e.evt;
    if (native.shiftKey || native.ctrlKey || native.metaKey) toggleSelection(id);
    else setSelection([id]);
  };

  // Right-click on an instance selects it (unless already in the selection) so the
  // context menu acts on the clicked board. Do NOT preventDefault / cancelBubble —
  // the native contextmenu must reach the Radix trigger on the container.
  const onInstanceContextMenu = (id: string) => () => {
    if (tool !== "select") return;
    if (!usePanelSelection.getState().selected.has(id)) setSelection([id]);
  };

  const onInstanceDragStart = (id: string) => (e: KonvaEventObject<DragEvent>) => {
    if (tool !== "select") return;
    e.cancelBubble = true;
    if (!selected.has(id)) setSelection([id]);
    dragStart.current = pointerMm();
    setDragDelta({ dx: 0, dy: 0 });
  };

  const onInstanceDragMove = (e: KonvaEventObject<DragEvent>) => {
    if (tool !== "select" || !dragStart.current) return;
    e.cancelBubble = true;
    const p = pointerMm();
    if (!p) return;
    let dx = p.x - dragStart.current.x;
    let dy = p.y - dragStart.current.y;
    // Snap the delta to 1 mm unless Alt is held (free move).
    if (!e.evt.altKey) {
      dx = Math.round(dx);
      dy = Math.round(dy);
    }
    const clamped = clampDeltaToPanel(selectedBoxes(), dx, dy, W, H);
    setDragDelta(clamped);
    // The render shifts ALL selected instances (incl. this node) by dragDelta, so
    // pin the dragged Konva node back to its committed pose — we drive movement
    // purely through dragDelta to keep the whole selection in lock-step.
    const node = e.target as Konva.Group;
    const inst = instances.find((i) => i.id === node.id());
    const sz = inst ? sizes[inst.design_id] : undefined;
    if (inst && sz) {
      node.x(inst.x_mm + sz.w / 2 + clamped.dx);
      node.y(inst.y_mm + sz.h / 2 + clamped.dy);
    }
  };

  const onInstanceDragEnd = (e: KonvaEventObject<DragEvent>) => {
    if (tool !== "select") return;
    e.cancelBubble = true;
    const d = dragDelta;
    dragStart.current = null;
    setDragDelta(null);
    if (d && (d.dx !== 0 || d.dy !== 0)) void moveInstances([...selected], d.dx, d.dy);
  };

  // --- Empty-canvas click + marquee (select tool only) ---
  const isEmptyTarget = (e: KonvaEventObject<MouseEvent>) =>
    e.target === e.target.getStage() || e.target.name() === "panel-bg";

  const onBgMouseDown = (e: KonvaEventObject<MouseEvent>) => {
    if (panMode || tool !== "select" || !isEmptyTarget(e)) return;
    const p = pointerMm();
    if (!p) return;
    marqueeStart.current = p;
    setMarquee({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };

  const onStageMouseMove = () => {
    // Track the cursor (CSS px) for the rulers' crosshair/readout — only while the
    // crosshair is on, so an idle hover doesn't churn state when it's off.
    if (showCrosshair) {
      const pt = stageRef.current?.getPointerPosition() ?? null;
      queueHover(pt ? { x: pt.x, y: pt.y } : null);
    }
    // Live marquee (select tool) — unchanged.
    if (!marqueeStart.current) return;
    const p = pointerMm();
    if (!p) return;
    setMarquee({ x0: marqueeStart.current.x, y0: marqueeStart.current.y, x1: p.x, y1: p.y });
  };

  const onBgMouseUp = () => {
    const start = marqueeStart.current;
    const m = marquee;
    marqueeStart.current = null;
    setMarquee(null);
    if (!start || !m) return;
    const rect = {
      minX: Math.min(m.x0, m.x1),
      minY: Math.min(m.y0, m.y1),
      maxX: Math.max(m.x0, m.x1),
      maxY: Math.max(m.y0, m.y1),
    };
    // No meaningful drag (< 0.5 mm) → treat as an empty click → clear selection.
    if (rect.maxX - rect.minX < 0.5 && rect.maxY - rect.minY < 0.5) {
      clearSelection();
      return;
    }
    const items = visibleInstances.map((i) => {
      const sz = sizes[i.design_id];
      return {
        id: i.id,
        box: instanceBounds({ xMm: i.x_mm, yMm: i.y_mm, boardW: sz.w, boardH: sz.h, rotationDeg: i.rotation_deg }),
      };
    });
    setSelection(marqueeHits(items, rect));
  };

  const hasSelection = selected.size > 0;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
    <div
      ref={containerRef}
      className={`relative h-full w-full overflow-hidden bg-[#0a0c10] ${panMode ? "cursor-grab" : ""}`}
    >
      <Stage
        ref={stageRef}
        width={size.w}
        height={size.h}
        draggable={panMode}
        dragBoundFunc={dragBound}
        onWheel={onWheel}
        onMouseDown={onBgMouseDown}
        onMouseMove={onStageMouseMove}
        onMouseLeave={() => queueHover(null)}
        onMouseUp={onBgMouseUp}
        onDragStart={() => setCursor("grabbing")}
        onDragMove={syncViewport}
        onDragEnd={() => { setCursor(panMode ? "grab" : ""); syncViewport(); }}
      >
        <Layer>
          <Group ref={fitGroupRef} x={0} y={0} scaleX={fit} scaleY={fit}>
            <AdaptiveGrid widthMm={W} heightMm={H} />
            <Rect
              name="panel-bg"
              x={0}
              y={0}
              width={W}
              height={H}
              fill={hasCopper ? COPPER_FILL : undefined}
              stroke={hasCopper ? COPPER_STROKE : NO_COPPER_STROKE}
              strokeWidth={hasCopper ? 1.25 : 1}
              strokeScaleEnabled={false}
              dash={hasCopper ? undefined : [3, 2]}
            />
            {instances.length === 0 && (
              <Text
                x={0}
                y={H / 2 - labelMm / 2}
                width={W}
                align="center"
                text={hasCopper ? t("panel.canvas.copper") : t("panel.canvas.noCopper")}
                fontSize={labelMm}
                fill={hasCopper ? COPPER_STROKE : NO_COPPER_STROKE}
                listening={false}
              />
            )}
            {instances.map((inst) => {
              const sz = sizes[inst.design_id];
              const instSide = inst.layer_ref === "Bottom" ? "bottom" : "top";
              if (!sz || instSide !== side) return null;
              const name = designById.get(inst.design_id)?.source_name ?? "";
              const isSelected = selected.has(inst.id);
              // Centre-pivot: place the Group at the board centre, offset by half the
              // board so local (0,0) is the unrotated top-left, then rotate about that
              // centre. Matches instanceBounds / packLayout.
              // While a drag is live, shift every selected instance by dragDelta for
              // a lock-step preview; the single commit happens on drag end.
              const shift = isSelected && dragDelta ? dragDelta : { dx: 0, dy: 0 };
              const cx = inst.x_mm + sz.w / 2 + shift.dx;
              const cy = inst.y_mm + sz.h / 2 + shift.dy;
              // Live rotation preview: spin selected instances by the snapped delta
              // (each about its own centre) until the knob is released and committed.
              const rotation = inst.rotation_deg + (isSelected && rotPreview != null ? rotPreview : 0);
              return (
                <Group
                  key={inst.id}
                  id={inst.id}
                  x={cx}
                  y={cy}
                  offsetX={sz.w / 2}
                  offsetY={sz.h / 2}
                  rotation={rotation}
                  listening={tool === "select"}
                  draggable={tool === "select"}
                  onClick={onInstanceClick(inst.id)}
                  onTap={onInstanceClick(inst.id)}
                  onContextMenu={onInstanceContextMenu(inst.id)}
                  onDragStart={onInstanceDragStart(inst.id)}
                  onDragMove={onInstanceDragMove}
                  onDragEnd={onInstanceDragEnd}
                >
                  <Rect
                    width={sz.w}
                    height={sz.h}
                    fill={COPPER_FILL}
                    stroke={COPPER_STROKE}
                    strokeWidth={1}
                    strokeScaleEnabled={false}
                    cornerRadius={0.3}
                  />
                  <Text
                    x={0}
                    y={0}
                    width={sz.w}
                    height={sz.h}
                    align="center"
                    verticalAlign="middle"
                    text={name}
                    fontSize={Math.max(Math.min(sz.w, sz.h) * 0.12, 1.5)}
                    fill={COPPER_STROKE}
                    listening={false}
                  />
                </Group>
              );
            })}
            <SelectionOverlay
              instances={visibleInstances}
              sizes={sizes}
              selected={selected}
              dragDelta={dragDelta}
              rotPreview={rotPreview}
            />
            {tool === "select" && !dragDelta && selectionBBox && (
              <RotationHandle
                cx={(selectionBBox.minX + selectionBBox.maxX) / 2}
                cy={(selectionBBox.minY + selectionBBox.maxY) / 2}
                radiusMm={(selectionBBox.maxY - selectionBBox.minY) / 2 + Math.max(W, H) * 0.06}
                pointerMm={pointerMm}
                onRotate={onRotatePreview}
                onCommit={onRotateCommit}
              />
            )}
            {marquee && (
              <Rect
                x={Math.min(marquee.x0, marquee.x1)}
                y={Math.min(marquee.y0, marquee.y1)}
                width={Math.abs(marquee.x1 - marquee.x0)}
                height={Math.abs(marquee.y1 - marquee.y0)}
                stroke="#5b9dff"
                strokeWidth={1}
                strokeScaleEnabled={false}
                dash={[4, 3]}
                fill="rgba(91,157,255,0.08)"
                listening={false}
              />
            )}
          </Group>
        </Layer>
      </Stage>

      <RulersOverlay
        viewport={viewport}
        size={size}
        fmt={fmtLen}
        extentMm={{ x: 0, y: 0, w: W, h: H }}
        workAreaMm={{ w: maxPanelW, h: maxPanelH }}
        workAreaLabel={t("panel.canvas.workArea")}
        hover={showCrosshair ? hoverPx : null}
      />

      <PanelToolPalette tool={tool} onToolChange={setTool} onDuplicate={duplicateSelected} />
      <PanelAlignBar onAlign={alignSelected} onDistribute={distributeSelected} />

      <div className="absolute left-20 top-3 z-10">
        <SegmentedControl<"top" | "bottom">
          value={side}
          onChange={onSideChange}
          options={[
            { value: "top", label: t("setup.sideTop") },
            { value: "bottom", label: t("setup.sideBottom") },
          ]}
        />
      </div>

      <div className="absolute right-3 top-3 z-10 rounded-md border border-border bg-card/90 px-2 py-1 text-[11px] tabular-nums text-muted-foreground">
        {W} × {H} mm
      </div>

      <div className="absolute bottom-2 right-2 flex items-center gap-0.5 rounded-md border border-border bg-card/90 p-0.5 text-muted-foreground [&_button]:cursor-pointer">
        <button
          className={`rounded p-1 hover:bg-muted/60 ${showCrosshair ? "bg-primary/20 text-primary" : ""}`}
          aria-label={t("common:viewer.crosshair")}
          title={t("common:viewer.crosshair")}
          onClick={() => setShowCrosshair((v) => !v)}
        >
          <LocateFixed className="size-4" />
        </button>
        <button className="rounded p-1 hover:bg-muted/60" aria-label={t("common:viewer.zoomOut")} title={t("common:viewer.zoomOut")} onClick={() => zoomButton(1 / 1.2)}>
          <Minus className="size-4" />
        </button>
        <button
          className="min-w-12 rounded px-1.5 py-1 text-center text-[11px] tabular-nums hover:bg-muted/60"
          aria-label={t("common:viewer.realSize")}
          title={t("common:viewer.realSize")}
          onClick={realSize}
        >
          {zoomPct}%
        </button>
        <button className="rounded p-1 hover:bg-muted/60" aria-label={t("common:viewer.zoomIn")} title={t("common:viewer.zoomIn")} onClick={() => zoomButton(1.2)}>
          <Plus className="size-4" />
        </button>
        <button className="rounded p-1 hover:bg-muted/60" aria-label={t("common:viewer.fitAll")} title={t("common:viewer.fitAll")} onClick={fitView}>
          <Maximize className="size-4" />
        </button>
      </div>
    </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={!hasSelection} onSelect={() => duplicateSelected()}>
          {t("panel.menu.duplicate")}
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasSelection} onSelect={() => rotateSelectionBy(90)}>
          {t("panel.menu.rotateCw")}
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasSelection} onSelect={() => rotateSelectionBy(-90)}>
          {t("panel.menu.rotateCcw")}
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasSelection} onSelect={() => resetSelectionRotation()}>
          {t("panel.menu.resetRotation")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!hasSelection} onSelect={() => deleteSelected()}>
          {t("panel.menu.delete")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

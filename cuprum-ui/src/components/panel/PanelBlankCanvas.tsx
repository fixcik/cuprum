import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer, Rect, Group, Text, Circle, Line } from "react-konva";
import Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";
import { Maximize, Plus, Minus, LocateFixed } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { PanelToolPalette, type PanelTool } from "@/components/panel/PanelToolPalette";
import { AdaptiveGrid } from "@/components/editor/AdaptiveGrid";
import { RulersOverlay, type Viewport } from "@/components/editor/RulersOverlay";
import { gridSteps } from "@/lib/canvasTicks";
import {
  MIN_SCALE,
  MAX_SCALE,
  BLANK_STROKE,
  BLANK_STROKE_BARE,
  BLANK_FILL,
  BLANK_LABEL,
  INSTANCE_FILL,
  INSTANCE_STROKE,
  INSTANCE_LABEL,
  INSTANCE_OFF_STROKE,
  INSTANCE_OFF_FILL,
  INSTANCE_WARN_STROKE,
  COPPER_STROKE,
  RULER_TOP,
  RULER_LEFT,
} from "@/components/editor/canvasStyle";
import { DEFAULT_TOOLING_DIAMETER_MM } from "@/lib/panel";
import { useSettings } from "@/settingsStore";
import { useUnitFormat } from "@/i18n/useUnitFormat";
import { useShell } from "@/shellStore";
import { usePanelSelection } from "@/panelSelectionStore";
import { instanceBounds, isOffPanel, clampDeltaToPanel, marqueeHits, snapAngle, boxesForInstances, alignInstances, distributeInstances, computeSmartGuides, type AlignEdge, type GuideLine } from "@/lib/panelPlacement";
import { usePanelFindings } from "@/hooks/usePanelFindings";
import { SnapGuides } from "@/components/panel/SnapGuides";
import { PanelAlignBar } from "@/components/panel/PanelAlignBar";
import { SelectionHud } from "@/components/panel/SelectionHud";
import { SelectionOverlay } from "@/components/panel/SelectionOverlay";
import { RotationHandle } from "@/components/panel/RotationHandle";
import { RenestDialog } from "@/components/panel/RenestDialog";
import { RegistrationSetDialog } from "@/components/panel/RegistrationSetDialog";
import { ToolingHoleLayer } from "@/components/panel/ToolingHoleLayer";
import { ToolingHoleInspector } from "@/components/panel/ToolingHoleInspector";
import { usePlacedBoardSizes } from "@/hooks/usePlacedBoardSizes";
import { api, type BoardInstance, type ProjectDesign, type ToolingHole } from "@/lib/api";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/ContextMenu";

const EDGE_KEEP = 64; // px of the blank that must stay on-canvas while panning
const SNAP_PX = 6;   // magnetic snap threshold in screen pixels

// Stable empty fallbacks so the store selectors keep a constant reference when
// the panel/designs are absent (avoids re-running the sizes effect every render).
const EMPTY_INSTANCES: BoardInstance[] = [];
const EMPTY_DESIGNS: ProjectDesign[] = [];
const EMPTY_HOLES: ToolingHole[] = [];

/** Schematic preview of an empty FR4 blank, in the dark CAD-canvas style of the
 *  exposure editor. Structure stays NEUTRAL (copper is reserved for selection):
 *  copper-clad side → solid neutral outline + faint fill + "Cu"; bare side →
 *  dashed neutral outline + "no copper". The solid-vs-dashed distinction carries
 *  the side, only the amber is dropped. Top always has copper; the bottom only
 *  when double-sided. Driven purely by props (no exposure store). */
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
  const holes = useShell((s) => s.currentManifest?.panel?.tooling_holes ?? EMPTY_HOLES);
  const moveInstances = useShell((s) => s.moveInstances);
  const rotateInstancesBy = useShell((s) => s.rotateInstancesBy);
  const addToolingHole = useShell((s) => s.addToolingHole);
  const moveToolingHole = useShell((s) => s.moveToolingHole);
  const removeToolingHole = useShell((s) => s.removeToolingHole);
  const setToolingHoleDiameter = useShell((s) => s.setToolingHoleDiameter);
  const setToolingHoleRole = useShell((s) => s.setToolingHoleRole);
  const addRegistrationSet = useShell((s) => s.addRegistrationSet);
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
  // `snapped` marks the crosshair locked onto a blank/instance corner/edge/centre
  // (→ a lock ring); false for a free point (Alt held) or a plain grid node.
  const [hoverPx, setHoverPx] = useState<{ x: number; y: number; snapped: boolean } | null>(null);
  // The hover crosshair + readout is opt-in (off by default — it's busy and most
  // placement is done by eye/snap).
  const [showCrosshair, setShowCrosshair] = useState(false);
  // Coalesce hover updates to one per animation frame: a bare mousemove handler
  // would re-render the whole instance tree on every pixel of movement. The latest
  // pointer lives in a ref; the frame flushes whatever is freshest.
  const hoverRaf = useRef<number | null>(null);
  const pendingHover = useRef<{ x: number; y: number; snapped: boolean } | null>(null);
  const queueHover = useCallback((p: { x: number; y: number; snapped: boolean } | null) => {
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
  // Panel-level findings from the single source of truth (evaluatePanel).
  // byInstance maps each instance id to its worst severity — drives canvas highlight.
  const { byInstance } = usePanelFindings();
  // Live drag preview (mm). While dragging selected instances we shift their render
  // by this delta and commit a single moveInstances on drag end; null when idle.
  const [dragDelta, setDragDelta] = useState<{ dx: number; dy: number } | null>(null);
  // Active smart-guide lines (mm) while a drag is in progress; cleared on drag end.
  const [guides, setGuides] = useState<GuideLine[]>([]);
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

  // Esc turns the hover crosshair off (mirrors the design preview's Esc behaviour).
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setShowCrosshair(false); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
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

  // Snap candidates (panel mm) for the hover crosshair: the blank's corners / edge
  // midpoints / centre, plus the same nine points of every visible instance's
  // (rotated) AABB. Mirrors the design preview's feature/board snapping.
  const snapPts = useMemo(() => {
    const pts: { x: number; y: number }[] = [];
    const pushBox = (b: { minX: number; minY: number; maxX: number; maxY: number }) => {
      const cx = (b.minX + b.maxX) / 2;
      const cy = (b.minY + b.maxY) / 2;
      pts.push(
        { x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.minX, y: b.maxY }, { x: b.maxX, y: b.maxY },
        { x: cx, y: b.minY }, { x: cx, y: b.maxY }, { x: b.minX, y: cy }, { x: b.maxX, y: cy }, { x: cx, y: cy },
      );
    };
    pushBox({ minX: 0, minY: 0, maxX: W, maxY: H });
    for (const i of visibleInstances) {
      const sz = sizes[i.design_id];
      if (!sz) continue;
      pushBox(instanceBounds({ xMm: i.x_mm, yMm: i.y_mm, boardW: sz.w, boardH: sz.h, rotationDeg: i.rotation_deg }));
    }
    return pts;
  }, [W, H, visibleInstances, sizes]);

  // Resolve a pointer-mm position to a snapped board point (+ whether it locked
  // onto a real candidate). Priority: candidate within threshold → grid node →
  // raw. The threshold is SNAP_PX in screen px, converted to mm via the live zoom.
  const snapPointMm = useCallback(
    (pm: { x: number; y: number }): { mm: { x: number; y: number }; feature: boolean } => {
      const ppm = viewport.pxPerMm;
      if (ppm <= 0) return { mm: pm, feature: false };
      const thr = SNAP_PX / ppm;
      let best: { x: number; y: number } | null = null;
      let bestD = thr;
      for (const c of snapPts) {
        const d = Math.hypot(c.x - pm.x, c.y - pm.y);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (best) return { mm: best, feature: true };
      const step = gridSteps(ppm).minor;
      if (step > 0) {
        const gx = Math.round(pm.x / step) * step;
        const gy = Math.round(pm.y / step) * step;
        if (Math.hypot(gx - pm.x, gy - pm.y) < thr) return { mm: { x: gx, y: gy }, feature: false };
      }
      return { mm: pm, feature: false };
    },
    [snapPts, viewport.pxPerMm],
  );

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

  // Open the inspector window for the single selected instance's design (matches
  // the "Open" action on a design card). Only meaningful for one instance.
  const openSelectedDesign = useCallback(() => {
    const ids = [...usePanelSelection.getState().selected];
    if (ids.length !== 1) return;
    const inst = instances.find((i) => i.id === ids[0]);
    if (inst) void api.openInspectorWindow(inst.design_id);
  }, [instances]);

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
    setGuides([]);
  };

  const onInstanceDragMove = (e: KonvaEventObject<DragEvent>) => {
    if (tool !== "select" || !dragStart.current) return;
    e.cancelBubble = true;
    const p = pointerMm();
    if (!p) return;
    let dx = p.x - dragStart.current.x;
    let dy = p.y - dragStart.current.y;
    let nextGuides: GuideLine[] = [];
    if (!e.evt.altKey) {
      // Selection AABB after the raw delta.
      const sb = selectedBoxes();
      if (sb.length) {
        const moving = {
          minX: Math.min(...sb.map((b) => b.minX)) + dx,
          minY: Math.min(...sb.map((b) => b.minY)) + dy,
          maxX: Math.max(...sb.map((b) => b.maxX)) + dx,
          maxY: Math.max(...sb.map((b) => b.maxY)) + dy,
        };
        const targets = visibleInstances
          .filter((i) => !selected.has(i.id))
          .map((i) => {
            const sz = sizes[i.design_id];
            return instanceBounds({ xMm: i.x_mm, yMm: i.y_mm, boardW: sz.w, boardH: sz.h, rotationDeg: i.rotation_deg });
          });
        targets.push({ minX: 0, minY: 0, maxX: W, maxY: H }); // panel frame → edges + centre
        const scale = fit * (stageRef.current?.scaleX() ?? 1);
        const thresholdMm = SNAP_PX / scale;
        const snap = computeSmartGuides({ movingBox: moving, targets, thresholdMm });
        // Snapped axes win; un-snapped axes fall back to the 1 mm grid.
        dx = snap.guides.some((g) => g.axis === "x") ? dx + snap.dx : Math.round(dx);
        dy = snap.guides.some((g) => g.axis === "y") ? dy + snap.dy : Math.round(dy);
        nextGuides = snap.guides;
      } else {
        dx = Math.round(dx);
        dy = Math.round(dy);
      }
    }
    const clamped = clampDeltaToPanel(selectedBoxes(), dx, dy, W, H);
    setDragDelta(clamped);
    setGuides(nextGuides);
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
    setGuides([]);
    if (d && (d.dx !== 0 || d.dy !== 0)) void moveInstances([...selected], d.dx, d.dy);
  };

  // --- Tooling hole interaction handlers ---
  const onHoleMouseDown = (id: string, e: KonvaEventObject<MouseEvent>) => {
    e.cancelBubble = true;
    setSelectedHoleId(id);
  };

  const onHoleDragEnd = (id: string, e: KonvaEventObject<DragEvent>) => {
    e.cancelBubble = true;
    const node = e.target;
    // The node was dragged in panel mm coordinates (same as fit-group local space).
    // Read the new position and compute delta vs committed hole position.
    const hole = holes.find((h) => h.id === id);
    if (!hole) return;
    const newX = node.x();
    const newY = node.y();
    const dx = Math.round(newX - hole.x_mm);
    const dy = Math.round(newY - hole.y_mm);
    // Reset the node position back to the committed pose; the store mutation will
    // re-render it correctly.
    node.x(hole.x_mm);
    node.y(hole.y_mm);
    if (dx !== 0 || dy !== 0) void moveToolingHole(id, dx, dy);
  };

  // --- Empty-canvas click + marquee (select tool only) ---
  const isEmptyTarget = (e: KonvaEventObject<MouseEvent>) =>
    e.target === e.target.getStage() || e.target.name() === "panel-bg";

  const onBgMouseDown = (e: KonvaEventObject<MouseEvent>) => {
    if (panMode || !isEmptyTarget(e)) return;
    if (tool === "tooling") {
      // Edit-first: a bare click just deselects. A hole is placed only when the
      // "+" action has armed a one-shot placement; then disarm and select it.
      if (!addArmed) {
        setSelectedHoleId(null);
        return;
      }
      const p = pointerMm();
      if (!p) return;
      setAddArmed(false);
      setGhostMm(null);
      void (async () => {
        const id = await addToolingHole(p.x, p.y);
        if (id) setSelectedHoleId(id);
      })();
      return;
    }
    if (tool !== "select") return;
    const p = pointerMm();
    if (!p) return;
    marqueeStart.current = p;
    setMarquee({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };

  const onStageMouseMove = (e: KonvaEventObject<MouseEvent>) => {
    // Track the cursor (CSS px) for the rulers' crosshair/readout — only while the
    // crosshair is on, so an idle hover doesn't churn state when it's off. The
    // crosshair snaps to the blank/instance corners/edges/centre; Alt = free.
    if (showCrosshair) {
      const pt = stageRef.current?.getPointerPosition() ?? null;
      if (!pt) {
        queueHover(null);
      } else if (e.evt.altKey) {
        queueHover({ x: pt.x, y: pt.y, snapped: false });
      } else {
        const pm = pointerMm();
        if (!pm) {
          queueHover({ x: pt.x, y: pt.y, snapped: false });
        } else {
          const sn = snapPointMm(pm);
          queueHover({
            x: viewport.originX + sn.mm.x * viewport.pxPerMm,
            y: viewport.originY + sn.mm.y * viewport.pxPerMm,
            snapped: sn.feature,
          });
        }
      }
    }
    // Ghost crosshair follows the cursor while a tooling-hole placement is armed.
    if (tool === "tooling" && addArmed) {
      const p = pointerMm();
      setGhostMm(p ? { x: p.x, y: p.y } : null);
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
  const [renestOpen, setRenestOpen] = useState(false);
  const [regSetOpen, setRegSetOpen] = useState(false);
  const [selectedHoleId, setSelectedHoleId] = useState<string | null>(null);
  // Tooling mode is edit-first: the "+" action ARMS a one-shot placement. While
  // armed a ghost crosshair (ghostMm) follows the cursor; the next canvas click
  // drops one hole and disarms. Adding is never the default click behaviour.
  const [addArmed, setAddArmed] = useState(false);
  const [ghostMm, setGhostMm] = useState<{ x: number; y: number } | null>(null);
  const armAddHole = useCallback(() => {
    setSelectedHoleId(null);
    setAddArmed(true);
  }, []);

  // Clear hole selection + disarm placement when leaving tooling mode.
  useEffect(() => {
    if (tool !== "tooling") {
      setSelectedHoleId(null);
      setAddArmed(false);
      setGhostMm(null);
    }
  }, [tool]);

  // Delete/Backspace removes the selected tooling hole; Esc deselects it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (tool !== "tooling") return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selectedHoleId) {
        e.preventDefault();
        const id = selectedHoleId;
        setSelectedHoleId(null);
        void removeToolingHole(id);
      } else if (e.key === "Escape") {
        // Esc cancels an armed placement first, otherwise clears the selection.
        if (addArmed) {
          setAddArmed(false);
          setGhostMm(null);
        } else if (selectedHoleId) {
          setSelectedHoleId(null);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool, selectedHoleId, addArmed, removeToolingHole]);

  return (
    <>
    <ContextMenu>
      <ContextMenuTrigger asChild>
    <div
      ref={containerRef}
      className={`relative h-full w-full overflow-hidden bg-[#0a0c10] ${panMode ? "cursor-grab" : addArmed ? "cursor-crosshair" : ""}`}
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
        onMouseLeave={() => { queueHover(null); setGhostMm(null); }}
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
              fill={hasCopper ? BLANK_FILL : undefined}
              stroke={hasCopper ? BLANK_STROKE : BLANK_STROKE_BARE}
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
                fill={BLANK_LABEL}
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
              // Live off-panel check on the rendered pose (incl. drag/rotate preview)
              // so the red highlight tracks the board while it moves. This is the
              // "live" path; the committed severity from usePanelFindings is used
              // when the board is idle.
              const liveOff = isOffPanel({
                xMm: inst.x_mm + shift.dx,
                yMm: inst.y_mm + shift.dy,
                boardW: sz.w,
                boardH: sz.h,
                rotationDeg: rotation,
                panelW: W,
                panelH: H,
              });
              // Committed severity from the single findings source (covers off-panel,
              // overlap, spacing, work-area). During a live drag/rotate the committed
              // value may lag the render; fall back to liveOff for block.
              const committedSev = byInstance.get(inst.id);
              const isBlock = liveOff || committedSev === "block";
              const isWarn = !isBlock && committedSev === "warn";
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
                    fill={isBlock ? INSTANCE_OFF_FILL : INSTANCE_FILL}
                    stroke={isBlock ? INSTANCE_OFF_STROKE : isWarn ? INSTANCE_WARN_STROKE : INSTANCE_STROKE}
                    strokeWidth={isBlock || isWarn ? 1.5 : 1}
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
                    fill={INSTANCE_LABEL}
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
              pxPerMm={viewport.pxPerMm}
            />
            {tool === "select" && !dragDelta && selectionBBox && (() => {
              // Knob hangs off the bottom-right bbox corner (diagonal stub), leaving the
              // top-centre clear for the selection HUD; rotation pivot stays the centre.
              const k = (Math.max(W, H) * 0.06) / Math.SQRT2;
              return (
                <RotationHandle
                  cx={(selectionBBox.minX + selectionBBox.maxX) / 2}
                  cy={(selectionBBox.minY + selectionBBox.maxY) / 2}
                  anchorX={selectionBBox.maxX}
                  anchorY={selectionBBox.maxY}
                  knobX={selectionBBox.maxX + k}
                  knobY={selectionBBox.maxY + k}
                  pointerMm={pointerMm}
                  onRotate={onRotatePreview}
                  onCommit={onRotateCommit}
                />
              );
            })()}
            <SnapGuides guides={guides} />
            <ToolingHoleLayer
              holes={holes}
              selectedId={tool === "tooling" ? selectedHoleId : null}
              pxPerMm={viewport.pxPerMm}
              interactive={tool === "tooling" && !addArmed}
              onHoleMouseDown={onHoleMouseDown}
              onHoleDragEnd={onHoleDragEnd}
            />
            {/* Ghost crosshair preview of the hole-to-be while placement is armed. */}
            {tool === "tooling" && addArmed && ghostMm && (() => {
              const k = viewport.pxPerMm > 0 ? 1 / viewport.pxPerMm : 0;
              const arm = 6 * k;
              return (
                <Group x={ghostMm.x} y={ghostMm.y} listening={false} opacity={0.7}>
                  <Circle
                    radius={DEFAULT_TOOLING_DIAMETER_MM / 2}
                    stroke={COPPER_STROKE}
                    strokeWidth={1.5}
                    strokeScaleEnabled={false}
                    dash={[2, 2]}
                  />
                  {arm > 0 && (
                    <>
                      <Line points={[-arm, 0, arm, 0]} stroke={COPPER_STROKE} strokeWidth={1} strokeScaleEnabled={false} />
                      <Line points={[0, -arm, 0, arm]} stroke={COPPER_STROKE} strokeWidth={1} strokeScaleEnabled={false} />
                    </>
                  )}
                </Group>
              );
            })()}
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
        extentVariant="muted"
      />

      {tool === "select" && (
        <SelectionHud
          viewport={viewport}
          size={size}
          panelW={W}
          panelH={H}
          livePose={{ dragDelta, rotPreview }}
          onDuplicate={duplicateSelected}
          onDelete={deleteSelected}
          onRotate90={() => rotateSelectionBy(90)}
          onOpenDesign={openSelectedDesign}
        />
      )}

      <PanelToolPalette
        tool={tool}
        onToolChange={setTool}
        onDuplicate={duplicateSelected}
        onAddHole={armAddHole}
        addArmed={addArmed}
        onAddRegistrationSet={() => setRegSetOpen(true)}
      />
      <PanelAlignBar onAlign={alignSelected} onDistribute={distributeSelected} />

      {tool === "tooling" && selectedHoleId && (() => {
        const h = holes.find((x) => x.id === selectedHoleId);
        return h ? (
          <ToolingHoleInspector
            hole={h}
            onDiameter={(d) => void setToolingHoleDiameter(h.id, d)}
            onRole={(r) => void setToolingHoleRole(h.id, r)}
            onDelete={() => { removeToolingHole(h.id).catch(() => {}); setSelectedHoleId(null); }}
          />
        ) : null;
      })()}

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
        <ContextMenuItem disabled={selected.size !== 1} onSelect={() => openSelectedDesign()}>
          {t("panel.menu.openDesign")}
        </ContextMenuItem>
        <ContextMenuSeparator />
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
        <ContextMenuItem disabled={!hasSelection} onSelect={() => setRenestOpen(true)}>
          {t("panel.menu.renest")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!hasSelection} onSelect={() => deleteSelected()}>
          {t("panel.menu.delete")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
    <RenestDialog
      open={renestOpen}
      onClose={() => setRenestOpen(false)}
      selectedIds={[...selected]}
      instances={instances}
      toolingHoles={holes}
      sizes={sizes}
      panelW={W}
      panelH={H}
      onApply={(items) => void useShell.getState().setInstanceTransforms(items)}
    />
    <RegistrationSetDialog
      open={regSetOpen}
      onClose={() => setRegSetOpen(false)}
      hasExisting={holes.length > 0}
      onApply={(opts) => void addRegistrationSet(opts)}
    />
    </>
  );
}

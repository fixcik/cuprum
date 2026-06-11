import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer, Rect, Group, Text } from "react-konva";
import Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";
import { LocateFixed } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PanelToolPalette, type PanelTool } from "@/components/panel/PanelToolPalette";
import { ZoomToolbar, ZOOM_STEP } from "@/components/ui/ZoomToolbar";
import { AdaptiveGrid } from "@/components/editor/AdaptiveGrid";
import { RulersOverlay } from "@/components/editor/RulersOverlay";
import { gridSteps } from "@/lib/canvasTicks";
import { useKonvaViewport } from "@/hooks/useKonvaViewport";
import {
  BLANK_STROKE,
  BLANK_FILL,
  BLANK_LABEL,
  RULER_TOP,
  RULER_LEFT,
} from "@/components/editor/canvasStyle";
import { useSettings } from "@/settingsStore";
import { useUnitFormat } from "@/i18n/useUnitFormat";
import { useShell } from "@/shellStore";
import { useNavigation } from "@/navigationStore";
import { usePanelSelection } from "@/panelSelectionStore";
import { instanceBounds, clampDeltaToPanel, marqueeHits, snapAngle, computeSmartGuides, clampZoneRect, KEEPOUT_MIN_MM, boxesOverlap, keepOutBox, toolingHoleBounds, buildSnapCandidates, computeSelectionBBox, type GuideLine } from "@/lib/panelPlacement";
import type { Severity } from "@/lib/feasibility";
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
import { KeepOutLayer, type ZoneCorner } from "@/components/panel/KeepOutLayer";
import { ClampZoneLayer } from "@/components/panel/ClampZoneLayer";
import { usePlacedBoardSizes } from "@/hooks/usePlacedBoardSizes";
import { useDesignPreviewImages } from "@/hooks/useDesignPreviewImages";
import { type BoardInstance, type KeepOutZone, type ToolingHole } from "@/lib/api";
import { useKeepOutSelection } from "@/keepOutSelectionStore";
import { usePanelContextActions } from "@/hooks/usePanelContextActions";
import { usePanelKeyHandlers } from "@/hooks/usePanelKeyHandlers";
import { ToolingGhostCrosshair, MarqueeRect, KeepOutDrawRect } from "@/components/panel/DraftShapes";
import { InstanceLayer } from "@/components/panel/InstanceLayer";
import { PanelContextMenuContent } from "@/components/panel/PanelContextMenuContent";
import { useCrosshairState } from "@/hooks/useCrosshairState";
import {
  ContextMenu,
  ContextMenuTrigger,
} from "@/components/ui/ContextMenu";

const SNAP_PX = 6;   // magnetic snap threshold in screen pixels
// Rotation knob (RotationHandle): constant screen px, like the corner handles.
const ROT_KNOB_OUT_PX = 16; // diagonal corner→knob-centre distance
const ROT_KNOB_R_PX = 5.5;  // knob (copper ring) radius

// Stable empty fallbacks so the store selectors keep a constant reference when
// the panel/designs are absent (avoids re-running the sizes effect every render).
const EMPTY_INSTANCES: BoardInstance[] = [];
const EMPTY_HOLES: ToolingHole[] = [];
const EMPTY_ZONES: KeepOutZone[] = [];

/** Schematic preview of an empty FR4 blank, in the dark CAD-canvas style of the
 *  exposure editor. Structure stays NEUTRAL (copper is reserved for selection):
 *  solid neutral outline + faint fill + "Cu". A placement is side-agnostic — the
 *  board occupies its panel slot on both sides — so the blank has no side toggle;
 *  top/bottom is a concern of the exposure/drill operation, not the layout editor.
 *  Driven purely by props (no exposure store). */
export function PanelBlankCanvas({
  widthMm,
  heightMm,
}: {
  widthMm: number;
  heightMm: number;
}) {
  const { t } = useTranslation(["project", "common"]);
  const pxPerMm = useNavigation((s) => s.pxPerMm);
  const { fmtLen } = useUnitFormat();
  const clampRadiusMm = useSettings((s) => s.profile.toolingClampRadiusMm);
  const instances = useShell((s) => s.currentManifest?.panel?.instances ?? EMPTY_INSTANCES);
  const holes = useShell((s) => s.currentManifest?.panel?.tooling_holes ?? EMPTY_HOLES);
  const zones = useShell((s) => s.currentManifest?.panel?.keep_out_zones ?? EMPTY_ZONES);
  const moveInstances = useShell((s) => s.moveInstances);
  const rotateInstancesBy = useShell((s) => s.rotateInstancesBy);
  const addToolingHole = useShell((s) => s.addToolingHole);
  const moveToolingHole = useShell((s) => s.moveToolingHole);
  const removeToolingHole = useShell((s) => s.removeToolingHole);
  const setToolingHoleDiameter = useShell((s) => s.setToolingHoleDiameter);
  const setToolingHoleRole = useShell((s) => s.setToolingHoleRole);
  const addRegistrationSet = useShell((s) => s.addRegistrationSet);
  const addKeepOutZone = useShell((s) => s.addKeepOutZone);
  const moveKeepOutZones = useShell((s) => s.moveKeepOutZones);
  const removeKeepOutZones = useShell((s) => s.removeKeepOutZones);
  const resizeKeepOutZone = useShell((s) => s.resizeKeepOutZone);
  const selected = usePanelSelection((s) => s.selected);
  const setSelection = usePanelSelection((s) => s.set);
  const toggleSelection = usePanelSelection((s) => s.toggle);
  const clearSelection = usePanelSelection((s) => s.clear);
  const keepOutSelected = useKeepOutSelection((s) => s.selected);
  const setKeepOutSelection = useKeepOutSelection((s) => s.set);
  const toggleKeepOutSelection = useKeepOutSelection((s) => s.toggle);
  const clearKeepOutSelection = useKeepOutSelection((s) => s.clear);
  // The mm fit-group: getRelativePointerPosition() maps the pointer into panel mm,
  // accounting for the parent stage pan/zoom and this group's fit scale.
  const fitGroupRef = useRef<Konva.Group>(null);
  const W = Math.max(widthMm, 1);
  const H = Math.max(heightMm, 1);
  // Shared zoom/pan/fit on the Konva stage: container size, stage transform, fit
  // scale, viewport mirror (so the SVG rulers overlay follows the transform),
  // Space-to-pan. The panel shows real-world zoom %, mapping stage scale via pxPerMm.
  const {
    containerRef, stageRef, size, fit, viewport, zoomPct, spaceDown,
    syncViewport, centerAt, fitView, onWheel, zoomButton, dragBoundFunc,
  } = useKonvaViewport({
    worldW: W,
    worldH: H,
    rulerLeft: RULER_LEFT,
    rulerTop: RULER_TOP,
    scaleToPct: (s, f) => Math.round((f * s / pxPerMm) * 100),
  });
  // Hover crosshair + readout overlay (opt-in, RAF-coalesced, Esc to dismiss).
  const { hoverPx, showCrosshair, setShowCrosshair, queueHover } = useCrosshairState();
  const [tool, setTool] = useState<PanelTool>("select");
  const panMode = tool === "pan" || spaceDown;
  // Resolved board extents (mm) keyed by design id — shared hook, fetched once per design.
  const sizes = usePlacedBoardSizes();
  const previewImages = useDesignPreviewImages();
  // Panel-level findings from the single source of truth (evaluatePanel).
  // byInstance maps each instance id to its worst severity — drives canvas highlight.
  const { byInstance, byTooling } = usePanelFindings();
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
  // Keep-out zone draw preview (mm) while dragging in "keepout" tool mode.
  const [keepOutDraw, setKeepOutDraw] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const keepOutDrawStart = useRef<{ x: number; y: number } | null>(null);
  // Live drag delta for selected keep-out zones (mm). Committed on drag end.
  const [keepOutDragDelta, setKeepOutDragDelta] = useState<{ dx: number; dy: number } | null>(null);
  const keepOutDragStart = useRef<{ x: number; y: number } | null>(null);
  // Live resize preview for a single keep-out zone (mm). Committed on mouseup.
  const [keepOutResize, setKeepOutResize] = useState<{ id: string; x_mm: number; y_mm: number; width_mm: number; height_mm: number } | null>(null);
  const keepOutResizeRef = useRef<{ id: string; corner: ZoneCorner; fixedX: number; fixedY: number } | null>(null);

  // Live keep-out resize preview → drives real-time DFM tinting of boards/holes.
  const keepOutPreviewBox = keepOutResize ? keepOutBox(keepOutResize) : null;

  // During a zone resize, holes inside the preview rect tint live (all zones forbid tooling).
  const liveToolingSeverity = useMemo((): Map<string, Severity> => {
    if (!keepOutPreviewBox) return byTooling;
    const m = new Map(byTooling);
    for (const h of holes) {
      const hb = toolingHoleBounds({ xMm: h.x_mm, yMm: h.y_mm, diameterMm: h.diameter_mm });
      if (boxesOverlap(hb, keepOutPreviewBox)) m.set(h.id, "block");
    }
    return m;
  }, [keepOutPreviewBox, byTooling, holes]);

  // Prune the ephemeral selection to ids still present (e.g. after a delete or an
  // undo that dropped instances). Cheap; runs whenever the instance set changes.
  useEffect(() => {
    usePanelSelection.getState().retain(new Set(instances.map((i) => i.id)));
  }, [instances]);

  // Prune the keep-out selection to zone ids still present.
  useEffect(() => {
    useKeepOutSelection.getState().retain(new Set(zones.map((z) => z.id)));
  }, [zones]);

  // Instances with resolved extents — the candidate set for marquee hit-testing
  // and selection. Placements are side-agnostic, so every instance is visible.
  const visibleInstances = useMemo(
    () => instances.filter((i) => sizes[i.design_id]),
    [instances, sizes],
  );


  const realSize = useCallback(() => centerAt(pxPerMm / fit, true), [centerAt, pxPerMm, fit]);
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
  const snapPts = useMemo(
    () => buildSnapCandidates(W, H, visibleInstances, sizes),
    [W, H, visibleInstances, sizes],
  );

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
  const selectionBBox = useMemo(
    () => computeSelectionBBox(instances, selected, sizes, rotPreview),
    [instances, selected, sizes, rotPreview],
  );

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

  // Context-menu / HUD / align-bar actions over the current selection.
  const { rotateSelectionBy, resetSelectionRotation, deleteSelected, openSelectedDesign, alignSelected, distributeSelected, duplicateSelected } =
    usePanelContextActions({ instances, sizes, panelW: W, panelH: H, rotateInstancesBy, clampSelectionIntoPanel });

  // --- Instance interaction (select tool only) ---
  const onInstanceClick = (id: string) => (e: KonvaEventObject<MouseEvent>) => {
    if (tool !== "select") return;
    e.cancelBubble = true; // don't trigger the empty-canvas click → clear
    // Clicking a board clears zone selection.
    clearKeepOutSelection();
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

  // --- Keep-out zone interaction handlers ---
  const onZoneMouseDown = (id: string, e: KonvaEventObject<MouseEvent>) => {
    e.cancelBubble = true;
    // Clicking a zone clears board selection and selects this zone.
    clearSelection();
    const native = e.evt;
    // Only replace the selection when this zone isn't already in it — otherwise
    // dragging one of several selected zones would collapse the selection to it.
    if (native.shiftKey || native.ctrlKey || native.metaKey) toggleKeepOutSelection(id);
    else if (!useKeepOutSelection.getState().selected.has(id)) setKeepOutSelection([id]);
    keepOutDragStart.current = pointerMm();
    setKeepOutDragDelta({ dx: 0, dy: 0 });
  };

  const onZoneDragMove = (id: string, e: KonvaEventObject<DragEvent>) => {
    e.cancelBubble = true;
    if (!keepOutDragStart.current) return;
    const p = pointerMm();
    if (!p) return;
    let dx = p.x - keepOutDragStart.current.x;
    let dy = p.y - keepOutDragStart.current.y;
    // Snap to 1 mm grid.
    dx = Math.round(dx);
    dy = Math.round(dy);
    // Clamp delta so all selected zones stay inside the panel.
    const selZones = zones.filter((z) => keepOutSelected.has(z.id));
    let cdx = dx;
    let cdy = dy;
    for (const z of selZones) {
      cdx = Math.max(cdx, -z.x_mm);
      cdx = Math.min(cdx, W - z.x_mm - z.width_mm);
      cdy = Math.max(cdy, -z.y_mm);
      cdy = Math.min(cdy, H - z.y_mm - z.height_mm);
    }
    setKeepOutDragDelta({ dx: cdx, dy: cdy });
    // Pin the dragged Konva node back to its committed pose (store-driven render).
    const node = e.target;
    const zone = zones.find((z) => z.id === id);
    if (zone) { node.x(zone.x_mm + cdx); node.y(zone.y_mm + cdy); }
  };

  const onZoneDragEnd = (id: string, e: KonvaEventObject<DragEvent>) => {
    e.cancelBubble = true;
    const d = keepOutDragDelta;
    keepOutDragStart.current = null;
    setKeepOutDragDelta(null);
    // Reset the node position back to the committed pose.
    const node = e.target;
    const zone = zones.find((z) => z.id === id);
    if (zone) { node.x(zone.x_mm); node.y(zone.y_mm); }
    if (d && (d.dx !== 0 || d.dy !== 0)) void moveKeepOutZones([...keepOutSelected], d.dx, d.dy);
  };

  const onZoneHandleDown = (id: string, corner: ZoneCorner) => {
    const zone = zones.find((z) => z.id === id);
    if (!zone) return;
    clearSelection();                 // drop board selection
    setKeepOutSelection([id]);        // resize implies single zone selection
    const fixedX = corner === "tl" || corner === "bl" ? zone.x_mm + zone.width_mm : zone.x_mm;
    const fixedY = corner === "tl" || corner === "tr" ? zone.y_mm + zone.height_mm : zone.y_mm;
    keepOutResizeRef.current = { id, corner, fixedX, fixedY };
    setKeepOutResize({ id, x_mm: zone.x_mm, y_mm: zone.y_mm, width_mm: zone.width_mm, height_mm: zone.height_mm });
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
    if (tool === "keepout") {
      // Drag on empty canvas starts drawing a new keep-out zone.
      const p = pointerMm();
      if (!p) return;
      clearKeepOutSelection();
      keepOutDrawStart.current = p;
      setKeepOutDraw({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      return;
    }
    if (tool !== "select") return;
    // On select tool: clear keep-out selection too when clicking empty canvas.
    clearKeepOutSelection();
    const p = pointerMm();
    if (!p) return;
    marqueeStart.current = p;
    setMarquee({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };

  const onStageMouseMove = (e: KonvaEventObject<MouseEvent>) => {
    // Resize-in-progress takes priority over everything else.
    if (keepOutResizeRef.current) {
      const p = pointerMm();
      if (!p) return;
      const { fixedX, fixedY } = keepOutResizeRef.current;
      const snap = !e.evt.altKey;                 // Alt disables 1 mm snap
      const px = snap ? Math.round(p.x) : p.x;
      const py = snap ? Math.round(p.y) : p.y;
      const cxp = Math.max(0, Math.min(px, W));    // clamp pointer into panel
      const cyp = Math.max(0, Math.min(py, H));
      const rect = { x_mm: fixedX, y_mm: fixedY, width_mm: cxp - fixedX, height_mm: cyp - fixedY };
      setKeepOutResize({ id: keepOutResizeRef.current.id, ...clampZoneRect(rect, W, H, KEEPOUT_MIN_MM) });
      return;
    }
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
    // Live keep-out zone draw preview.
    if (tool === "keepout" && keepOutDrawStart.current) {
      const p = pointerMm();
      if (p) setKeepOutDraw({ x0: keepOutDrawStart.current.x, y0: keepOutDrawStart.current.y, x1: p.x, y1: p.y });
    }
    // Live marquee (select tool) — unchanged.
    if (!marqueeStart.current) return;
    const p = pointerMm();
    if (!p) return;
    setMarquee({ x0: marqueeStart.current.x, y0: marqueeStart.current.y, x1: p.x, y1: p.y });
  };

  const onBgMouseUp = () => {
    // Commit a keep-out zone resize.
    if (keepOutResizeRef.current) {
      const r = keepOutResize;
      const id = keepOutResizeRef.current.id;
      keepOutResizeRef.current = null;
      setKeepOutResize(null);
      if (r) void resizeKeepOutZone(id, { x_mm: r.x_mm, y_mm: r.y_mm, width_mm: r.width_mm, height_mm: r.height_mm });
      return;
    }
    // Commit a keep-out zone draw.
    if (tool === "keepout" && keepOutDrawStart.current && keepOutDraw) {
      const d = keepOutDraw;
      keepOutDrawStart.current = null;
      setKeepOutDraw(null);
      const x_mm = Math.min(d.x0, d.x1);
      const y_mm = Math.min(d.y0, d.y1);
      const width_mm = Math.round(Math.abs(d.x1 - d.x0));
      const height_mm = Math.round(Math.abs(d.y1 - d.y0));
      // Minimum 1 mm × 1 mm to avoid accidental tiny zones.
      if (width_mm < 1 || height_mm < 1) return;
      void addKeepOutZone({ x_mm: Math.round(x_mm), y_mm: Math.round(y_mm), width_mm, height_mm });
      return;
    }
    keepOutDrawStart.current = null;
    setKeepOutDraw(null);

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

  // Keyboard + lifecycle effects (tool-change cleanup, Delete/Esc on the selected
  // tooling hole / keep-out zones, commit resize on mouseup outside the window).
  usePanelKeyHandlers({
    tool,
    selectedHoleId,
    setSelectedHoleId,
    addArmed,
    setAddArmed,
    setGhostMm,
    keepOutDrawStartRef: keepOutDrawStart,
    setKeepOutDraw,
    removeToolingHole,
    removeKeepOutZones,
    keepOutResizeRef,
    keepOutResize,
    setKeepOutResize,
    resizeKeepOutZone,
  });

  return (
    <>
    <ContextMenu>
      <ContextMenuTrigger asChild>
    <div
      ref={containerRef}
      className={`relative h-full w-full overflow-hidden bg-[#0a0c10] ${panMode ? "cursor-grab" : addArmed || tool === "keepout" ? "cursor-crosshair" : ""}`}
    >
      <Stage
        ref={stageRef}
        width={size.w}
        height={size.h}
        draggable={panMode}
        dragBoundFunc={dragBoundFunc}
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
              fill={BLANK_FILL}
              stroke={BLANK_STROKE}
              strokeWidth={1.25}
              strokeScaleEnabled={false}
            />
            {instances.length === 0 && (
              <Text
                x={0}
                y={H / 2 - labelMm / 2}
                width={W}
                align="center"
                text={t("panel.canvas.copper")}
                fontSize={labelMm}
                fill={BLANK_LABEL}
                listening={false}
              />
            )}
            {/* Keep-out zones rendered UNDER board instances. */}
            <KeepOutLayer
              zones={zones}
              selected={keepOutSelected}
              dragDelta={keepOutDragDelta}
              pxPerMm={viewport.pxPerMm}
              interactive={tool === "select" || tool === "keepout"}
              onZoneMouseDown={onZoneMouseDown}
              onZoneDragMove={onZoneDragMove}
              onZoneDragEnd={onZoneDragEnd}
              resizePreview={keepOutResize}
              onHandleMouseDown={(id, corner) => onZoneHandleDown(id, corner)}
            />
            {/* Derived clamp keep-out zones (dashed ochre squares around tooling holes). */}
            <ClampZoneLayer holes={holes} clampRadiusMm={clampRadiusMm} />
            <InstanceLayer
              instances={visibleInstances}
              sizes={sizes}
              selected={selected}
              dragDelta={dragDelta}
              rotPreview={rotPreview}
              previewImages={previewImages}
              byInstance={byInstance}
              keepOutPreviewBox={keepOutPreviewBox}
              tool={tool}
              panelW={W}
              panelH={H}
              onInstanceClick={onInstanceClick}
              onInstanceContextMenu={onInstanceContextMenu}
              onInstanceDragStart={onInstanceDragStart}
              onInstanceDragMove={onInstanceDragMove}
              onInstanceDragEnd={onInstanceDragEnd}
            />
            <SelectionOverlay
              instances={visibleInstances}
              sizes={sizes}
              selected={selected}
              dragDelta={dragDelta}
              rotPreview={rotPreview}
              pxPerMm={viewport.pxPerMm}
            />
            {tool === "select" && !dragDelta && selectionBBox && viewport.pxPerMm > 0 && (() => {
              // Knob hangs off the bottom-right corner of the nearest selected board
              // (diagonal stub), leaving the top-centre clear for the selection HUD;
              // rotation pivot stays the union centre. Anchoring to a real board corner
              // (not the union AABB corner) keeps the knob attached under multi-select,
              // where the union corner often floats in the empty gap between boards.
              // Offset and radius are constant SCREEN px (÷ pxPerMm → mm), like the
              // corner handles, so the knob neither balloons in nor vanishes on zoom.
              // Gated on a measured viewport (pxPerMm>0) so the knob never renders as a
              // zero-radius, unclickable node before first layout (mirrors SelectionOverlay).
              const mmPerPx = 1 / viewport.pxPerMm;
              const k = (ROT_KNOB_OUT_PX / Math.SQRT2) * mmPerPx;
              return (
                <RotationHandle
                  cx={(selectionBBox.minX + selectionBBox.maxX) / 2}
                  cy={(selectionBBox.minY + selectionBBox.maxY) / 2}
                  anchorX={selectionBBox.anchorX}
                  anchorY={selectionBBox.anchorY}
                  knobX={selectionBBox.anchorX + k}
                  knobY={selectionBBox.anchorY + k}
                  radiusMm={ROT_KNOB_R_PX * mmPerPx}
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
              severityByHole={liveToolingSeverity}
              onHoleMouseDown={onHoleMouseDown}
              onHoleDragEnd={onHoleDragEnd}
            />
            {/* Ghost crosshair preview of the hole-to-be while placement is armed. */}
            {tool === "tooling" && addArmed && ghostMm && (
              <ToolingGhostCrosshair x={ghostMm.x} y={ghostMm.y} pxPerMm={viewport.pxPerMm} />
            )}
            {marquee && <MarqueeRect rect={marquee} />}
            {/* Keep-out zone draw preview while dragging in keepout tool mode. */}
            {keepOutDraw && <KeepOutDrawRect rect={keepOutDraw} />}
          </Group>
        </Layer>
      </Stage>

      <RulersOverlay
        viewport={viewport}
        size={size}
        fmt={fmtLen}
        extentMm={{ x: 0, y: 0, w: W, h: H }}
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

      <div className="absolute right-3 z-10 rounded-md border border-border bg-card/90 px-2 py-1 text-[11px] tabular-nums text-muted-foreground" style={{ top: RULER_TOP + 6 }}>
        {W} × {H} mm
      </div>

      <ZoomToolbar
        zoomPct={zoomPct}
        onZoomOut={() => zoomButton(1 / ZOOM_STEP)}
        onZoomIn={() => zoomButton(ZOOM_STEP)}
        onReset={realSize}
        resetLabel={t("common:viewer.realSize")}
        onFit={fitView}
      >
        <button
          className={`rounded p-1 hover:bg-muted/60 ${showCrosshair ? "bg-primary/20 text-primary" : ""}`}
          aria-label={t("common:viewer.crosshair")}
          title={t("common:viewer.crosshair")}
          onClick={() => setShowCrosshair((v) => !v)}
        >
          <LocateFixed className="size-4" />
        </button>
      </ZoomToolbar>
    </div>
      </ContextMenuTrigger>
      <PanelContextMenuContent
        hasSelection={hasSelection}
        selectedCount={selected.size}
        keepOutSelectedCount={keepOutSelected.size}
        onDeleteKeepOut={() => { void removeKeepOutZones([...keepOutSelected]); clearKeepOutSelection(); }}
        onOpenDesign={() => openSelectedDesign()}
        onDuplicate={() => duplicateSelected()}
        onRotateCw={() => rotateSelectionBy(90)}
        onRotateCcw={() => rotateSelectionBy(-90)}
        onResetRotation={() => resetSelectionRotation()}
        onRenest={() => setRenestOpen(true)}
        onDelete={() => deleteSelected()}
      />
    </ContextMenu>
    <RenestDialog
      open={renestOpen}
      onClose={() => setRenestOpen(false)}
      selectedIds={[...selected]}
      instances={instances}
      toolingHoles={holes}
      keepOutZones={zones}
      sizes={sizes}
      panelW={W}
      panelH={H}
      onApply={(items) => void useShell.getState().setInstanceTransforms(items)}
    />
    <RegistrationSetDialog
      open={regSetOpen}
      onClose={() => setRegSetOpen(false)}
      panelW={W}
      panelH={H}
      existingHoles={holes}
      onApply={(opts) => void addRegistrationSet(opts)}
    />
    </>
  );
}

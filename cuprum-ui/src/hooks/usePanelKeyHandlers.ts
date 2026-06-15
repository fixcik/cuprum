import { useEffect, type MutableRefObject } from "react";
import { useKeepOutSelection } from "@/keepOutSelectionStore";
import type { PanelTool } from "@/components/panel/PanelToolPalette";
import type { ZoneCorner } from "@/components/panel/KeepOutLayer";

/** Live resize preview for a single keep-out zone (mm). */
export interface KeepOutResizeState {
  id: string;
  x_mm: number;
  y_mm: number;
  width_mm: number;
  height_mm: number;
}

/** Resize gesture anchor: the zone + corner being dragged and the fixed opposite corner. */
export interface KeepOutResizeAnchor {
  id: string;
  corner: ZoneCorner;
  fixedX: number;
  fixedY: number;
}

/** Keyboard + lifecycle effects for the panel-blank canvas, kept out of the render
 *  component: tool-change cleanup, Delete/Esc on the selected tooling hole, Delete/Esc
 *  on selected keep-out zones, and committing an in-progress zone resize when the mouse
 *  is released outside the window. Extracted verbatim from PanelBlankCanvas. */
export function usePanelKeyHandlers(opts: {
  tool: PanelTool;
  selectedHoleId: string | null;
  setSelectedHoleId: (v: string | null) => void;
  addArmed: boolean;
  setAddArmed: (v: boolean) => void;
  setGhostMm: (v: { x: number; y: number } | null) => void;
  keepOutDrawStartRef: MutableRefObject<{ x: number; y: number } | null>;
  setKeepOutDraw: (v: { x0: number; y0: number; x1: number; y1: number } | null) => void;
  removeToolingHole: (id: string) => Promise<void> | void;
  removeKeepOutZones: (ids: string[]) => Promise<void> | void;
  keepOutResizeRef: MutableRefObject<KeepOutResizeAnchor | null>;
  keepOutResize: KeepOutResizeState | null;
  setKeepOutResize: (v: KeepOutResizeState | null) => void;
  resizeKeepOutZone: (id: string, r: KeepOutResizeState) => Promise<void> | void;
  /** Reset the measure tool's endpoints + hover (on Esc or when leaving measure). */
  clearMeasure: () => void;
}): void {
  const {
    tool,
    selectedHoleId,
    setSelectedHoleId,
    addArmed,
    setAddArmed,
    setGhostMm,
    keepOutDrawStartRef,
    setKeepOutDraw,
    removeToolingHole,
    removeKeepOutZones,
    keepOutResizeRef,
    keepOutResize,
    setKeepOutResize,
    resizeKeepOutZone,
    clearMeasure,
  } = opts;

  // Disarm placement when leaving tooling mode. Hole selection survives into the
  // select tool (holes are selectable there too), so only drop it outside both.
  // Clear keep-out draw state when leaving keepout mode.
  useEffect(() => {
    if (tool !== "tooling") {
      setAddArmed(false);
      setGhostMm(null);
    }
    if (tool !== "tooling" && tool !== "select") {
      setSelectedHoleId(null);
    }
    if (tool !== "keepout") {
      keepOutDrawStartRef.current = null;
      setKeepOutDraw(null);
    }
    if (tool !== "measure") {
      clearMeasure();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  // Esc clears the in-progress / placed measurement.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (tool !== "measure" || e.key !== "Escape") return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      clearMeasure();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool, clearMeasure]);

  // Delete/Backspace removes the selected tooling hole; Esc deselects it. Active in
  // tooling and select (holes are selectable in both). Selection is exclusive, so a
  // hole is only set when no board/zone is selected — no Delete ambiguity.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (tool !== "tooling" && tool !== "select") return;
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
  }, [tool, selectedHoleId, addArmed, removeToolingHole, setSelectedHoleId, setAddArmed, setGhostMm]);

  // Delete/Backspace removes selected keep-out zones; Esc clears selection.
  // Works in both "select" and "keepout" modes. Reads the live zone selection from
  // the store, so no selection state is threaded in.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (tool !== "select" && tool !== "keepout") return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const zonesSelected = useKeepOutSelection.getState().selected;
      if ((e.key === "Delete" || e.key === "Backspace") && zonesSelected.size > 0) {
        e.preventDefault();
        const ids = [...zonesSelected];
        useKeepOutSelection.getState().clear();
        void removeKeepOutZones(ids);
      } else if (e.key === "Escape" && zonesSelected.size > 0) {
        useKeepOutSelection.getState().clear();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool, removeKeepOutZones]);

  // Commit an in-progress keep-out resize even if the mouse is released OUTSIDE the
  // canvas/window — the Stage onMouseUp won't fire there. The ref null-check avoids a
  // double commit: the Stage handler runs first and clears the ref, so this listener
  // then sees null and bails.
  useEffect(() => {
    const onUp = () => {
      if (!keepOutResizeRef.current) return;
      const r = keepOutResize;
      const id = keepOutResizeRef.current.id;
      keepOutResizeRef.current = null;
      setKeepOutResize(null);
      if (r) void resizeKeepOutZone(id, r);
    };
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, [keepOutResize, resizeKeepOutZone, keepOutResizeRef, setKeepOutResize]);
}

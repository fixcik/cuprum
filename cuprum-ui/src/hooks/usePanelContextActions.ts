import { useCallback } from "react";
import { useShell } from "@/shellStore";
import { usePanelSelection } from "@/panelSelectionStore";
import { useKeepOutSelection } from "@/keepOutSelectionStore";
import { api, type BoardInstance } from "@/lib/api";
import {
  instanceBounds,
  clampDeltaToPanel,
  boxesForInstances,
  alignInstances,
  distributeInstances,
  type AlignEdge,
} from "@/lib/panelPlacement";

/** Resolved board extents (mm) keyed by design id. */
type BoardSizes = Record<string, { w: number; h: number }>;

export interface PanelContextActions {
  rotateSelectionBy: (deltaDeg: number) => void;
  resetSelectionRotation: () => void;
  deleteSelected: () => void;
  openSelectedDesign: () => void;
  alignSelected: (edge: AlignEdge) => void;
  distributeSelected: (axis: "h" | "v") => void;
  duplicateSelected: () => void;
}

/** Selection-level actions surfaced by the panel context menu, the SelectionHud and
 *  the align bar. They read the live selection from the stores (so they don't churn on
 *  every selection change) and act through the shell store; `clampSelectionIntoPanel`
 *  pulls a rotated/moved selection back inside the panel. Extracted verbatim from
 *  PanelBlankCanvas to keep that component focused on rendering. */
export function usePanelContextActions(opts: {
  instances: BoardInstance[];
  sizes: BoardSizes;
  panelW: number;
  panelH: number;
  rotateInstancesBy: (ids: string[], deltaDeg: number) => Promise<void> | void;
  clampSelectionIntoPanel: (ids: string[]) => Promise<void>;
}): PanelContextActions {
  const { instances, sizes, panelW, panelH, rotateInstancesBy, clampSelectionIntoPanel } = opts;

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
    const zoneIds = [...useKeepOutSelection.getState().selected];
    if (!ids.length && !zoneIds.length) return;
    if (ids.length) {
      void useShell.getState().removeInstances(ids);
      usePanelSelection.getState().clear();
    }
    if (zoneIds.length) {
      void useShell.getState().removeKeepOutZones(zoneIds);
      useKeepOutSelection.getState().clear();
    }
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
  const selectedAlignItems = useCallback(() => {
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
  }, [instances, sizes]);

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

  // Duplicate the current selection with a clamped offset so copies stay within the
  // panel bounds. Re-selects the new copies on completion.
  const duplicateSelected = useCallback(() => {
    const sel = [...usePanelSelection.getState().selected];
    if (!sel.length) return;
    const instById = new Map(instances.map((i) => [i.id, i]));
    const picked = sel.map((id) => instById.get(id)).filter(Boolean) as BoardInstance[];
    const { dx, dy } = clampDeltaToPanel(boxesForInstances(picked, sizes), 2, 2, panelW, panelH);
    void useShell.getState().duplicateInstances(sel, dx, dy).then((ids) => usePanelSelection.getState().set(ids));
  }, [instances, sizes, panelW, panelH]);

  return {
    rotateSelectionBy,
    resetSelectionRotation,
    deleteSelected,
    openSelectedDesign,
    alignSelected,
    distributeSelected,
    duplicateSelected,
  };
}

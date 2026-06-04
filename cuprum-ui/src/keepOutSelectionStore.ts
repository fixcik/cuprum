import { create } from "zustand";

/** Ephemeral selection of panel KeepOutZones (by id). NOT persisted, NOT part of
 *  undo — purely a UI concern for the panel editor. Pruned when zones vanish
 *  and cleared on project/document change. Separate from the board-instance
 *  selection so Delete/Esc don't mix up zones and boards. */
interface KeepOutSelectionState {
  selected: Set<string>;
  set: (ids: string[]) => void;
  toggle: (id: string) => void;
  add: (id: string) => void;
  clear: () => void;
  /** Drop ids no longer present (e.g. after delete or document swap). */
  retain: (present: Set<string>) => void;
}

export const useKeepOutSelection = create<KeepOutSelectionState>((set) => ({
  selected: new Set(),
  set: (ids) => set({ selected: new Set(ids) }),
  toggle: (id) =>
    set((s) => {
      const next = new Set(s.selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selected: next };
    }),
  add: (id) => set((s) => (s.selected.has(id) ? s : { selected: new Set(s.selected).add(id) })),
  clear: () => set((s) => (s.selected.size === 0 ? s : { selected: new Set() })),
  retain: (present) =>
    set((s) => {
      const next = new Set([...s.selected].filter((id) => present.has(id)));
      return next.size === s.selected.size ? s : { selected: next };
    }),
}));

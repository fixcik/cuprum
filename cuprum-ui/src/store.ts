import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  api,
  SCREEN_W_MM,
  SCREEN_H_MM,
  type PrinterInfo,
  type PrintStatus,
} from "./lib/api";

export type AlignEdge = "left" | "hcenter" | "right" | "top" | "vmiddle" | "bottom";

export interface Placement {
  id: string;
  path: string;
  name: string;
  xMm: number; // top-left on screen
  yMm: number;
  rotationDeg: number;
  wMm: number;
  hMm: number;
  pngUrl: string;
}

interface Store {
  // board reference frame (mm)
  boardWmm: number;
  boardHmm: number;
  boardXmm: number;
  boardYmm: number;
  // view + exposure
  mirror: boolean;
  invert: boolean;
  exposureS: number;
  pwm: number;
  // tool + layout
  tool: "select" | "pan";
  placements: Placement[];
  selectedIds: string[];
  clipboard: Placement[] | null;
  // printer / status
  printer: PrinterInfo | null;
  status: PrintStatus | null;
  busy: boolean;
  previewLoading: boolean;
  error: string | null;

  setBoard: (w: number, h: number) => void;
  setBoardPos: (x: number, y: number) => void;
  centerBoard: () => void;
  setMirror: (b: boolean) => void;
  setInvert: (b: boolean) => void;
  setExposure: (s: number) => void;
  setPwm: (p: number) => void;
  setTool: (t: "select" | "pan") => void;
  select: (id: string | null, additive?: boolean) => void;
  selectMany: (ids: string[], additive: boolean) => void;
  movePlacement: (id: string, xMm: number, yMm: number) => void;
  moveMany: (updates: { id: string; xMm: number; yMm: number }[]) => void;
  centerSelected: () => void;
  alignSelected: (edge: AlignEdge) => void;
  distributeSelected: (axis: "h" | "v") => void;
  autoArrange: (count: number, gapMm: number) => void;
  fillBoard: (gapMm: number) => void;
  addGerber: () => Promise<void>;
  removeSelected: () => void;
  copySelected: () => void;
  paste: () => void;
  duplicateSelected: () => void;
  discover: () => Promise<void>;
  print: () => Promise<void>;
  applyStatus: (s: PrintStatus) => void;
  reloadPreviews: () => Promise<void>;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A duplicate of a placement, nudged +4mm and kept on-screen, with a fresh id. */
function offsetCopy(src: Placement): Placement {
  return {
    ...src,
    id: crypto.randomUUID(),
    xMm: clamp(src.xMm + 4, 0, Math.max(0, SCREEN_W_MM - src.wMm)),
    yMm: clamp(src.yMm + 4, 0, Math.max(0, SCREEN_H_MM - src.hMm)),
  };
}

export const useStore = create<Store>()(
  persist(
    (set, get) => ({
  boardWmm: 100,
  boardHmm: 80,
  boardXmm: (SCREEN_W_MM - 100) / 2,
  boardYmm: (SCREEN_H_MM - 80) / 2,
  mirror: false,
  invert: false,
  exposureS: 90,
  pwm: 255,
  tool: "select",
  placements: [],
  selectedIds: [],
  clipboard: null,
  printer: null,
  status: null,
  busy: false,
  previewLoading: false,
  error: null,

  setBoard: (w, h) => set({ boardWmm: clamp(w, 1, SCREEN_W_MM), boardHmm: clamp(h, 1, SCREEN_H_MM) }),
  setBoardPos: (x, y) => {
    // Defensive: a NaN position makes the board vanish from the canvas.
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    set({ boardXmm: x, boardYmm: y });
  },
  centerBoard: () =>
    set((st) => ({
      boardXmm: (SCREEN_W_MM - st.boardWmm) / 2,
      boardYmm: (SCREEN_H_MM - st.boardHmm) / 2,
    })),
  setMirror: (b) => set({ mirror: b }),
  setInvert: (b) => set({ invert: b }),
  setExposure: (s) => set({ exposureS: clamp(Math.round(s), 1, 600) }),
  setPwm: (p) => set({ pwm: clamp(Math.round(p), 1, 255) }),
  setTool: (t) => set({ tool: t }),

  // Set the selection from a marquee; additive unions with the current selection.
  selectMany: (ids, additive) =>
    set((st) => ({ selectedIds: additive ? [...new Set([...st.selectedIds, ...ids])] : ids })),

  // Plain click selects one; additive (shift/⌘) toggles membership; null clears.
  select: (id, additive = false) =>
    set((st) => {
      if (id === null) return { selectedIds: [] };
      if (!additive) return { selectedIds: [id] };
      return st.selectedIds.includes(id)
        ? { selectedIds: st.selectedIds.filter((x) => x !== id) }
        : { selectedIds: [...st.selectedIds, id] };
    }),

  movePlacement: (id, xMm, yMm) =>
    set((st) => ({
      placements: st.placements.map((p) => (p.id === id ? { ...p, xMm, yMm } : p)),
    })),

  moveMany: (updates) =>
    set((st) => {
      const map = new Map(updates.map((u) => [u.id, u]));
      return {
        placements: st.placements.map((p) => {
          const u = map.get(p.id);
          return u ? { ...p, xMm: u.xMm, yMm: u.yMm } : p;
        }),
      };
    }),

  centerSelected: () =>
    set((st) => ({
      placements: st.placements.map((p) =>
        st.selectedIds.includes(p.id)
          ? { ...p, xMm: (SCREEN_W_MM - p.wMm) / 2, yMm: (SCREEN_H_MM - p.hMm) / 2 }
          : p,
      ),
    })),

  // Align the selection to its own bounding box (classic align-left/center/etc.).
  alignSelected: (edge) =>
    set((st) => {
      const sel = st.placements.filter((p) => st.selectedIds.includes(p.id));
      if (sel.length < 2) return {};
      const minX = Math.min(...sel.map((p) => p.xMm));
      const maxX = Math.max(...sel.map((p) => p.xMm + p.wMm));
      const minY = Math.min(...sel.map((p) => p.yMm));
      const maxY = Math.max(...sel.map((p) => p.yMm + p.hMm));
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const adj = (p: Placement): Placement => {
        switch (edge) {
          case "left": return { ...p, xMm: minX };
          case "right": return { ...p, xMm: maxX - p.wMm };
          case "hcenter": return { ...p, xMm: cx - p.wMm / 2 };
          case "top": return { ...p, yMm: minY };
          case "bottom": return { ...p, yMm: maxY - p.hMm };
          case "vmiddle": return { ...p, yMm: cy - p.hMm / 2 };
        }
      };
      return { placements: st.placements.map((p) => (st.selectedIds.includes(p.id) ? adj(p) : p)) };
    }),

  // Even spacing of selection centers along an axis (needs ≥3).
  distributeSelected: (axis) =>
    set((st) => {
      const sel = st.placements.filter((p) => st.selectedIds.includes(p.id));
      if (sel.length < 3) return {};
      const cOf = (p: Placement) => (axis === "h" ? p.xMm + p.wMm / 2 : p.yMm + p.hMm / 2);
      const sorted = [...sel].sort((a, b) => cOf(a) - cOf(b));
      const c0 = cOf(sorted[0]);
      const step = (cOf(sorted[sorted.length - 1]) - c0) / (sorted.length - 1);
      const np = new Map<string, Placement>();
      sorted.forEach((p, i) => {
        const c = c0 + step * i;
        np.set(p.id, axis === "h" ? { ...p, xMm: c - p.wMm / 2 } : { ...p, yMm: c - p.hMm / 2 });
      });
      return { placements: st.placements.map((p) => np.get(p.id) ?? p) };
    }),

  // Killer feature: pack `count` copies of the template (the selected placement,
  // else the first) into a grid on the board reference frame. Replaces existing
  // copies of that file; other files are left untouched.
  autoArrange: (count, gapMm) =>
    set((st) => {
      const tmpl =
        st.placements.find((p) => st.selectedIds.includes(p.id)) ?? st.placements[0];
      if (!tmpl) return {};
      const n = clamp(Math.floor(count), 1, 1000);
      const gap = Math.max(0, gapMm);
      const { wMm: w, hMm: h } = tmpl;
      const cols = Math.max(1, Math.floor((st.boardWmm + gap) / (w + gap)));
      const rows = Math.ceil(n / cols);
      const gridW = cols * w + (cols - 1) * gap;
      const gridH = rows * h + (rows - 1) * gap;
      const startX = st.boardXmm + Math.max(0, (st.boardWmm - gridW) / 2);
      const startY = st.boardYmm + Math.max(0, (st.boardHmm - gridH) / 2);
      const others = st.placements.filter((p) => p.path !== tmpl.path);
      const copies: Placement[] = [];
      for (let i = 0; i < n; i++) {
        const c = i % cols;
        const r = Math.floor(i / cols);
        copies.push({
          ...tmpl,
          id: crypto.randomUUID(),
          xMm: startX + c * (w + gap),
          yMm: startY + r * (h + gap),
        });
      }
      return { placements: [...others, ...copies], selectedIds: copies.map((p) => p.id) };
    }),

  // Fill the board with as many copies of the template as fit (max rows × cols).
  fillBoard: (gapMm) => {
    const st = get();
    const tmpl = st.placements.find((p) => st.selectedIds.includes(p.id)) ?? st.placements[0];
    if (!tmpl) return;
    const gap = Math.max(0, gapMm);
    const cols = Math.max(1, Math.floor((st.boardWmm + gap) / (tmpl.wMm + gap)));
    const rows = Math.max(1, Math.floor((st.boardHmm + gap) / (tmpl.hMm + gap)));
    get().autoArrange(cols * rows, gap);
  },

  addGerber: async () => {
    try {
      const path = await api.pickGerber();
      if (!path) return;
      set({ previewLoading: true, error: null });
      const pv = await api.renderPreview(path);
      const name = path.split(/[/\\]/).pop() ?? path;
      const id = crypto.randomUUID();
      const placement: Placement = {
        id,
        path,
        name,
        wMm: pv.width_mm,
        hMm: pv.height_mm,
        xMm: (SCREEN_W_MM - pv.width_mm) / 2,
        yMm: (SCREEN_H_MM - pv.height_mm) / 2,
        rotationDeg: 0,
        pngUrl: pv.png_data_url,
      };
      set((st) => ({ placements: [...st.placements, placement], selectedIds: [id], error: null }));
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ previewLoading: false });
    }
  },

  removeSelected: () =>
    set((st) => ({
      placements: st.placements.filter((p) => !st.selectedIds.includes(p.id)),
      selectedIds: [],
    })),

  copySelected: () =>
    set((st) => {
      const sel = st.placements.filter((p) => st.selectedIds.includes(p.id));
      return sel.length ? { clipboard: sel.map((p) => ({ ...p })) } : {};
    }),

  paste: () =>
    set((st) => {
      if (!st.clipboard?.length) return {};
      const dups = st.clipboard.map(offsetCopy);
      return { placements: [...st.placements, ...dups], selectedIds: dups.map((d) => d.id) };
    }),

  duplicateSelected: () =>
    set((st) => {
      const sel = st.placements.filter((p) => st.selectedIds.includes(p.id));
      if (!sel.length) return {};
      const dups = sel.map(offsetCopy);
      return {
        placements: [...st.placements, ...dups],
        selectedIds: dups.map((d) => d.id),
        clipboard: sel.map((p) => ({ ...p })),
      };
    }),

  discover: async () => {
    try {
      const printer = await api.discover();
      set({ printer, error: null });
    } catch (e) {
      set({ printer: null, error: String(e) });
    }
  },

  print: async () => {
    const st = get();
    if (st.placements.length === 0 || st.busy) return;
    set({ busy: true, error: null, status: { stage: "composing", message: "preparing…" } });
    try {
      await api.composeAndPrint({
        placements: st.placements.map((p) => ({
          path: p.path,
          x_mm: p.xMm,
          y_mm: p.yMm,
          rotation_deg: p.rotationDeg,
        })),
        mirror: st.mirror,
        invert: st.invert,
        exposure_s: st.exposureS,
        pwm: st.pwm,
      });
    } catch (e) {
      set({ busy: false, error: String(e) });
    }
  },

  applyStatus: (s) =>
    set({ status: s, busy: s.stage !== "done" && s.stage !== "error", error: s.stage === "error" ? s.message : null }),

  // After a reload the placements come back without their (heavy) preview PNG.
  // Re-render each UNIQUE file once (auto-arrange stores many copies of one file
  // — re-rendering per placement made reload very slow) and reuse the result for
  // every placement of that path; drop any whose file is gone.
  reloadPreviews: async () => {
    // Single-flight: a second mount (React StrictMode) or a re-render must not
    // kick off duplicate renderPreview calls while one reload is in progress.
    if (get().previewLoading) return;
    const missing = get().placements.filter((p) => !p.pngUrl);
    if (missing.length === 0) return;
    set({ previewLoading: true });
    try {
      const uniquePaths = [...new Set(missing.map((p) => p.path))];
      const results = await Promise.all(
        uniquePaths.map(async (path) => {
          try {
            return [path, await api.renderPreview(path)] as const;
          } catch {
            return [path, null] as const;
          }
        }),
      );
      const byPath = new Map(results);
      set((st) => ({
        placements: st.placements.flatMap((p) => {
          if (p.pngUrl) return [p];
          const pv = byPath.get(p.path);
          if (!pv) return []; // file gone — drop it
          return [{ ...p, pngUrl: pv.png_data_url, wMm: pv.width_mm, hMm: pv.height_mm }];
        }),
      }));
    } finally {
      set({ previewLoading: false });
    }
  },
    }),
    {
      name: "cuprum-state",
      // Persist only durable layout/exposure settings. Drop the heavy preview PNG
      // (re-rendered on load) and transient fields (printer/status/busy/error).
      partialize: (s) => ({
        boardWmm: s.boardWmm,
        boardHmm: s.boardHmm,
        boardXmm: s.boardXmm,
        boardYmm: s.boardYmm,
        mirror: s.mirror,
        invert: s.invert,
        exposureS: s.exposureS,
        pwm: s.pwm,
        selectedIds: s.selectedIds,
        placements: s.placements.map((p) => ({ ...p, pngUrl: "" })),
      }),
    },
  ),
);

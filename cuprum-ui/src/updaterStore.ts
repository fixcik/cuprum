import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/** Updater lifecycle. `available` carries the version/notes for the banner;
 *  `downloading` carries download progress; `upToDate`/`error` are only surfaced
 *  for a loud (manual) check — a silent startup check collapses them to `idle`. */
export type UpdatePhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string; notes?: string }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "restarting" }
  | { kind: "upToDate" }
  | { kind: "error" };

interface UpdaterState {
  phase: UpdatePhase;
  /** The pending update handle (download target), if any. */
  update: Update | null;
  /** User hid the banner for this session. */
  dismissed: boolean;
  /** Check for an update. `loud` (manual check) surfaces "up to date" / errors;
   *  silent (startup) collapses no-update and errors back to `idle` so a missing
   *  release manifest or offline machine never nags. */
  checkForUpdates: (loud?: boolean) => Promise<void>;
  /** Download + install the pending update, then relaunch. */
  install: () => Promise<void>;
  /** Hide the banner until the next check. */
  dismiss: () => void;
}

export const useUpdater = create<UpdaterState>((set, get) => ({
  phase: { kind: "idle" },
  update: null,
  dismissed: false,

  checkForUpdates: async (loud = false) => {
    const k = get().phase.kind;
    if (k === "checking" || k === "downloading") return;
    set({ phase: { kind: "checking" } });
    try {
      const update = await check();
      if (update) {
        set({
          update,
          dismissed: false,
          phase: { kind: "available", version: update.version, notes: update.body },
        });
      } else {
        set({ update: null, phase: loud ? { kind: "upToDate" } : { kind: "idle" } });
      }
    } catch {
      set({ phase: loud ? { kind: "error" } : { kind: "idle" } });
    }
  },

  install: async () => {
    const update = get().update;
    if (!update) return;
    let total = 0;
    let got = 0;
    set({ phase: { kind: "downloading", version: update.version, percent: 0 } });
    try {
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") {
          total = e.data.contentLength ?? 0;
        } else if (e.event === "Progress") {
          got += e.data.chunkLength;
          const percent = total > 0 ? Math.min(100, Math.round((got / total) * 100)) : 0;
          set({ phase: { kind: "downloading", version: update.version, percent } });
        }
      });
      set({ phase: { kind: "restarting" } });
      await relaunch();
    } catch {
      set({ phase: { kind: "error" } });
    }
  },

  dismiss: () => set({ dismissed: true }),
}));

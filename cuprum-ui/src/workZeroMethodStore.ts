import { create } from "zustand";
import type { WorkZeroBinding } from "@/lib/workZeroMethods";

/** Session-scoped metadata of the last successful work-zero registration:
 *  which method bound it and (methods 2–3) the fit quality. NOT persisted into
 *  the project — the physical bind lives in the machine (G54) and dies with the
 *  session, so this mirror must too. The machine-side "is a zero bound" fact is
 *  owned by useDrillGates; this store only annotates it. */
interface WorkZeroMethodStore {
  workZero: WorkZeroBinding | null;
  setWorkZero: (b: WorkZeroBinding) => void;
  clearWorkZero: () => void;
}

export const useWorkZeroMethod = create<WorkZeroMethodStore>((set) => ({
  workZero: null,
  setWorkZero: (b) => set({ workZero: b }),
  clearWorkZero: () => set({ workZero: null }),
}));

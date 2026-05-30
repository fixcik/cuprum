import { create } from "zustand";
import { persist } from "zustand/middleware";
import { type CapabilityProfile, DEFAULT_PROFILE } from "@/lib/capabilityProfile";

interface SettingsStore {
  /** The machine capability profile used for DFM feasibility checks. */
  profile: CapabilityProfile;
  /** Patch one or more profile fields. */
  setProfile: (patch: Partial<CapabilityProfile>) => void;
  /** Reset every field back to the Saturn 4 Ultra 16K defaults. */
  resetProfile: () => void;
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      profile: DEFAULT_PROFILE,
      setProfile: (patch) => set((s) => ({ profile: { ...s.profile, ...patch } })),
      resetProfile: () => set({ profile: DEFAULT_PROFILE }),
    }),
    {
      name: "cuprum-settings",
      version: 1,
      // Merge persisted values onto current defaults so new profile fields added
      // in later versions get their default instead of being undefined.
      merge: (persisted, current) => {
        const p = persisted as Partial<SettingsStore> | undefined;
        return {
          ...current,
          ...(p ?? {}),
          profile: { ...DEFAULT_PROFILE, ...(p?.profile ?? {}) },
        };
      },
    },
  ),
);

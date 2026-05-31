import { create } from "zustand";
import { persist } from "zustand/middleware";
import { type CapabilityProfile, DEFAULT_PROFILE } from "@/lib/capabilityProfile";
import { type PanelPreset } from "@/lib/panel";

export type Language = "auto" | "en" | "ru";
export type Units = "mm" | "imperial";

interface SettingsStore {
  /** The machine capability profile used for DFM feasibility checks. */
  profile: CapabilityProfile;
  /** UI language; "auto" follows the system locale. */
  language: Language;
  /** Display/input units; the model itself is always millimetres. */
  units: Units;
  /** Patch one or more profile fields. */
  setProfile: (patch: Partial<CapabilityProfile>) => void;
  /** Reset every field back to the Saturn 4 Ultra 16K defaults. */
  resetProfile: () => void;
  setLanguage: (language: Language) => void;
  setUnits: (units: Units) => void;
  /** User-saved panel-blank presets (size + stackup), reusable across projects. */
  panelPresets: PanelPreset[];
  addPanelPreset: (preset: PanelPreset) => void;
  removePanelPreset: (id: string) => void;
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      profile: DEFAULT_PROFILE,
      language: "auto",
      units: "mm",
      setProfile: (patch) => set((s) => ({ profile: { ...s.profile, ...patch } })),
      resetProfile: () => set({ profile: DEFAULT_PROFILE }),
      setLanguage: (language) => set({ language }),
      setUnits: (units) => set({ units }),
      panelPresets: [],
      addPanelPreset: (preset) =>
        set((s) => ({
          panelPresets: s.panelPresets.some((p) => p.id === preset.id)
            ? s.panelPresets.map((p) => (p.id === preset.id ? preset : p))
            : [...s.panelPresets, preset],
        })),
      removePanelPreset: (id) => set((s) => ({ panelPresets: s.panelPresets.filter((p) => p.id !== id) })),
    }),
    {
      name: "cuprum-settings",
      version: 3,
      // Merge persisted values onto current defaults so fields added in later
      // versions (language, units, new profile fields) get their default.
      merge: (persisted, current) => {
        const p = persisted as Partial<SettingsStore> | undefined;
        return {
          ...current,
          ...(p ?? {}),
          profile: { ...DEFAULT_PROFILE, ...(p?.profile ?? {}) },
          language: p?.language ?? "auto",
          units: p?.units ?? "mm",
          panelPresets: p?.panelPresets ?? [],
        };
      },
    },
  ),
);

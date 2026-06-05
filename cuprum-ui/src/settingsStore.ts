import { create } from "zustand";
import { persist } from "zustand/middleware";
import { type CapabilityProfile, DEFAULT_PROFILE } from "@/lib/capabilityProfile";
import { type PanelPreset } from "@/lib/panel";
import { type NestSettings, DEFAULT_NEST } from "@/lib/nest";
import { type CncProfile } from "@/lib/cncProfile";
import { type Tool, DEFAULT_TOOLS, newDrillTool } from "@/lib/toolLibrary";
import { type DatumCorner } from "@/lib/datum";
import {
  type Machine,
  type CncMachine,
  type UvLcdMachine,
  DEFAULT_CNC_MACHINE,
  DEFAULT_UV_MACHINE,
  nextMachineId,
} from "@/lib/machine";
import { SCREEN_W_MM, SCREEN_H_MM } from "@/lib/api";

/** Seed the tool library from a persisted state: existing tools win; else migrate
 *  the legacy `profile.drillBitSetMm` into Drill tools; else defaults. Exported for tests. */
export function toolsFromPersisted(p: {
  tools?: Tool[];
  profile?: { drillBitSetMm?: number[] };
}): Tool[] {
  if (p.tools) return p.tools;
  const legacyBits = p.profile?.drillBitSetMm;
  if (legacyBits && legacyBits.length) {
    return legacyBits.map((d, i) => ({
      id: `tool-${i + 1}`,
      name: `Сверло ${d}`,
      kind: "drill" as const,
      diameterMm: d,
      material: "carbide" as const,
      recommendedRpm: 9000,
      recommendedFeedMmMin: 100,
      recommendedPlungeMmMin: 60,
    }));
  }
  return DEFAULT_TOOLS;
}

/** The minimal legacy-persisted shape we need to read during migration. */
type PersistedLegacy = {
  machines?: Machine[];
  activeCncMachineId?: string | null;
  activeUvMachineId?: string | null;
  cncProfile?: Partial<CncProfile>;
  profile?: { drillBitSetMm?: number[] };
  tools?: Tool[];
};

/** Migration result returned by machinesFromPersisted. */
export interface MachinesResult {
  machines: Machine[];
  activeCncMachineId: string | null;
  activeUvMachineId: string | null;
}

/** Seed the machines list from a persisted state.
 *  - Already-migrated state (has `machines[]`) is returned as-is.
 *  - Legacy state (has `cncProfile`) migrates it to a cnc Machine.
 *  - A default uvlcd Machine is always present if no uvlcd machine exists.
 *  Exported for tests. */
export function machinesFromPersisted(p: PersistedLegacy): MachinesResult {
  // Already migrated — return as-is (preserve identity for equality checks in tests)
  if (p.machines && p.machines.length > 0) {
    return {
      machines: p.machines,
      activeCncMachineId: p.activeCncMachineId ?? null,
      activeUvMachineId: p.activeUvMachineId ?? null,
    };
  }

  const machines: Machine[] = [];

  // Migrate legacy cncProfile → CncMachine
  let cncMachine: CncMachine;
  if (p.cncProfile) {
    const legacy = p.cncProfile;
    cncMachine = {
      ...DEFAULT_CNC_MACHINE,
      id: "machine-1",
      kind: "cnc",
      name: legacy.name ?? DEFAULT_CNC_MACHINE.name,
      port: legacy.port !== undefined ? legacy.port : DEFAULT_CNC_MACHINE.port,
      baud: legacy.baud ?? DEFAULT_CNC_MACHINE.baud,
      jogFeedMmMin: legacy.jogFeedMmMin ?? DEFAULT_CNC_MACHINE.jogFeedMmMin,
      jogStepsMm: legacy.jogStepsMm ?? DEFAULT_CNC_MACHINE.jogStepsMm,
      workEnvelopeMm: legacy.workEnvelopeMm ?? DEFAULT_CNC_MACHINE.workEnvelopeMm,
      spindleMaxRpm: legacy.spindleMaxRpm ?? DEFAULT_CNC_MACHINE.spindleMaxRpm,
      spindleControllable:
        legacy.spindleControllable !== undefined
          ? legacy.spindleControllable
          : DEFAULT_CNC_MACHINE.spindleControllable,
      spindleHasPwm:
        legacy.spindleHasPwm !== undefined
          ? legacy.spindleHasPwm
          : DEFAULT_CNC_MACHINE.spindleHasPwm,
      gcodeDialect: legacy.gcodeDialect ?? DEFAULT_CNC_MACHINE.gcodeDialect,
      safeZMm: legacy.safeZMm ?? DEFAULT_CNC_MACHINE.safeZMm,
      runoutMm: legacy.runoutMm ?? DEFAULT_CNC_MACHINE.runoutMm,
      backlashMm: legacy.backlashMm ?? DEFAULT_CNC_MACHINE.backlashMm,
      prependGcode: legacy.prependGcode ?? DEFAULT_CNC_MACHINE.prependGcode,
      appendGcode: legacy.appendGcode ?? DEFAULT_CNC_MACHINE.appendGcode,
      workZeroMm:
        legacy.workZeroMm !== undefined
          ? legacy.workZeroMm
          : DEFAULT_CNC_MACHINE.workZeroMm,
    };
  } else {
    cncMachine = { ...DEFAULT_CNC_MACHINE, id: "machine-1" };
  }
  machines.push(cncMachine);

  // Default uvlcd machine — screen dimensions from api.ts constants
  const uvMachine: UvLcdMachine = {
    id: nextMachineId(machines),
    kind: "uvlcd",
    name: DEFAULT_UV_MACHINE.name,
    screenWidthMm: SCREEN_W_MM,
    screenHeightMm: SCREEN_H_MM,
  };
  machines.push(uvMachine);

  return {
    machines,
    activeCncMachineId: cncMachine.id,
    activeUvMachineId: uvMachine.id,
  };
}

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
  /** Last-used auto-placement (nesting) recipe; defaults for the add-design window. */
  nest: NestSettings;
  /** Patch one or more nesting fields. */
  setNest: (patch: Partial<NestSettings>) => void;
  /** Right panel-inspector UI state (persisted): dock width, collapsed rail, and
   *  which accordion sections are open. */
  panelInspector: {
    width: number;
    collapsed: boolean;
    sizeOpen: boolean;
    stackupOpen: boolean;
    feasibilityOpen: boolean;
  };
  setPanelInspector: (patch: Partial<SettingsStore["panelInspector"]>) => void;

  // ---------------------------------------------------------------------------
  // Machine registry (epic #202 §1 — foundation)
  // ---------------------------------------------------------------------------

  /** All shop machines (CNCs + UV LCD units). One shop, persisted globally. */
  machines: Machine[];
  /** Id of the active CNC machine; null if no CNC machines exist. */
  activeCncMachineId: string | null;
  /** Id of the active UV LCD machine; null if no UV machines exist. */
  activeUvMachineId: string | null;

  addMachine: (machine: Machine) => void;
  updateMachine: (id: string, patch: Partial<Machine>) => void;
  removeMachine: (id: string) => void;
  setActiveCncMachineId: (id: string | null) => void;
  setActiveUvMachineId: (id: string | null) => void;

  // ---------------------------------------------------------------------------
  // Shim: cncProfile — derived snapshot of the active CNC machine's fields.
  //
  // Consumers (drill window, G-code emitter, DFM) continue reading `cncProfile`
  // via useSettings((s) => s.cncProfile) unchanged until they are migrated to
  // read from the active machine directly in epic #202 §3.
  //
  // The field is kept in sync: it is recomputed in every mutator that touches
  // the active machine or activeCncMachineId, and in the persist merge.
  // ---------------------------------------------------------------------------

  /** CNC machine profile — a derived snapshot of the active CNC machine.
   *  Kept in sync automatically; consumers read it unchanged. */
  cncProfile: CncProfile;
  /** Patch the active CNC machine using the legacy CncProfile patch shape. */
  setCncProfile: (patch: Partial<CncProfile>) => void;

  // ---------------------------------------------------------------------------
  // Tool library (global shop tools, will move to per-machine in epic §4)
  // ---------------------------------------------------------------------------

  /** Shop tool library (drills / end-mills / V-bits). Drill diameters feed the DFM bit-snap. */
  tools: Tool[];
  addTool: () => void;
  updateTool: (id: string, patch: Partial<Tool>) => void;
  removeTool: (id: string) => void;
  /** The panel corner used as the machine work-zero (0,0) in the drill window.
   *  Drill-window-owned: read and written by the drill window's store instance. */
  drillDatumCorner: DatumCorner;
  setDrillDatumCorner: (d: DatumCorner) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the active CNC machine or fall back to the first CNC or the default. */
function resolveActiveCnc(machines: Machine[], activeCncMachineId: string | null): CncMachine {
  const active = activeCncMachineId
    ? machines.find((m) => m.id === activeCncMachineId && m.kind === "cnc")
    : undefined;
  if (active && active.kind === "cnc") return active;
  const first = machines.find((m) => m.kind === "cnc");
  if (first && first.kind === "cnc") return first;
  return DEFAULT_CNC_MACHINE;
}

/** Project CncMachine → CncProfile (strip `id` and `kind`). */
function machineToProfile(m: CncMachine): CncProfile {
  const { id: _id, kind: _kind, ...profile } = m;
  return profile;
}

/** Recompute the cncProfile snapshot from the current machines + activeCncMachineId. */
function deriveCncProfile(machines: Machine[], activeCncMachineId: string | null): CncProfile {
  return machineToProfile(resolveActiveCnc(machines, activeCncMachineId));
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
      removePanelPreset: (id) =>
        set((s) => ({ panelPresets: s.panelPresets.filter((p) => p.id !== id) })),
      nest: DEFAULT_NEST,
      setNest: (patch) => set((s) => ({ nest: { ...s.nest, ...patch } })),
      panelInspector: {
        width: 330,
        collapsed: false,
        sizeOpen: true,
        stackupOpen: true,
        feasibilityOpen: true,
      },
      setPanelInspector: (patch) =>
        set((s) => ({ panelInspector: { ...s.panelInspector, ...patch } })),

      // Machine registry defaults
      machines: [DEFAULT_CNC_MACHINE, DEFAULT_UV_MACHINE],
      activeCncMachineId: DEFAULT_CNC_MACHINE.id,
      activeUvMachineId: DEFAULT_UV_MACHINE.id,

      addMachine: (machine) =>
        set((s) => {
          const machines = [...s.machines, machine];
          return { machines, cncProfile: deriveCncProfile(machines, s.activeCncMachineId) };
        }),
      updateMachine: (id, patch) =>
        set((s) => {
          const machines = s.machines.map((m) =>
            m.id === id ? ({ ...m, ...patch } as Machine) : m,
          );
          return { machines, cncProfile: deriveCncProfile(machines, s.activeCncMachineId) };
        }),
      removeMachine: (id) =>
        set((s) => {
          const machines = s.machines.filter((m) => m.id !== id);
          return { machines, cncProfile: deriveCncProfile(machines, s.activeCncMachineId) };
        }),
      setActiveCncMachineId: (id) =>
        set((s) => ({
          activeCncMachineId: id,
          cncProfile: deriveCncProfile(s.machines, id),
        })),
      setActiveUvMachineId: (id) => set({ activeUvMachineId: id }),

      // Shim: cncProfile is initialized from the default CNC machine
      cncProfile: machineToProfile(DEFAULT_CNC_MACHINE),

      setCncProfile: (patch) =>
        set((s) => {
          const active = resolveActiveCnc(s.machines, s.activeCncMachineId);
          const updated: CncMachine = { ...active, ...patch };
          const machines = s.machines.map((m) => (m.id === updated.id ? updated : m));
          return { machines, cncProfile: machineToProfile(updated) };
        }),

      tools: DEFAULT_TOOLS,
      addTool: () => set((s) => ({ tools: [...s.tools, newDrillTool(s.tools)] })),
      updateTool: (id, patch) =>
        set((s) => ({
          tools: s.tools.map((t) => (t.id === id ? { ...t, ...patch } : t)),
        })),
      removeTool: (id) => set((s) => ({ tools: s.tools.filter((t) => t.id !== id) })),
      drillDatumCorner: "bottom-left" as DatumCorner,
      setDrillDatumCorner: (d) => set({ drillDatumCorner: d }),
    }),
    {
      name: "cuprum-settings",
      version: 7,
      migrate: (persisted) => persisted, // merge handles field defaulting across versions
      // Merge persisted values onto current defaults so fields added in later
      // versions get their default values.
      merge: (persisted, current) => {
        const p = persisted as PersistedLegacy & Partial<SettingsStore> | undefined;
        const tools = toolsFromPersisted(
          (p as { tools?: Tool[]; profile?: { drillBitSetMm?: number[] } }) ?? {},
        );
        const { machines, activeCncMachineId, activeUvMachineId } = machinesFromPersisted(p ?? {});
        const cncProfile = deriveCncProfile(machines, activeCncMachineId);
        return {
          ...current,
          ...(p ?? {}),
          profile: { ...DEFAULT_PROFILE, ...(p?.profile ?? {}) },
          language: p?.language ?? "auto",
          units: p?.units ?? "mm",
          panelPresets: p?.panelPresets ?? [],
          nest: { ...DEFAULT_NEST, ...(p?.nest ?? {}) },
          panelInspector: {
            width: 330,
            collapsed: false,
            sizeOpen: true,
            stackupOpen: true,
            feasibilityOpen: true,
            ...(p?.panelInspector ?? {}),
          },
          machines,
          activeCncMachineId,
          activeUvMachineId,
          cncProfile,
          tools,
          drillDatumCorner: p?.drillDatumCorner ?? "bottom-left",
        };
      },
    },
  ),
);

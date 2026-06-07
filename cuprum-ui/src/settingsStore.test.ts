import { describe, it, expect, beforeEach } from "vitest";
import { useSettings, toolsFromPersisted, machinesFromPersisted } from "@/settingsStore";
import { DEFAULT_PROFILE } from "@/lib/capabilityProfile";
import { DEFAULT_NEST } from "@/lib/nest";
import { DEFAULT_TOOLS } from "@/lib/toolLibrary";
import { DEFAULT_CNC_MACHINE, DEFAULT_UV_MACHINE } from "@/lib/machine";
import type { CncMachine, UvLcdMachine } from "@/lib/machine";
import type { PanelPreset } from "@/lib/panel";

// Snapshot the initial state (incl. action fns) and restore it before each test
// so the module-singleton store does not leak between cases.
const initial = useSettings.getState();
beforeEach(() => useSettings.setState(initial, true));

const preset = (id: string, widthMm = 100): PanelPreset => ({
  id,
  name: id,
  widthMm,
  heightMm: 100,
  stackup: { copper_weight_oz: 1, substrate_thickness_mm: 1.6, double_sided: true },
});

describe("settingsStore profile", () => {
  it("patches individual profile fields, leaving the rest at defaults", () => {
    useSettings.getState().setProfile({ minTraceMm: 0.2 });
    const p = useSettings.getState().profile;
    expect(p.minTraceMm).toBe(0.2);
    expect(p.minDrillMm).toBe(DEFAULT_PROFILE.minDrillMm);
  });

  it("resets the profile back to defaults", () => {
    useSettings.getState().setProfile({ minTraceMm: 0.99 });
    useSettings.getState().resetProfile();
    expect(useSettings.getState().profile).toEqual(DEFAULT_PROFILE);
  });
});

describe("settingsStore language & units", () => {
  it("sets language and units", () => {
    useSettings.getState().setLanguage("ru");
    useSettings.getState().setUnits("imperial");
    expect(useSettings.getState().language).toBe("ru");
    expect(useSettings.getState().units).toBe("imperial");
  });
});

describe("settingsStore panel presets", () => {
  it("adds a new preset", () => {
    useSettings.getState().addPanelPreset(preset("a"));
    expect(useSettings.getState().panelPresets.map((p) => p.id)).toEqual(["a"]);
  });

  it("upserts a preset with an existing id in place", () => {
    useSettings.getState().addPanelPreset(preset("a", 100));
    useSettings.getState().addPanelPreset(preset("b", 100));
    useSettings.getState().addPanelPreset(preset("a", 222));
    const presets = useSettings.getState().panelPresets;
    expect(presets.map((p) => p.id)).toEqual(["a", "b"]); // no duplicate, order kept
    expect(presets.find((p) => p.id === "a")!.widthMm).toBe(222); // replaced in place
  });

  it("removes a preset by id", () => {
    useSettings.getState().addPanelPreset(preset("a"));
    useSettings.getState().addPanelPreset(preset("b"));
    useSettings.getState().removePanelPreset("a");
    expect(useSettings.getState().panelPresets.map((p) => p.id)).toEqual(["b"]);
  });
});

describe("settingsStore nest", () => {
  it("patches nesting fields, leaving the rest at defaults", () => {
    useSettings.getState().setNest({ enabled: true, copies: 12 });
    const n = useSettings.getState().nest;
    expect(n.enabled).toBe(true);
    expect(n.copies).toBe(12);
    expect(n.marginMm).toBe(DEFAULT_NEST.marginMm);
  });
});

describe("panelInspector", () => {
  it("patches inspector UI state in place", () => {
    useSettings.getState().setPanelInspector({ width: 400 });
    expect(useSettings.getState().panelInspector.width).toBe(400);
    useSettings.getState().setPanelInspector({ collapsed: true });
    expect(useSettings.getState().panelInspector).toMatchObject({ width: 400, collapsed: true });
  });
});

// ---------------------------------------------------------------------------
// Machine migration tests
// ---------------------------------------------------------------------------

describe("machinesFromPersisted (settings migration)", () => {
  it("migrates legacy cncProfile into a cnc machine and marks it active", () => {
    const legacyCncProfile = {
      name: "My CNC",
      port: "/dev/tty.usbserial",
      baud: 115200,
      jogFeedMmMin: 500,
      jogStepsMm: [0.1, 1, 10],
      workEnvelopeMm: { x: 300, y: 180, z: 45 },
      spindleMaxRpm: 9000,
      spindleControllable: false,
      spindleHasPwm: true,
      gcodeDialect: "grbl_1_1" as const,
      safeZMm: 5,
      runoutMm: 0.15,
      backlashMm: { x: 0.05, y: 0.1, z: 0.05 },
      prependGcode: "",
      appendGcode: "",
      workZeroMm: null,
    };

    const result = machinesFromPersisted({ cncProfile: legacyCncProfile });
    expect(result.machines).toHaveLength(2); // cnc + uvlcd
    const cnc = result.machines.find((m) => m.kind === "cnc");
    expect(cnc).toBeDefined();
    expect(cnc!.name).toBe("My CNC");
    if (cnc!.kind === "cnc") {
      expect(cnc!.port).toBe("/dev/tty.usbserial");
      expect(cnc!.safeZMm).toBe(5);
      // Legacy cncProfile had no machineSafeZMm — it defaults.
      expect(cnc!.machineSafeZMm).toBe(DEFAULT_CNC_MACHINE.machineSafeZMm);
    }
    expect(result.activeCncMachineId).toBe(cnc!.id);
  });

  it("defaults machineSafeZMm on an already-migrated CNC machine that predates the field", () => {
    // A machines[] persisted before machineSafeZMm landed: the cnc machine has
    // no such field, so it must be defaulted on load.
    const legacyCnc = { ...DEFAULT_CNC_MACHINE } as Partial<CncMachine> & CncMachine;
    delete (legacyCnc as { machineSafeZMm?: number }).machineSafeZMm;
    const result = machinesFromPersisted({
      machines: [legacyCnc, DEFAULT_UV_MACHINE],
      activeCncMachineId: "machine-1",
      activeUvMachineId: "machine-2",
    });
    const cnc = result.machines.find((m) => m.kind === "cnc");
    expect(cnc!.kind).toBe("cnc");
    if (cnc!.kind === "cnc") {
      expect(cnc!.machineSafeZMm).toBe(DEFAULT_CNC_MACHINE.machineSafeZMm);
    }
  });

  it("patches toolChangeZMm onto an older persisted CNC machine that predates the field", () => {
    const legacyCnc = { ...DEFAULT_CNC_MACHINE } as Partial<CncMachine> & CncMachine;
    delete (legacyCnc as { toolChangeZMm?: number }).toolChangeZMm;
    const result = machinesFromPersisted({
      machines: [legacyCnc, DEFAULT_UV_MACHINE],
      activeCncMachineId: "machine-1",
      activeUvMachineId: "machine-2",
    });
    const cnc = result.machines.find((m) => m.kind === "cnc");
    expect(cnc!.kind).toBe("cnc");
    if (cnc!.kind === "cnc") {
      expect(cnc!.toolChangeZMm).toBe(DEFAULT_CNC_MACHINE.toolChangeZMm);
    }
  });

  it("migrates UV profile (with screenWidthMm/screenHeightMm) into uvlcd machine", () => {
    const result = machinesFromPersisted({});
    const uv = result.machines.find((m) => m.kind === "uvlcd");
    expect(uv).toBeDefined();
    if (uv!.kind === "uvlcd") {
      expect(uv!.screenWidthMm).toBe(DEFAULT_UV_MACHINE.screenWidthMm);
      expect(uv!.screenHeightMm).toBe(DEFAULT_UV_MACHINE.screenHeightMm);
    }
    expect(result.activeUvMachineId).toBe(uv!.id);
  });

  it("keeps existing machines array as-is when already migrated", () => {
    const existingMachines = [DEFAULT_CNC_MACHINE, DEFAULT_UV_MACHINE];
    const result = machinesFromPersisted({
      machines: existingMachines,
      activeCncMachineId: "machine-1",
      activeUvMachineId: "machine-2",
    });
    expect(result.machines).toBe(existingMachines);
    expect(result.activeCncMachineId).toBe("machine-1");
    expect(result.activeUvMachineId).toBe("machine-2");
  });

  it("loads old persisted state without errors, no values lost from cncProfile", () => {
    const legacy = {
      cncProfile: {
        name: "Workshop CNC",
        port: "/dev/cu.wchusbserial",
        baud: 115200,
        jogFeedMmMin: 750,
        jogStepsMm: [0.1, 0.5, 1],
        workEnvelopeMm: { x: 200, y: 100, z: 30 },
        spindleMaxRpm: 10000,
        spindleControllable: true,
        spindleHasPwm: true,
        gcodeDialect: "grbl_1_1" as const,
        safeZMm: 3,
        runoutMm: 0.1,
        backlashMm: { x: 0.02, y: 0.02, z: 0.02 },
        prependGcode: "G21",
        appendGcode: "M5",
        workZeroMm: { x: 10, y: 20 },
      },
    };

    const result = machinesFromPersisted(legacy);
    const cnc = result.machines.find((m) => m.kind === "cnc");
    expect(cnc).toBeDefined();
    if (cnc!.kind === "cnc") {
      expect(cnc!.name).toBe("Workshop CNC");
      expect(cnc!.port).toBe("/dev/cu.wchusbserial");
      expect(cnc!.jogFeedMmMin).toBe(750);
      expect(cnc!.workZeroMm).toEqual({ x: 10, y: 20 });
      expect(cnc!.prependGcode).toBe("G21");
      expect(cnc!.appendGcode).toBe("M5");
      expect(cnc!.spindleControllable).toBe(true);
      expect(cnc!.safeZMm).toBe(3);
    }
  });

  it("active CNC shim selector returns cncProfile-compatible fields", () => {
    // setCncProfile patches the active CNC machine and keeps cncProfile in sync
    useSettings.getState().setCncProfile({ name: "Shim Test", safeZMm: 7 });
    const cncProfile = useSettings.getState().cncProfile;
    expect(cncProfile.name).toBe("Shim Test");
    expect(cncProfile.safeZMm).toBe(7);
    expect(cncProfile.baud).toBe(DEFAULT_CNC_MACHINE.baud);
    // The machines array is also updated
    const machine = useSettings.getState().machines.find((m) => m.kind === "cnc");
    expect(machine).toBeDefined();
    if (machine?.kind === "cnc") {
      expect(machine.name).toBe("Shim Test");
      expect(machine.safeZMm).toBe(7);
    }
  });
});

// ---------------------------------------------------------------------------
// Machine registry mutators
// ---------------------------------------------------------------------------

const cncMachine = (id: string, name = id): CncMachine => ({
  ...DEFAULT_CNC_MACHINE,
  id,
  name,
});

const uvMachine = (id: string, name = id): UvLcdMachine => ({
  ...DEFAULT_UV_MACHINE,
  id,
  name,
});

describe("settingsStore machine registry mutators", () => {
  it("addMachine appends a machine and keeps cncProfile synced", () => {
    const before = useSettings.getState().machines.length;
    useSettings.getState().addMachine(cncMachine("machine-9", "Extra CNC"));
    const { machines } = useSettings.getState();
    expect(machines).toHaveLength(before + 1);
    expect(machines.at(-1)!.id).toBe("machine-9");
    // Active CNC is still machine-1, so cncProfile reflects the active (default) machine.
    expect(useSettings.getState().cncProfile.name).toBe(DEFAULT_CNC_MACHINE.name);
  });

  it("updateMachine patches a machine in place", () => {
    useSettings.getState().updateMachine("machine-1", { name: "Renamed CNC" });
    const m = useSettings.getState().machines.find((x) => x.id === "machine-1");
    expect(m!.name).toBe("Renamed CNC");
  });

  it("updateMachine on the active CNC keeps cncProfile in sync", () => {
    useSettings.getState().updateMachine("machine-1", { name: "Active Rename" } as Partial<CncMachine>);
    expect(useSettings.getState().cncProfile.name).toBe("Active Rename");
  });

  it("removeMachine drops the machine by id", () => {
    useSettings.getState().addMachine(cncMachine("machine-9"));
    useSettings.getState().removeMachine("machine-9");
    expect(useSettings.getState().machines.some((m) => m.id === "machine-9")).toBe(false);
  });

  it("removeMachine retargets the active CNC to a remaining CNC and recomputes cncProfile", () => {
    // Two CNC machines; machine-1 is active.
    useSettings.setState((s) => ({
      ...s,
      machines: [cncMachine("machine-1", "First CNC"), cncMachine("machine-3", "Second CNC"), uvMachine("machine-2")],
      activeCncMachineId: "machine-1",
      activeUvMachineId: "machine-2",
    }));
    useSettings.getState().removeMachine("machine-1");
    const s = useSettings.getState();
    expect(s.activeCncMachineId).toBe("machine-3");
    expect(s.cncProfile.name).toBe("Second CNC");
  });

  it("removeMachine sets the active CNC id to null when no CNC machines remain", () => {
    useSettings.setState((s) => ({
      ...s,
      machines: [cncMachine("machine-1"), uvMachine("machine-2")],
      activeCncMachineId: "machine-1",
      activeUvMachineId: "machine-2",
    }));
    useSettings.getState().removeMachine("machine-1");
    const s = useSettings.getState();
    expect(s.activeCncMachineId).toBeNull();
    // With no CNC machines, cncProfile falls back to the default machine's fields.
    expect(s.cncProfile.name).toBe(DEFAULT_CNC_MACHINE.name);
    expect(s.cncProfile.safeZMm).toBe(DEFAULT_CNC_MACHINE.safeZMm);
  });

  it("removeMachine retargets the active UV when the active UV machine is removed", () => {
    useSettings.setState((s) => ({
      ...s,
      machines: [cncMachine("machine-1"), uvMachine("machine-2", "First UV"), uvMachine("machine-4", "Second UV")],
      activeCncMachineId: "machine-1",
      activeUvMachineId: "machine-2",
    }));
    useSettings.getState().removeMachine("machine-2");
    expect(useSettings.getState().activeUvMachineId).toBe("machine-4");
  });

  it("removeMachine leaves a non-active machine's active pointers untouched", () => {
    useSettings.setState((s) => ({
      ...s,
      machines: [cncMachine("machine-1"), cncMachine("machine-3"), uvMachine("machine-2")],
      activeCncMachineId: "machine-1",
      activeUvMachineId: "machine-2",
    }));
    useSettings.getState().removeMachine("machine-3");
    const s = useSettings.getState();
    expect(s.activeCncMachineId).toBe("machine-1");
    expect(s.activeUvMachineId).toBe("machine-2");
  });

  it("setActiveCncMachineId switches the active machine and recomputes cncProfile", () => {
    useSettings.setState((s) => ({
      ...s,
      machines: [cncMachine("machine-1", "First CNC"), cncMachine("machine-3", "Second CNC"), uvMachine("machine-2")],
      activeCncMachineId: "machine-1",
    }));
    useSettings.getState().setActiveCncMachineId("machine-3");
    const s = useSettings.getState();
    expect(s.activeCncMachineId).toBe("machine-3");
    expect(s.cncProfile.name).toBe("Second CNC");
  });

  it("setActiveCncMachineId ignores an unknown id (stays consistent)", () => {
    useSettings.getState().setActiveCncMachineId("does-not-exist");
    // Falls back to the first CNC machine rather than a dangling pointer.
    expect(useSettings.getState().activeCncMachineId).toBe("machine-1");
  });

  it("setActiveUvMachineId ignores an id of the wrong kind", () => {
    // machine-1 is a CNC; selecting it as the active UV must not stick.
    useSettings.getState().setActiveUvMachineId("machine-1");
    expect(useSettings.getState().activeUvMachineId).toBe("machine-2");
  });

  it("setCncProfile syncs the active CNC machine inside machines[]", () => {
    useSettings.getState().setCncProfile({ safeZMm: 12, name: "Tuned" });
    const m = useSettings.getState().machines.find((x) => x.id === "machine-1");
    expect(m!.kind).toBe("cnc");
    if (m?.kind === "cnc") {
      expect(m.safeZMm).toBe(12);
      expect(m.name).toBe("Tuned");
    }
    expect(useSettings.getState().cncProfile.safeZMm).toBe(12);
  });

  it("keeps drillDatumCorner independent of the cncProfile shim", () => {
    // drillDatumCorner is a standalone store field (PR #257), not part of the
    // CNC machine/profile — editing the active machine must not disturb it, and
    // setting the datum must not touch cncProfile.
    expect(useSettings.getState().drillDatumCorner).toBe("bottom-left");
    useSettings.getState().setDrillDatumCorner("top-right");
    useSettings.getState().setCncProfile({ safeZMm: 9 });
    expect(useSettings.getState().drillDatumCorner).toBe("top-right");
    expect(useSettings.getState().cncProfile.safeZMm).toBe(9);
  });
});

describe("toolsFromPersisted (settings migration)", () => {
  it("migrates legacy drillBitSetMm into Drill tools", () => {
    const tools = toolsFromPersisted({ profile: { drillBitSetMm: [0.3, 0.8, 1.0] } });
    expect(tools.map((t) => t.diameterMm)).toEqual([0.3, 0.8, 1.0]);
    expect(tools.every((t) => t.kind === "drill")).toBe(true);
    expect(tools.map((t) => t.id)).toEqual(["tool-1", "tool-2", "tool-3"]);
  });
  it("keeps existing tools as-is", () => {
    const existing = DEFAULT_TOOLS.slice(0, 2);
    expect(toolsFromPersisted({ tools: existing })).toBe(existing);
  });
  it("falls back to defaults when nothing persisted", () => {
    expect(toolsFromPersisted({})).toBe(DEFAULT_TOOLS);
  });
});

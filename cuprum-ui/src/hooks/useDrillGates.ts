import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DatumCorner } from "@/lib/datum";
import type { PanelDrillPlan } from "@/lib/panelDrill";
import { DEFAULT_BREAKTHROUGH_MM } from "@/lib/drillBreakthrough";
import { type XYGateResult, checkXYGate, planWorkExtent } from "@/lib/xyGate";
import { type ZGateResult, checkZGate } from "@/lib/zGate";
import { canSetZero } from "@/lib/machineControls";
import { useMachine } from "@/machineStore";
import { api } from "@/lib/api";

/** Machine-frame travel envelope (mm) used by the XY/Z gates. */
export interface GateEnvelope {
  x: number;
  y: number;
  z: number;
}

export interface DrillGates {
  /** MPos X/Y captured at bind (= the work-coordinate offset), or null = not bound. */
  workZeroMachineXY: { x: number; y: number } | null;
  /** True once the XY work zero has been bound. */
  workZeroSet: boolean;
  /** Error string from the last failed bind attempt (null when clear). */
  zeroError: string | null;
  /** Bind the XY work zero at the current machine position. Resolves true on success
   *  (so the caller can leave the zero mode). */
  handleBindZero: () => Promise<boolean>;
  /** Forget the bound work zero. */
  handleClearZero: () => void;
  /** Record a zero already programmed on the controller by a registration solve
   *  (fiducial_solve sets G54 itself); `workOrigin` is its machine XY. */
  registerSolvedZero: (workOrigin: { x: number; y: number }) => void;
  /** XY gate: does the run's hole bbox fit the machine envelope at the bound zero? */
  xyGate: XYGateResult;
  /** Z gate: do depth / tool-change retract / their span fit the Z travel? */
  zGate: ZGateResult;
}

/** Work-zero binding + XY/Z preflight gates for the drill operation editor.
 *
 *  Owns the bound XY work zero (MPos captured at bind), the bind/clear actions and
 *  their error state, and the homing/disconnect invalidation. Derives the XY and Z
 *  gate verdicts from the run's selected sub-plan and the CNC envelope by delegating
 *  to the pure lib checks (`planWorkExtent` / `checkXYGate` / `checkZGate`). The
 *  presentation (banners, the start button's enabled state) reads the verdicts.
 *
 *  Without a CNC profile the travel is unknown — the gates skip (default valid)
 *  rather than gating against a degenerate 0-travel envelope; the inspector that
 *  surfaces the gates only renders once a profile is present anyway. */
export function useDrillGates(args: {
  /** Selected sub-plan (with bit overrides) whose holes will actually run. */
  subPlan: PanelDrillPlan | null;
  /** Panel dimensions (mm); null until the snapshot is ready. */
  panel: { width_mm: number; height_mm: number } | null;
  /** Machine travel envelope (mm); null skips the gates. */
  envelopeMm: GateEnvelope | null;
  /** Z heights for the depth/tool-change gate. */
  safeZMm: number;
  toolChangeZMm: number;
  /** Substrate thickness (mm) → drilled depth = thickness + breakthrough. */
  substrateThicknessMm: number;
  /** Active datum corner (= work zero corner). */
  datum: DatumCorner;
}): DrillGates {
  const { subPlan, panel, envelopeMm, safeZMm, toolChangeZMm, substrateThicknessMm, datum } = args;

  // MPos X/Y captured at bind — the work-coordinate offset, used by the XY gate to
  // check the hole bbox against the machine envelope (null = not bound).
  const [workZeroMachineXY, setWorkZeroMachineXY] = useState<{ x: number; y: number } | null>(null);
  const [zeroError, setZeroError] = useState<string | null>(null);
  const bindingRef = useRef(false);

  const machineState = useMachine((s) => s.status.state);
  const machineHomed = useMachine((s) => s.homed);

  // Homing/disconnect voids the work zero — force re-bind.
  useEffect(() => {
    if (!machineHomed || machineState === "home") {
      setWorkZeroMachineXY(null);
    }
  }, [machineHomed, machineState]);

  // Returns true when the zero was bound (so the caller can leave the zero mode).
  const handleBindZero = useCallback(async (): Promise<boolean> => {
    const { status, connected } = useMachine.getState();
    // Idle only — binding the XY zero mid-jog would capture a stale MPos.
    if (!canSetZero(status.state, connected) || bindingRef.current) return false;
    bindingRef.current = true;
    try {
      await api.machine.setZero(true, true, false);
      setZeroError(null);
      const mpos = useMachine.getState().status.mpos;
      setWorkZeroMachineXY({ x: mpos[0], y: mpos[1] });
      return true;
    } catch (e) {
      setWorkZeroMachineXY(null);
      setZeroError(String(e));
      return false;
    } finally {
      bindingRef.current = false;
    }
  }, []);

  const handleClearZero = useCallback(() => {
    setWorkZeroMachineXY(null);
  }, []);

  // A registration solve programs G54 on the controller itself (G10 L2 inside
  // fiducial_solve) — mirror that fact here so the gates and the status card see
  // the zero as bound, with the solved origin feeding the XY gate.
  const registerSolvedZero = useCallback((workOrigin: { x: number; y: number }) => {
    setZeroError(null);
    setWorkZeroMachineXY({ x: workOrigin.x, y: workOrigin.y });
  }, []);

  // Machine-frame bbox of the holes that will actually run (selected sub-plan),
  // for the XY gate. Recomputes on selection/datum/panel change.
  const workExtent = useMemo(() => {
    if (!subPlan || !panel) return null;
    return planWorkExtent(subPlan, datum, panel.width_mm, panel.height_mm);
  }, [subPlan, panel, datum]);

  // XY gate: at the bound work zero, does the whole hole bbox fit inside the
  // machine travel? Blocks the run (and shows a banner) when it would overrun.
  const xyGate: XYGateResult = envelopeMm
    ? checkXYGate(workZeroMachineXY, workExtent, envelopeMm.x, envelopeMm.y)
    : { valid: true };

  // Z feasibility: depth / tool-change retract / their span must fit the Z travel.
  // (Z work-zero is bound per tool during the run, so this gates on travel size,
  // not on a known zero.)
  const zGate: ZGateResult = envelopeMm
    ? checkZGate({
        safeZMm,
        toolChangeZMm,
        depthMm: substrateThicknessMm + DEFAULT_BREAKTHROUGH_MM,
        envZMm: envelopeMm.z,
      })
    : { valid: true };

  return {
    workZeroMachineXY,
    workZeroSet: workZeroMachineXY !== null,
    zeroError,
    handleBindZero,
    handleClearZero,
    registerSolvedZero,
    xyGate,
    zGate,
  };
}

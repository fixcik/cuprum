// Static catalog + pure logic for the GRBL firmware-settings editor. Values are
// the controller's raw firmware values in their NATIVE units (mm, mm/min,
// steps/mm, RPM, µs) — no imperial conversion here: this edits the raw $N values.

export type SettingType = "bool" | "int" | "float" | "mask";
export type SettingGroup = "general" | "limits" | "spindle" | "axis";

/** One bit of a mask setting: bit index → i18n suffix under grbl:maskBit.* */
export interface MaskBit {
  bit: number;
  labelKey: string;
}

export interface GrblSettingDef {
  n: number;
  /** i18n key suffix → grbl:setting.<key>.{label,desc} */
  key: string;
  group: SettingGroup;
  type: SettingType;
  /** i18n key suffix under grbl:unit.* (numeric settings only). */
  unit?: string;
  /** Stepper increment for numeric inputs (raw native unit). */
  step?: string;
  /** Mask bit definitions (mask settings only). */
  bits?: MaskBit[];
  /** Critical settings (geometry/motion safety) require confirm-on-apply. */
  critical?: boolean;
}

const XYZ_BITS: MaskBit[] = [
  { bit: 0, labelKey: "x" },
  { bit: 1, labelKey: "y" },
  { bit: 2, labelKey: "z" },
];

const REPORT_BITS: MaskBit[] = [
  { bit: 0, labelKey: "mpos" },
  { bit: 1, labelKey: "bufferState" },
];

export const GRBL_SETTINGS: GrblSettingDef[] = [
  // General
  { n: 0, key: "stepPulse", group: "general", type: "int", unit: "us", step: "1" },
  { n: 1, key: "stepIdleDelay", group: "general", type: "int", unit: "ms", step: "1" },
  { n: 2, key: "stepInvertMask", group: "general", type: "mask", bits: XYZ_BITS },
  { n: 3, key: "dirInvertMask", group: "general", type: "mask", bits: XYZ_BITS, critical: true },
  { n: 4, key: "stepEnableInvert", group: "general", type: "bool" },
  { n: 5, key: "limitPinsInvert", group: "general", type: "bool" },
  { n: 6, key: "probePinInvert", group: "general", type: "bool" },
  { n: 10, key: "statusReportMask", group: "general", type: "mask", bits: REPORT_BITS },
  { n: 11, key: "junctionDeviation", group: "general", type: "float", unit: "mm", step: "0.001" },
  { n: 12, key: "arcTolerance", group: "general", type: "float", unit: "mm", step: "0.001" },
  { n: 13, key: "reportInches", group: "general", type: "bool" },
  // grblHAL stepper/comms extras ($37, $39). Absent on stock GRBL 1.1.
  { n: 37, key: "stepperDeenergize", group: "general", type: "mask", bits: XYZ_BITS },
  { n: 39, key: "realtimeChars", group: "general", type: "bool" },
  // Limits & homing
  { n: 20, key: "softLimits", group: "limits", type: "bool" },
  { n: 21, key: "hardLimits", group: "limits", type: "bool", critical: true },
  { n: 22, key: "homingCycle", group: "limits", type: "bool", critical: true },
  { n: 23, key: "homingDirInvert", group: "limits", type: "mask", bits: XYZ_BITS, critical: true },
  { n: 24, key: "homingFeed", group: "limits", type: "float", unit: "mmPerMin", step: "1" },
  { n: 25, key: "homingSeek", group: "limits", type: "float", unit: "mmPerMin", step: "10" },
  { n: 26, key: "homingDebounce", group: "limits", type: "int", unit: "ms", step: "1" },
  { n: 27, key: "homingPulloff", group: "limits", type: "float", unit: "mm", step: "0.1" },
  // Spindle & laser
  { n: 30, key: "spindleMax", group: "spindle", type: "float", unit: "rpm", step: "100" },
  { n: 31, key: "spindleMin", group: "spindle", type: "float", unit: "rpm", step: "10" },
  { n: 32, key: "laserMode", group: "spindle", type: "bool" },
  // grblHAL spindle PWM control ($33–$36). Present on 32-bit/grblHAL builds; on
  // stock GRBL 1.1 they're absent and simply won't appear.
  { n: 33, key: "spindlePwmFreq", group: "spindle", type: "float", unit: "hz", step: "100" },
  { n: 34, key: "spindleOffPwm", group: "spindle", type: "float", unit: "percent", step: "1" },
  { n: 35, key: "spindleMinPwm", group: "spindle", type: "float", unit: "percent", step: "1" },
  { n: 36, key: "spindleMaxPwm", group: "spindle", type: "float", unit: "percent", step: "1" },
  // grblHAL spindle encoder ($38). For spindle-synchronized motion (threading).
  { n: 38, key: "spindleEncoderPpr", group: "spindle", type: "int", unit: "ppr", step: "1" },
  // Axes
  { n: 100, key: "xSteps", group: "axis", type: "float", unit: "stepsPerMm", step: "1", critical: true },
  { n: 101, key: "ySteps", group: "axis", type: "float", unit: "stepsPerMm", step: "1", critical: true },
  { n: 102, key: "zSteps", group: "axis", type: "float", unit: "stepsPerMm", step: "1", critical: true },
  { n: 110, key: "xMaxRate", group: "axis", type: "float", unit: "mmPerMin", step: "10" },
  { n: 111, key: "yMaxRate", group: "axis", type: "float", unit: "mmPerMin", step: "10" },
  { n: 112, key: "zMaxRate", group: "axis", type: "float", unit: "mmPerMin", step: "10" },
  { n: 120, key: "xAccel", group: "axis", type: "float", unit: "mmPerSec2", step: "1" },
  { n: 121, key: "yAccel", group: "axis", type: "float", unit: "mmPerSec2", step: "1" },
  { n: 122, key: "zAccel", group: "axis", type: "float", unit: "mmPerSec2", step: "1" },
  { n: 130, key: "xMaxTravel", group: "axis", type: "float", unit: "mm", step: "1", critical: true },
  { n: 131, key: "yMaxTravel", group: "axis", type: "float", unit: "mm", step: "1", critical: true },
  { n: 132, key: "zMaxTravel", group: "axis", type: "float", unit: "mm", step: "1", critical: true },
];

export const GROUP_ORDER: SettingGroup[] = ["general", "limits", "spindle", "axis"];

const BY_N = new Map(GRBL_SETTINGS.map((d) => [d.n, d]));
export function defFor(n: number): GrblSettingDef | undefined {
  return BY_N.get(n);
}

/** Decode a mask integer into a per-bit boolean array, ordered by `bits`. */
export function decodeMask(value: number, bits: MaskBit[]): boolean[] {
  return bits.map((b) => (value & (1 << b.bit)) !== 0);
}

/** Encode per-bit booleans (ordered by `bits`) back into a mask integer. */
export function encodeMask(flags: boolean[], bits: MaskBit[]): number {
  return bits.reduce((acc, b, i) => (flags[i] ? acc | (1 << b.bit) : acc), 0);
}

/** Normalise a raw value for change detection: numeric strings compare by value
 *  (so `1` ≡ `1.000`), everything else by trimmed text. */
export function normalizeValue(raw: string): string {
  const num = Number.parseFloat(raw);
  return Number.isNaN(num) ? raw.trim() : String(num);
}

/** Validate a raw value against a setting's type. */
export function validate(def: GrblSettingDef, raw: string): { ok: true } | { ok: false; reason: string } {
  const t = raw.trim();
  if (def.type === "bool") {
    return t === "0" || t === "1" ? { ok: true } : { ok: false, reason: "bool" };
  }
  const num = Number(t);
  if (t === "" || Number.isNaN(num)) return { ok: false, reason: "nan" };
  if (num < 0) return { ok: false, reason: "negative" };
  if ((def.type === "int" || def.type === "mask") && !Number.isInteger(num)) {
    return { ok: false, reason: "int" };
  }
  return { ok: true };
}

/** The `n` of every setting whose draft value differs from baseline. */
export function diffDrafts(
  baseline: Record<number, string>,
  draft: Record<number, string>,
): number[] {
  const changed: number[] = [];
  for (const [k, v] of Object.entries(draft)) {
    const n = Number(k);
    const base = baseline[n];
    if (base === undefined || normalizeValue(v) !== normalizeValue(base)) changed.push(n);
  }
  return changed.sort((a, b) => a - b);
}

/** Critical settings among a set of changed `n`s (for the confirm dialog). */
export function criticalAmong(changedNs: number[]): GrblSettingDef[] {
  return changedNs.map((n) => BY_N.get(n)).filter((d): d is GrblSettingDef => !!d?.critical);
}

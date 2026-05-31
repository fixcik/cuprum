import { useTranslation } from "react-i18next";
import { useSettings } from "@/settingsStore";

const MM_PER_INCH = 25.4;
const MIL_PER_MM = 1000 / MM_PER_INCH; // single source of truth (exact)

/** Imperial dimension class: fine features show in mils, coarse ones in inches. */
export type Dim = "fine" | "coarse";

/** Trim a number without trailing zeros, keeping precision for small values. */
function trim(v: number, decimals: number): string {
  return `${+v.toFixed(decimals)}`;
}

/** Length formatting + input conversion that respect the active units setting.
 *  The model is always millimetres; this only affects display and Settings input. */
export function useUnitFormat() {
  const units = useSettings((s) => s.units);
  const { t } = useTranslation("common");

  type LenUnit = "um" | "mm" | "mil" | "inch";

  /** Which unit a single length renders in, per the active units setting. */
  const lenUnit = (mm: number): LenUnit => {
    const a = Math.abs(mm);
    if (units === "imperial") return a >= MM_PER_INCH ? "inch" : "mil";
    return a > 0 && a < 0.1 ? "um" : "mm";
  };

  /** Format a length (mm) in a SPECIFIC unit. */
  const fmtIn = (mm: number, u: LenUnit): string => {
    switch (u) {
      case "inch": return `${trim(mm / MM_PER_INCH, 3)} ${t("unit.inch")}`;
      case "mil": return `${trim(mm * MIL_PER_MM, 1)} ${t("unit.mil")}`;
      case "um": return `${Math.round(mm * 1000)} ${t("unit.um")}`;
      case "mm": return `${trim(mm, 2)} ${t("unit.mm")}`;
    }
  };

  /** Format a length (given in mm) with a localized unit suffix. */
  const fmtLen = (mm: number): string => fmtIn(mm, lenUnit(mm));

  /** Format several related lengths (e.g. a value and its limit) in ONE shared
   *  unit — the finest any of them needs — so "70 µm · ≥ 0.15 mm" can't happen. */
  const fmtLenPair = (values: number[]): string[] => {
    const order: LenUnit[] = units === "imperial" ? ["mil", "inch"] : ["um", "mm"];
    let u: LenUnit = order[order.length - 1];
    for (const v of values) {
      const vu = lenUnit(v);
      if (order.indexOf(vu) < order.indexOf(u)) u = vu;
    }
    return values.map((v) => fmtIn(v, u));
  };

  /** mm → value shown in an input for the given dimension class. */
  const toDisplay = (mm: number, dim: Dim): number => {
    if (units !== "imperial") return mm;
    return dim === "coarse" ? mm / MM_PER_INCH : mm * MIL_PER_MM;
  };

  /** Input value (in the active unit) → mm to store. */
  const fromDisplay = (v: number, dim: Dim): number => {
    if (units !== "imperial") return v;
    return dim === "coarse" ? v * MM_PER_INCH : v / MIL_PER_MM;
  };

  /** Unit suffix for an input field of the given dimension class. */
  const unitLabel = (dim: Dim): string => {
    if (units !== "imperial") return t("unit.mm");
    return dim === "coarse" ? t("unit.inch") : t("unit.mil");
  };

  return { units, fmtLen, fmtLenPair, toDisplay, fromDisplay, unitLabel };
}

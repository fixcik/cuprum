import { useTranslation } from "react-i18next";
import { useSettings } from "@/settingsStore";

const MM_PER_INCH = 25.4;
const MIL_PER_MM = 39.3701;

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

  /** Format a length (given in mm) with a localized unit suffix. */
  const fmtLen = (mm: number): string => {
    const a = Math.abs(mm);
    if (units === "imperial") {
      if (a >= MM_PER_INCH) return `${trim(mm / MM_PER_INCH, 3)} ${t("unit.inch")}`;
      return `${trim(mm * MIL_PER_MM, 1)} ${t("unit.mil")}`;
    }
    if (a > 0 && a < 0.1) return `${Math.round(mm * 1000)} ${t("unit.um")}`;
    return `${trim(mm, 2)} ${t("unit.mm")}`;
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

  return { units, fmtLen, toDisplay, fromDisplay, unitLabel };
}

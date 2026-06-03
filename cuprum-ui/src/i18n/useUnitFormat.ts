import { useTranslation } from "react-i18next";
import { useSettings } from "@/settingsStore";
import {
  type Dim,
  type LenUnit,
  fmtLen as fmtLenCore,
  fmtLenPair as fmtLenPairCore,
  toDisplay as toDisplayCore,
  fromDisplay as fromDisplayCore,
  unitLabel as unitLabelCore,
} from "@/i18n/unitFormat";

// Re-exported so existing consumers keep importing `Dim` from this module.
export type { Dim } from "@/i18n/unitFormat";

/** Length formatting + input conversion that respect the active units setting.
 *  The model is always millimetres; this only affects display and Settings input.
 *  Pure logic lives in `unitFormat.ts`; this binds it to the store + i18n. */
export function useUnitFormat() {
  const units = useSettings((s) => s.units);
  const { t } = useTranslation("common");

  // Literal keys (not a computed `unit.${u}`) so the typed-i18n `t` stays happy.
  const label = (u: LenUnit): string =>
    u === "inch" ? t("unit.inch") : u === "mil" ? t("unit.mil") : u === "um" ? t("unit.um") : t("unit.mm");

  return {
    units,
    fmtLen: (mm: number) => fmtLenCore(mm, units, label),
    fmtLenPair: (values: number[]) => fmtLenPairCore(values, units, label),
    toDisplay: (mm: number, dim: Dim) => toDisplayCore(mm, dim, units),
    fromDisplay: (v: number, dim: Dim) => fromDisplayCore(v, dim, units),
    unitLabel: (dim: Dim) => unitLabelCore(dim, units, label),
  };
}

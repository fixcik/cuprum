/** Pure unit-conversion + length-formatting core behind useUnitFormat. The model
 *  is always millimetres; this only affects display and Settings input. No React,
 *  no store, no i18n — the caller supplies the active units and a label resolver. */

export const MM_PER_INCH = 25.4;
export const MIL_PER_MM = 1000 / MM_PER_INCH; // single source of truth (exact)

export type Units = "mm" | "imperial";

/** Imperial dimension class: fine features show in mils, coarse ones in inches. */
export type Dim = "fine" | "coarse";

export type LenUnit = "um" | "mm" | "mil" | "inch";

/** Localized suffix for a unit (e.g. ("mm") => "мм"). */
export type UnitLabel = (u: LenUnit) => string;

/** Trim a number without trailing zeros, keeping precision for small values. */
function trim(v: number, decimals: number): string {
  return `${+v.toFixed(decimals)}`;
}

/** Which unit a single length renders in, per the active units setting. */
export function lenUnit(mm: number, units: Units): LenUnit {
  const a = Math.abs(mm);
  if (units === "imperial") return a >= MM_PER_INCH ? "inch" : "mil";
  return a > 0 && a < 0.1 ? "um" : "mm";
}

/** Format a length (mm) in a SPECIFIC unit. */
export function fmtIn(mm: number, u: LenUnit, label: UnitLabel): string {
  switch (u) {
    case "inch": return `${trim(mm / MM_PER_INCH, 3)} ${label("inch")}`;
    case "mil": return `${trim(mm * MIL_PER_MM, 1)} ${label("mil")}`;
    case "um": return `${Math.round(mm * 1000)} ${label("um")}`;
    case "mm": return `${trim(mm, 2)} ${label("mm")}`;
  }
}

/** Format a length (given in mm) with a localized unit suffix. */
export function fmtLen(mm: number, units: Units, label: UnitLabel): string {
  return fmtIn(mm, lenUnit(mm, units), label);
}

/** Format several related lengths in ONE shared unit — the finest any of them
 *  needs — so "70 µm · ≥ 0.15 mm" can't happen. */
export function fmtLenPair(values: number[], units: Units, label: UnitLabel): string[] {
  const order: LenUnit[] = units === "imperial" ? ["mil", "inch"] : ["um", "mm"];
  let u: LenUnit = order[order.length - 1];
  for (const v of values) {
    const vu = lenUnit(v, units);
    if (order.indexOf(vu) < order.indexOf(u)) u = vu;
  }
  return values.map((v) => fmtIn(v, u, label));
}

/** mm → value shown in an input for the given dimension class. */
export function toDisplay(mm: number, dim: Dim, units: Units): number {
  if (units !== "imperial") return mm;
  return dim === "coarse" ? mm / MM_PER_INCH : mm * MIL_PER_MM;
}

/** Input value (in the active unit) → mm to store. */
export function fromDisplay(v: number, dim: Dim, units: Units): number {
  if (units !== "imperial") return v;
  return dim === "coarse" ? v * MM_PER_INCH : v / MIL_PER_MM;
}

/** Unit suffix for an input field of the given dimension class. */
export function unitLabel(dim: Dim, units: Units, label: UnitLabel): string {
  if (units !== "imperial") return label("mm");
  return dim === "coarse" ? label("inch") : label("mil");
}

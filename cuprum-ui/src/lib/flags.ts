/** Feature flags: hide unfinished features in prod, keep them in dev.
 *  This module is pure (no React, no store) so the resolve logic is unit-testable.
 *  The runtime override + cross-window sync live in settingsStore / main.tsx.
 *
 *  Flag labels are plain strings (NOT i18n): these are transient internal toggles,
 *  not worth the en/ru parity-gate churn. See the design spec. */
export type FlagKey = "uvExposure" | "cncMilling" | "fiducialRegistration";

export interface FlagDef {
  /** Label shown in the experimental panel. Plain string, not localized. */
  label: string;
  /** Optional one-liner under the label. */
  description?: string;
  /** Default in a dev build. Defaults to true. */
  defaultDev?: boolean;
  /** Default in a prod build. Defaults to false. */
  defaultProd?: boolean;
}

export const FLAGS: Record<FlagKey, FlagDef> = {
  uvExposure: { label: "UV-засветка", description: "Засветка медной графики через UV-LCD" },
  cncMilling: { label: "CNC-фрезеровка", description: "Изоляционная фрезеровка меди" },
  fiducialRegistration: { label: "Центровка по реперам", description: "Привязка сверловки к реперным отверстиям (в разработке)", defaultDev: false, defaultProd: false },
};

/** Effective default for the current build mode, ignoring any override. */
export function flagDefault(def: FlagDef, isDev: boolean): boolean {
  return isDev ? (def.defaultDev ?? true) : (def.defaultProd ?? false);
}

/** Resolve a flag: an explicit override wins; undefined falls back to the env default. */
export function resolveFlag(def: FlagDef, override: boolean | undefined, isDev: boolean): boolean {
  return override ?? flagDefault(def, isDev);
}

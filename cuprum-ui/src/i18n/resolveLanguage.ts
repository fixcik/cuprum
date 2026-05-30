import type { Language } from "@/settingsStore";

/** Concrete UI languages we actually load (no "auto"). */
export type ResolvedLanguage = "en" | "ru";

/** Russian system → ru, everything else → en (fallback). Reads navigator.language,
 *  which in a Tauri webview reflects the OS locale on all platforms. */
export function detectSystemLanguage(): ResolvedLanguage {
  const nav = typeof navigator !== "undefined" ? navigator.language : "";
  return nav.toLowerCase().startsWith("ru") ? "ru" : "en";
}

/** Map the stored setting to a concrete language. */
export function resolveLanguage(setting: Language): ResolvedLanguage {
  return setting === "auto" ? detectSystemLanguage() : setting;
}

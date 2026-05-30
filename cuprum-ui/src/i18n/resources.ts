import enCommon from "@/locales/en/common.json";
import ruCommon from "@/locales/ru/common.json";
import enNav from "@/locales/en/nav.json";
import ruNav from "@/locales/ru/nav.json";
import enSettings from "@/locales/en/settings.json";
import ruSettings from "@/locales/ru/settings.json";

// Add new namespaces here as features are migrated.
export const resources = {
  en: { common: enCommon, nav: enNav, settings: enSettings },
  ru: { common: ruCommon, nav: ruNav, settings: ruSettings },
} as const;

export const NAMESPACES = ["common", "nav", "settings"] as const;
export const DEFAULT_NS = "common";

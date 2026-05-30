import enCommon from "@/locales/en/common.json";
import ruCommon from "@/locales/ru/common.json";
import enNav from "@/locales/en/nav.json";
import ruNav from "@/locales/ru/nav.json";

// Add new namespaces here as features are migrated.
export const resources = {
  en: { common: enCommon, nav: enNav },
  ru: { common: ruCommon, nav: ruNav },
} as const;

export const NAMESPACES = ["common", "nav"] as const;
export const DEFAULT_NS = "common";

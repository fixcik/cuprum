import enCommon from "@/locales/en/common.json";
import ruCommon from "@/locales/ru/common.json";
import enNav from "@/locales/en/nav.json";
import ruNav from "@/locales/ru/nav.json";
import enSettings from "@/locales/en/settings.json";
import ruSettings from "@/locales/ru/settings.json";
import enFeasibility from "@/locales/en/feasibility.json";
import ruFeasibility from "@/locales/ru/feasibility.json";
import enMetrics from "@/locales/en/metrics.json";
import ruMetrics from "@/locales/ru/metrics.json";
import enImport from "@/locales/en/import.json";
import ruImport from "@/locales/ru/import.json";

// Add new namespaces here as features are migrated.
export const resources = {
  en: { common: enCommon, nav: enNav, settings: enSettings, feasibility: enFeasibility, metrics: enMetrics, import: enImport },
  ru: { common: ruCommon, nav: ruNav, settings: ruSettings, feasibility: ruFeasibility, metrics: ruMetrics, import: ruImport },
} as const;

export const NAMESPACES = ["common", "nav", "settings", "feasibility", "metrics", "import"] as const;
export const DEFAULT_NS = "common";

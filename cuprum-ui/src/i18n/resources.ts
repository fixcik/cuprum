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
import enHome from "@/locales/en/home.json";
import ruHome from "@/locales/ru/home.json";
import enPrinter from "@/locales/en/printer.json";
import ruPrinter from "@/locales/ru/printer.json";
import enProject from "@/locales/en/project.json";
import ruProject from "@/locales/ru/project.json";
import enLayers from "@/locales/en/layers.json";
import ruLayers from "@/locales/ru/layers.json";
import enUpdater from "@/locales/en/updater.json";
import ruUpdater from "@/locales/ru/updater.json";

// Add new namespaces here as features are migrated.
export const resources = {
  en: { common: enCommon, nav: enNav, settings: enSettings, feasibility: enFeasibility, metrics: enMetrics, import: enImport, home: enHome, printer: enPrinter, project: enProject, layers: enLayers, updater: enUpdater },
  ru: { common: ruCommon, nav: ruNav, settings: ruSettings, feasibility: ruFeasibility, metrics: ruMetrics, import: ruImport, home: ruHome, printer: ruPrinter, project: ruProject, layers: ruLayers, updater: ruUpdater },
} as const;

export const NAMESPACES = ["common", "nav", "settings", "feasibility", "metrics", "import", "home", "printer", "project", "layers", "updater"] as const;
export const DEFAULT_NS = "common";

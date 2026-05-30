import "react-i18next";
import type enCommon from "@/locales/en/common.json";
import type enNav from "@/locales/en/nav.json";
import type enSettings from "@/locales/en/settings.json";
import type enFeasibility from "@/locales/en/feasibility.json";
import type enMetrics from "@/locales/en/metrics.json";
import type enImport from "@/locales/en/import.json";

declare module "react-i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: {
      common: typeof enCommon;
      nav: typeof enNav;
      settings: typeof enSettings;
      feasibility: typeof enFeasibility;
      metrics: typeof enMetrics;
      import: typeof enImport;
    };
  }
}

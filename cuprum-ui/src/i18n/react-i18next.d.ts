import "react-i18next";
import type enCommon from "@/locales/en/common.json";
import type enNav from "@/locales/en/nav.json";
import type enSettings from "@/locales/en/settings.json";
import type enFeasibility from "@/locales/en/feasibility.json";
import type enMetrics from "@/locales/en/metrics.json";
import type enImport from "@/locales/en/import.json";
import type enHome from "@/locales/en/home.json";
import type enProject from "@/locales/en/project.json";
import type enLayers from "@/locales/en/layers.json";
import type enMenu from "@/locales/en/menu.json";
import type enDrill from "@/locales/en/drill.json";
import type enGrbl from "@/locales/en/grbl.json";
import type enMill from "@/locales/en/mill.json";

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
      home: typeof enHome;
      project: typeof enProject;
      layers: typeof enLayers;
      menu: typeof enMenu;
      drill: typeof enDrill;
      grbl: typeof enGrbl;
      mill: typeof enMill;
    };
  }
}

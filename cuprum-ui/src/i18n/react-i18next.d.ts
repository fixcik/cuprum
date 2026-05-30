import "react-i18next";
import type enCommon from "@/locales/en/common.json";
import type enNav from "@/locales/en/nav.json";

declare module "react-i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: {
      common: typeof enCommon;
      nav: typeof enNav;
    };
  }
}

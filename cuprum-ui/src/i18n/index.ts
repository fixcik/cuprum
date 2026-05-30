import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { resources, DEFAULT_NS } from "./resources";
import { resolveLanguage } from "./resolveLanguage";
import { useSettings } from "@/settingsStore";

// Read the persisted language synchronously so the first paint is correct.
const initialLng = resolveLanguage(useSettings.getState().language);

i18n.use(initReactI18next).init({
  resources,
  lng: initialLng,
  fallbackLng: "en",
  defaultNS: DEFAULT_NS,
  interpolation: { escapeValue: false }, // React already escapes
  returnNull: false,
});

export default i18n;

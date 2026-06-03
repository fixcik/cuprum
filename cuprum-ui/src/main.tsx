import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { AddDesignWindow } from "./windows/AddDesignWindow";
import { InspectorWindow } from "./windows/InspectorWindow";
import "./styles.css";
import i18n from "./i18n";
import { resolveLanguage } from "./i18n/resolveLanguage";
import { useSettings } from "./settingsStore";

// Keep i18next's active language in sync with the persisted setting (and the
// system locale when set to "auto"). Switches without a reload.
useSettings.subscribe((state) => {
  const lng = resolveLanguage(state.language);
  if (i18n.language !== lng) i18n.changeLanguage(lng);
});

// Brighten the slim scrollbars while actively scrolling (capture phase —
// `scroll` doesn't bubble), then dim them back shortly after scrolling stops.
let scrollTimer: number | undefined;
window.addEventListener(
  "scroll",
  () => {
    document.documentElement.classList.add("scrolling");
    window.clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(
      () => document.documentElement.classList.remove("scrolling"),
      900,
    );
  },
  true,
);

let label = "main";
try {
  label = getCurrentWindow().label;
} catch {
  // Non-Tauri (plain browser) context — default to the main app.
}

const INSPECTOR_PREFIX = "inspector:";
let windowRoot: React.ReactNode;
if (label === "add-design") {
  windowRoot = <AddDesignWindow />;
} else if (label.startsWith(INSPECTOR_PREFIX)) {
  windowRoot = <InspectorWindow designId={label.slice(INSPECTOR_PREFIX.length)} />;
} else {
  windowRoot = <App />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{windowRoot}</React.StrictMode>,
);

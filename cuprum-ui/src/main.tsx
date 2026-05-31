import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

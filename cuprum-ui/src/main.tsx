import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { AddDesignWindow } from "./windows/AddDesignWindow";
import { ConsoleWindow } from "./windows/ConsoleWindow";
import { InspectorWindow } from "./windows/InspectorWindow";
import { DrillWindow } from "./windows/DrillWindow";
import { ExposeWindow } from "./windows/ExposeWindow";
import { MillWindow } from "./windows/MillWindow";
import "./styles.css";
import i18n from "./i18n";
import { resolveLanguage } from "./i18n/resolveLanguage";
import { useSettings } from "./settingsStore";
import { api, getLastInvokedCommand } from "./lib/api";
import { ErrorBoundary } from "./components/ErrorBoundary";

// Keep i18next's active language in sync with the persisted setting (and the
// system locale when set to "auto"). Switches without a reload. Each OS window
// is a separate webview with its own store + i18next, so a local change must be
// broadcast — sibling windows don't observe this window's store.
useSettings.subscribe((state) => {
  const lng = resolveLanguage(state.language);
  if (i18n.language !== lng) {
    i18n.changeLanguage(lng);
    void api.emitLanguage(state.language);
  }
});

// Apply a language change broadcast by another window. changeLanguage first so
// the subscribe above sees i18next already in sync and does not re-broadcast
// (no echo loop); then mirror the setting into this window's store so it stays
// consistent.
void api.onLanguage((language) => {
  const lng = resolveLanguage(language);
  if (i18n.language !== lng) i18n.changeLanguage(lng);
  if (useSettings.getState().language !== language) {
    useSettings.getState().setLanguage(language);
  }
});

// Cross-window feature-flag sync. Mirror the language pattern: broadcast local
// override changes, and apply incoming ones without re-broadcasting (no echo).
let lastFlags = JSON.stringify(useSettings.getState().flagOverrides);
useSettings.subscribe((state) => {
  const cur = JSON.stringify(state.flagOverrides);
  if (cur !== lastFlags) {
    lastFlags = cur;
    void api.emitFlagOverrides(state.flagOverrides);
  }
});
void api.onFlagOverrides((overrides) => {
  lastFlags = JSON.stringify(overrides); // mark as seen before applying → no echo
  useSettings.getState().setFlagOverrides(overrides);
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

// Global error handlers: capture uncaught JS errors and unhandled promise
// rejections and forward them to the Rust crash store.
window.addEventListener("error", (e) => {
  void api.crash.reportFrontend(
    e.message,
    (e.error as { stack?: string } | undefined)?.stack ?? "",
    getLastInvokedCommand(),
  );
});
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason as { message?: string; stack?: string } | undefined;
  void api.crash.reportFrontend(
    String(reason?.message ?? e.reason),
    reason?.stack ?? "",
    getLastInvokedCommand(),
  );
});

let label = "main";
try {
  label = getCurrentWindow().label;
} catch {
  // Non-Tauri (plain browser) context — default to the main app.
}

// Hyphen, not colon: a ':' in a window label loads a blank page in WebView2 on
// Windows. Must stay in sync with windows.rs and capabilities/default.json.
const INSPECTOR_PREFIX = "inspector-";
let windowRoot: React.ReactNode;
if (label === "add-design") {
  windowRoot = <AddDesignWindow />;
} else if (label === "drill") {
  windowRoot = <DrillWindow />;
} else if (label === "expose") {
  windowRoot = <ExposeWindow />;
} else if (label === "mill") {
  windowRoot = <MillWindow />;
} else if (label === "console") {
  windowRoot = <ConsoleWindow />;
} else if (label.startsWith(INSPECTOR_PREFIX)) {
  windowRoot = <InspectorWindow designId={label.slice(INSPECTOR_PREFIX.length)} />;
} else {
  windowRoot = <App />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>{windowRoot}</ErrorBoundary>
  </React.StrictMode>,
);

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// Reveal overlay scrollbars while actively scrolling (capture phase — `scroll`
// doesn't bubble), then fade them out shortly after scrolling stops.
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

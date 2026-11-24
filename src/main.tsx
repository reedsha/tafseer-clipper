import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { isDesktopRuntime } from "./lib/projectFile";
import "./index.css";

// The title bar is drawn by the renderer in desktop builds. Put the offset on
// <html> (not the app div) so portals — the Vaul prompt drawer, Radix dialogs,
// the command palette — inherit `--titlebar-height` instead of falling back to
// the browser's 0px and sliding underneath the window controls.
if (isDesktopRuntime()) {
  document.documentElement.classList.add("desktop-shell");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

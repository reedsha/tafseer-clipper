import { useEffect, useState } from "react";

import { useSettingsStore } from "@/store/settingsStore";

/**
 * Startup gate for the pre-React splash declared in `index.html`.
 *
 * The splash must stay up while two things settle:
 * 1. the renderer bundle itself (the static HTML node covers that for free),
 * 2. the first sidecar health verdict, so the wizard does not pop in over a
 *    still-"checking" status LED (AGENTS.md §3: the sidecar handshake is part
 *    of boot, not business logic).
 *
 * The node is plain DOM outside `#root`, so this component renders nothing —
 * it only decides when the splash fades and removes the node afterwards.
 * Failsafe: a hard cap so a wedged handshake can never trap the user on the
 * splash; the header LED reports the real offline state after release.
 */
const MIN_DISPLAY_MS = 900;
const HARD_CAP_MS = 12_000;
const FADE_MS = 360;

export function StartupGate() {
  const status = useSettingsStore((state) => state.sidecar.status);
  const settled = status === "online" || status === "offline";
  const [minElapsed, setMinElapsed] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setMinElapsed(true), MIN_DISPLAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const cap = window.setTimeout(() => setMinElapsed(true), HARD_CAP_MS);
    return () => window.clearTimeout(cap);
  }, []);

  useEffect(() => {
    if (!settled || !minElapsed) return;
    const splash = document.getElementById("splash");
    if (!splash) return;
    // Respect users who asked the OS for less motion: no fade, just release.
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    splash.classList.add("splash-out");
    const timer = window.setTimeout(
      () => splash.remove(),
      reduceMotion ? 0 : FADE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [settled, minElapsed]);

  return null;
}

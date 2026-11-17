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
 * A cold sidecar can take several seconds to listen, so the store keeps the
 * status "checking" through a bounded retry window. Only a real verdict —
 * "online" or "offline" — releases the splash in normal operation. Treating an
 * early "offline" as settled used to expose a false "Engine not responding"
 * error that self-healed seconds later.
 *
 * The node is plain DOM outside `#root`, so this component renders nothing —
 * it only decides when the splash fades and removes the node afterwards.
 * Failsafe: a hard cap releases the splash even if the handshake is still
 * wedged in "checking"; the header LED then reports the real state.
 */
const MIN_DISPLAY_MS = 900;
const HARD_CAP_MS = 20_000;
const FADE_MS = 360;

export function StartupGate() {
  const status = useSettingsStore((state) => state.sidecar.status);
  const [minElapsed, setMinElapsed] = useState(false);
  const [hardCapElapsed, setHardCapElapsed] = useState(false);
  const settled = status === "online" || status === "offline" || hardCapElapsed;

  useEffect(() => {
    const timer = window.setTimeout(() => setMinElapsed(true), MIN_DISPLAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const cap = window.setTimeout(() => setHardCapElapsed(true), HARD_CAP_MS);
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

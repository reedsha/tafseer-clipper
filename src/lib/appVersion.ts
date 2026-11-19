import { useEffect, useState } from "react";

import { isTauriRuntime } from "@/lib/media";

/**
 * The installed application's own version (`tauri.conf.json`), read from the
 * desktop shell.
 *
 * `GET /health` reports the version of the sidecar binary that was bundled with
 * the app. When that binary is stale (a build that predates the current release
 * anchors), the engine reports an old number and the header/settings used to
 * mirror it. The shell's version is the real, installed app version, so the
 * user-facing status surfaces prefer it and only fall back to the sidecar's
 * number in a plain browser preview.
 */
let cachedVersion: Promise<string | null> | null = null;

export function getAppVersion(): Promise<string | null> {
  if (!isTauriRuntime()) return Promise.resolve(null);
  if (!cachedVersion) {
    cachedVersion = import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .catch(() => null);
  }
  return cachedVersion;
}

/** React hook around {@link getAppVersion}; `null` until resolved / in a browser. */
export function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void getAppVersion().then((value) => {
      if (alive) setVersion(value);
    });
    return () => {
      alive = false;
    };
  }, []);

  return version;
}

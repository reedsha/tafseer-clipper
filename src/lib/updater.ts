/**
 * Typed auto-updater helpers for the Tauri v2 desktop shell.
 *
 * The updater only exists in the packaged app: `@tauri-apps/plugin-updater`
 * talks to the Rust side, which needs a signed release channel. Every import is
 * therefore dynamic and guarded by {@link isTauriRuntime}, so a plain-browser
 * build (Vite preview, Playwright) never loads the plugin and never crashes.
 *
 * Nothing here installs automatically: `checkForUpdates` only reports, and the
 * caller decides when to call {@link downloadAndInstall}. A module-level status
 * snapshot lets Settings render the latest check and lets the diagnostics
 * bundle include it without a second network call.
 */

import { useSyncExternalStore } from "react";

import type { Update } from "@tauri-apps/plugin-updater";

import { isTauriRuntime } from "@/lib/media";

/** The Tauri updater handle returned by `check()`. Opaque outside this module. */
export type UpdateHandle = Update;

/* -------------------------------------------------------------------------- */
/* Check result                                                               */
/* -------------------------------------------------------------------------- */

export interface AvailableUpdate {
  available: true;
  /** Version announced by the update server (e.g. `0.2.0`). */
  version: string;
  /** Release notes, when the manifest provided them. */
  notes: string | null;
  /** Version currently installed. */
  currentVersion: string | null;
  /** Pass this handle to {@link downloadAndInstall}. */
  update: UpdateHandle;
}

export interface NoAvailableUpdate {
  available: false;
  version: null;
  notes: null;
  currentVersion: string | null;
}

export interface UpdateCheckError {
  error: string;
}

/** `{available, version, notes}` on success, `{error}` when the check failed. */
export type UpdateCheckResult = AvailableUpdate | NoAvailableUpdate | UpdateCheckError;

/* -------------------------------------------------------------------------- */
/* Status snapshot                                                            */
/* -------------------------------------------------------------------------- */

export type UpdaterPhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "installing"
  | "unsupported"
  | "error";

export interface UpdaterStatus {
  phase: UpdaterPhase;
  /** Version being offered (available/downloading/installing). */
  version: string | null;
  /** Release notes for the offered version. */
  notes: string | null;
  /** Version currently installed, when the updater reported it. */
  currentVersion: string | null;
  /** Download completion 0..1, or `null` when the size is unknown. */
  progress: number | null;
  /** Human-readable detail for `unsupported` / `error`. */
  message: string | null;
  /** Epoch ms of the last completed check/install attempt. */
  checkedAt: number | null;
}

const INITIAL_STATUS: UpdaterStatus = {
  phase: "idle",
  version: null,
  notes: null,
  currentVersion: null,
  progress: null,
  message: null,
  checkedAt: null,
};

let status: UpdaterStatus = INITIAL_STATUS;
const listeners = new Set<() => void>();

function publish(patch: Partial<UpdaterStatus>): void {
  status = { ...status, ...patch };
  for (const listener of listeners) listener();
}

/** Latest updater state (also used by the diagnostics bundle). */
export function getUpdaterStatus(): UpdaterStatus {
  return status;
}

export function subscribeUpdaterStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React binding for the status snapshot (Settings → Storage → Updates). */
export function useUpdaterStatus(): UpdaterStatus {
  return useSyncExternalStore(subscribeUpdaterStatus, getUpdaterStatus, getUpdaterStatus);
}

/* -------------------------------------------------------------------------- */
/* Staged update handle                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `check()` allocates a Rust-side resource, so the handle is kept alive until
 * the user installs or checks again. It is never exposed in the status
 * snapshot because it is not serializable.
 */
let pendingUpdate: UpdateHandle | null = null;

/** The update staged by the last successful `checkForUpdates()` call. */
export function getPendingUpdate(): UpdateHandle | null {
  return pendingUpdate;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The updater plugin is only registered by the desktop shell. */
export function isUpdaterSupported(): boolean {
  return isTauriRuntime();
}

function clampFraction(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/* -------------------------------------------------------------------------- */
/* Check                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Ask the configured release endpoint for an update.
 *
 * Returns `{available, version, notes}` (plus the staged handle) when a newer
 * version exists, `{available: false}` when the app is current, and `{error}`
 * when the shell has no updater configured or the network call failed. Never
 * throws — the caller renders the result inline and/or in a toast.
 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  if (!isTauriRuntime()) {
    const message = "Updates are available in the installed desktop app.";
    publish({
      phase: "unsupported",
      version: null,
      notes: null,
      progress: null,
      message,
      checkedAt: Date.now(),
    });
    return { error: message };
  }

  publish({ phase: "checking", message: null });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) {
      pendingUpdate = null;
      publish({
        phase: "up-to-date",
        version: null,
        notes: null,
        currentVersion: status.currentVersion,
        progress: null,
        message: null,
        checkedAt: Date.now(),
      });
      return {
        available: false,
        version: null,
        notes: null,
        currentVersion: status.currentVersion,
      };
    }

    pendingUpdate = update;
    const notes = update.body?.trim() ? update.body.trim() : null;
    publish({
      phase: "available",
      version: update.version,
      notes,
      currentVersion: update.currentVersion ?? null,
      progress: null,
      message: null,
      checkedAt: Date.now(),
    });
    return {
      available: true,
      version: update.version,
      notes,
      currentVersion: update.currentVersion ?? null,
      update,
    };
  } catch (error) {
    pendingUpdate = null;
    const message = describeError(error);
    publish({
      phase: "error",
      version: null,
      notes: null,
      progress: null,
      message,
      checkedAt: Date.now(),
    });
    return { error: message };
  }
}

/* -------------------------------------------------------------------------- */
/* Download + install                                                         */
/* -------------------------------------------------------------------------- */

export interface UpdateDownloadProgress {
  downloaded: number;
  /** Total bytes from the `Started` event, or `null` when unknown. */
  total: number | null;
  /** `downloaded / total` in 0..1, or `null` when unknown. */
  fraction: number | null;
}

export type InstallResult = { ok: true } | { error: string };

/**
 * Download and install a staged update. Progress is published to the status
 * snapshot and forwarded to `onProgress`.
 *
 * On Windows the shell exits once the installer launches; on macOS/Linux the
 * caller should call {@link relaunchApp} after this resolves. Never throws.
 */
export async function downloadAndInstall(
  update: UpdateHandle,
  onProgress?: (progress: UpdateDownloadProgress) => void,
): Promise<InstallResult> {
  if (!isTauriRuntime()) {
    return { error: "Updates are available in the installed desktop app." };
  }

  let downloaded = 0;
  let total: number | null = null;
  publish({
    phase: "downloading",
    version: update.version,
    progress: total === null ? null : 0,
    message: null,
  });

  try {
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = typeof event.data.contentLength === "number" ? event.data.contentLength : null;
        const fraction = total === null ? null : 0;
        publish({ phase: "downloading", progress: fraction });
        onProgress?.({ downloaded, total, fraction });
        return;
      }
      if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        const fraction = total !== null && total > 0 ? clampFraction(downloaded / total) : null;
        publish({ phase: "downloading", progress: fraction });
        onProgress?.({ downloaded, total, fraction });
        return;
      }
      publish({ phase: "installing", progress: 1 });
      onProgress?.({ downloaded, total, fraction: 1 });
    });

    pendingUpdate = null;
    publish({ phase: "installing", progress: 1, checkedAt: Date.now() });
    return { ok: true };
  } catch (error) {
    const message = describeError(error);
    publish({ phase: "error", message, progress: null, checkedAt: Date.now() });
    return { error: message };
  }
}

/* -------------------------------------------------------------------------- */
/* Relaunch                                                                   */
/* -------------------------------------------------------------------------- */

/** Relaunch the desktop app (macOS/Linux after an in-place update). */
export async function relaunchApp(): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error("Restarting is only available in the installed desktop app.");
  }
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

/* -------------------------------------------------------------------------- */
/* Silent startup check                                                       */
/* -------------------------------------------------------------------------- */

export interface StartupUpdateCheckOptions {
  /** Delay before the silent check (default 10 s, after the app has settled). */
  delayMs?: number;
  /** Called once when an update is available; used to raise a single toast. */
  onAvailable?: (result: AvailableUpdate) => void;
}

let startupCheckStarted = false;

/**
 * One silent update check per app session, desktop only. Nothing is installed:
 * the caller shows a single informational toast with a "view updates" action.
 * Returns a cleanup function that cancels a not-yet-fired timer.
 */
export function startStartupUpdateCheck(options: StartupUpdateCheckOptions = {}): () => void {
  if (!isTauriRuntime() || startupCheckStarted) return () => {};
  startupCheckStarted = true;

  const delay = Math.max(0, options.delayMs ?? 10_000);
  const timer = window.setTimeout(() => {
    void checkForUpdates().then((result) => {
      if ("error" in result) return;
      if (result.available) options.onAvailable?.(result);
    });
  }, delay);

  return () => {
    window.clearTimeout(timer);
    startupCheckStarted = false;
  };
}

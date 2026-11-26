/**
 * Desktop-shell file plumbing.
 *
 * Browsers never expose an absolute path for a dropped/picked file, while the
 * FastAPI sidecar needs one (`file_path`). Tauri v2 supplies paths through its
 * native drag-drop event and, when the shell registers the dialog plugin,
 * through `plugin:dialog|open`. Everything here is a thin adapter — no file
 * processing happens in the renderer.
 */

import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

export const LECTURE_EXTENSIONS = ["mp4", "mov", "mkv"] as const;
const LECTURE_ACCEPT = LECTURE_EXTENSIONS.map((extension) => `.${extension}`).join(",");

interface TauriDialogOptions {
  multiple?: boolean;
  directory?: boolean;
  title?: string;
  filters?: { name: string; extensions: string[] }[];
}

interface TauriGlobal {
  dialog?: {
    open?: (options?: TauriDialogOptions) => Promise<string | string[] | null>;
  };
}

interface TauriWindow extends Window {
  __TAURI_INTERNALS__?: unknown;
  __TAURI__?: TauriGlobal;
}

function tauriWindow(): TauriWindow | null {
  if (typeof window === "undefined") return null;
  return window as TauriWindow;
}

export function isTauriRuntime(): boolean {
  const host = tauriWindow();
  if (!host) return false;
  if (host.__TAURI_INTERNALS__ || host.__TAURI__) return true;
  try {
    return isTauri();
  } catch {
    return false;
  }
}

export function hasLectureExtension(fileName: string): boolean {
  const extension = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
  return (LECTURE_EXTENSIONS as readonly string[]).includes(extension);
}

/** Absolute-path URL for a local media file, when running inside Tauri. */
export function toMediaSrc(path: string | null | undefined): string | null {
  if (!path) return null;
  // The sidecar normally returns a Windows path, but accept an HTTP/blob/data
  // URL as-is so previews keep working if a future transport serves media.
  if (/^(https?:|data:|blob:)/i.test(path)) return path;
  if (!isTauriRuntime()) return null;
  try {
    return convertFileSrc(path);
  } catch {
    return null;
  }
}

export interface MediaProbe {
  ok: boolean;
  /** HTTP status from the asset protocol, or `null` when the fetch failed. */
  status: number | null;
  /** Content-Length in bytes, when the protocol reports it. */
  size: number | null;
}

/**
 * Probe an asset-protocol URL for reachability and size without downloading the
 * body. Used to tell "file missing/moved" apart from "codec unsupported" when a
 * preview fails, and to validate a re-linked lecture. Never throws.
 */
export async function probeMediaSrc(src: string): Promise<MediaProbe> {
  try {
    const response = await fetch(src);
    const header = response.headers.get("Content-Length");
    const parsed = header === null ? NaN : Number(header);
    // Only status + length are needed; drop the body immediately so a multi-GB
    // lecture is never streamed into the renderer.
    void response.body?.cancel().catch(() => {});
    return {
      ok: response.ok,
      status: response.status,
      size: Number.isFinite(parsed) ? parsed : null,
    };
  } catch {
    return { ok: false, status: null, size: null };
  }
}

export type MediaFailureKind = "missing" | "forbidden" | "decode" | "network" | "unknown";

/**
 * Map a `<video>` MediaError code plus an asset probe to an actionable cause.
 * A reachable file (probe ok) that still fails is a decode/container problem;
 * a 404/410 is a missing or moved file; 403 is a scope/permission problem.
 */
export function classifyMediaFailure(
  code: number | null,
  probe: MediaProbe,
): MediaFailureKind {
  if (probe.status === 404 || probe.status === 410) return "missing";
  if (probe.status === 403) return "forbidden";
  if (probe.ok) {
    if (code === 3 || code === 4) return "decode";
    if (code === 2) return "network";
    return "unknown";
  }
  if (probe.status !== null) return "missing";
  if (code === 2) return "network";
  if (code === 4) return "decode";
  return "unknown";
}

function firstPath(value: string | string[] | null): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

const DIALOG_OPTIONS: TauriDialogOptions = {
  multiple: false,
  directory: false,
  title: "Choose a lecture video",
  filters: [{ name: "Lecture video", extensions: [...LECTURE_EXTENSIONS] }],
};

async function openNativePath(): Promise<string | null> {
  const globalOpen = tauriWindow()?.__TAURI__?.dialog?.open;
  if (typeof globalOpen === "function") {
    return firstPath(await globalOpen(DIALOG_OPTIONS));
  }
  // Typed dialog plugin. If the shell has not registered `dialog:default` the
  // call rejects and the caller falls back to the browser picker, so a plain
  // browser build never breaks on this import.
  const result = await openDialog(DIALOG_OPTIONS);
  if (Array.isArray(result)) return result[0] ?? null;
  return result ?? null;
}

export interface LecturePick {
  /** Absolute path, when the desktop shell could provide one. */
  path: string | null;
  /** File name for display, even when only a browser `File` is available. */
  name: string | null;
  /** Browser `File` fallback (no absolute path). */
  file: File | null;
  cancelled: boolean;
  /** Why a native dialog was unavailable, for a precise toast. */
  reason?: string;
}

function pickFileWithInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = `${LECTURE_ACCEPT},video/*`;
    input.style.display = "none";
    const finish = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => finish(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Ask the shell for a lecture path. In a plain browser this falls back to an
 * `<input type="file">`, which yields a `File` but no absolute path.
 */
export async function openLectureFile(): Promise<LecturePick> {
  if (isTauriRuntime()) {
    try {
      const path = await openNativePath();
      if (!path) {
        return { path: null, name: null, file: null, cancelled: true };
      }
      return {
        path,
        name: path.split(/[\\/]/).pop() ?? path,
        file: null,
        cancelled: false,
      };
    } catch (error) {
      return {
        path: null,
        name: null,
        file: null,
        cancelled: false,
        reason:
          error instanceof Error
            ? error.message
            : "The native file dialog is not available in this build.",
      };
    }
  }

  const file = await pickFileWithInput();
  if (!file) return { path: null, name: null, file: null, cancelled: true };
  const path = (file as File & { path?: string }).path ?? null;
  return { path, name: file.name, file, cancelled: false };
}

/**
 * Native folder picker for Settings → project folder. Returns `null` in a plain
 * browser (no absolute path exists to persist), so the caller keeps its text
 * field usable instead of showing a dead button.
 */
export async function openDirectory(
  title = "Choose the project folder",
): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const options: TauriDialogOptions = { directory: true, multiple: false, title };
  try {
    const globalOpen = tauriWindow()?.__TAURI__?.dialog?.open;
    if (typeof globalOpen === "function") return firstPath(await globalOpen(options));
    const result = await openDialog(options);
    if (Array.isArray(result)) return result[0] ?? null;
    return result ?? null;
  } catch {
    return null;
  }
}

/**
 * Open a file or folder in the OS default app / Explorer. Returns `false` when
 * the shell opener is unavailable so callers can fall back to copying the path.
 */
export async function openPathInShell(path: string): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(path);
    return true;
  } catch {
    return false;
  }
}

/** Open a documentation or download link in the user's browser. */
export async function openExternalUrl(url: string): Promise<boolean> {
  try {
    if (!isTauriRuntime()) {
      window.open(url, "_blank", "noopener,noreferrer");
      return true;
    }
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return true;
  } catch {
    return false;
  }
}

export interface NativeDropHandlers {
  onEnter?: () => void;
  onLeave?: () => void;
  onDrop: (paths: string[]) => void;
}

/**
 * Subscribe to Tauri's native drag-drop stream. Returns a no-op cleanup in a
 * browser, where the dropzone uses the HTML5 drag events instead.
 */
export function subscribeNativeDrops(handlers: NativeDropHandlers): () => void {
  if (!isTauriRuntime()) return () => {};

  let unlisten: (() => void) | null = null;
  let cancelled = false;

  void getCurrentWebview()
    .onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "enter" || payload.type === "over") {
        handlers.onEnter?.();
        return;
      }
      if (payload.type === "leave") {
        handlers.onLeave?.();
        return;
      }
      if (payload.type === "drop") {
        handlers.onLeave?.();
        handlers.onDrop(payload.paths);
      }
    })
    .then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    })
    .catch(() => {
      /* Drag-drop is unavailable (older shell); the HTML drop handlers remain. */
    });

  return () => {
    cancelled = true;
    unlisten?.();
    unlisten = null;
  };
}

export function fileFromDrop(dataTransfer: DataTransfer | null): File | null {
  if (!dataTransfer) return null;
  return dataTransfer.files?.[0] ?? null;
}

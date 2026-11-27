/**
 * Desktop-shell file plumbing.
 *
 * Browsers never expose an absolute path for a dropped/picked file, while the
 * FastAPI sidecar needs one (`file_path`). Tauri v2 supplies paths through its
 * native drag-drop event and, when the shell registers the dialog plugin,
 * through `plugin:dialog|open`. Everything here is a thin adapter — no file
 * processing happens in the renderer.
 */

import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { InsertKind } from "@/lib/projectTypes";

export const LECTURE_EXTENSIONS = ["mp4", "mov", "mkv"] as const;
const LECTURE_ACCEPT = LECTURE_EXTENSIONS.map((extension) => `.${extension}`).join(",");

export const INSERT_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp"] as const;
export const INSERT_VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "webm"] as const;
const INSERT_ACCEPT = [
  ...INSERT_IMAGE_EXTENSIONS.map((ext) => `.${ext}`),
  ...INSERT_VIDEO_EXTENSIONS.map((ext) => `.${ext}`),
  "image/png",
  "image/jpeg",
  "image/webp",
  "video/*",
].join(",");

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

const PROBE_TIMEOUT_MS = 5_000;

function parseContentRangeTotal(header: string | null): number | null {
  if (!header) return null;
  const match = /\/(\d+)\s*$/.exec(header);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Probe an asset-protocol URL for reachability and size without buffering the
 * file. Used to tell "file missing/moved" apart from "codec unsupported" when a
 * preview fails, and to validate a re-linked lecture. Never throws.
 *
 * Uses `HEAD` (never an unbounded `GET`): Tauri's asset protocol reads the
 * entire file into memory on plain `GET` before responding, which freezes the
 * Windows UI/IPC thread for multi-GB lectures.
 */
export async function probeMediaSrc(src: string): Promise<MediaProbe> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    let response = await fetch(src, { method: "HEAD", signal: controller.signal });
    let size: number | null = null;
    if (response.status === 405) {
      response = await fetch(src, {
        headers: { Range: "bytes=0-0" },
        signal: controller.signal,
      });
      size = parseContentRangeTotal(response.headers.get("Content-Range"));
      void response.body?.cancel().catch(() => {});
    } else {
      const header = response.headers.get("Content-Length");
      const parsed = header === null ? NaN : Number(header);
      size = Number.isFinite(parsed) ? parsed : null;
    }
    return {
      ok: response.ok,
      status: response.status,
      size,
    };
  } catch {
    return { ok: false, status: null, size: null };
  } finally {
    window.clearTimeout(timer);
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
            : typeof error === "string" && error.trim()
              ? error
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

export function classifyInsertFile(nameOrPath: string): InsertKind | null {
  const clean = nameOrPath.split(/[?#]/)[0];
  const dot = clean.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = clean.slice(dot + 1).toLowerCase();
  if ((INSERT_IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return "image";
  if ((INSERT_VIDEO_EXTENSIONS as readonly string[]).includes(ext)) return "video";
  return null;
}

export interface InsertMediaPick {
  path: string;
  name: string;
  kind: InsertKind;
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function pickInsertFilesWithInput(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = INSERT_ACCEPT;
    input.style.display = "none";
    const finish = (files: File[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => finish(Array.from(input.files ?? [])));
    input.addEventListener("cancel", () => finish([]));
    document.body.appendChild(input);
    input.click();
  });
}

function pickFromBrowserFile(file: File): InsertMediaPick | null {
  const path = (file as File & { path?: string }).path ?? null;
  let kind = classifyInsertFile(file.name);
  if (!kind) {
    if (file.type.startsWith("image/")) kind = "image";
    else if (file.type.startsWith("video/")) kind = "video";
  }
  if (!kind) return null;
  return {
    path: path ?? URL.createObjectURL(file),
    name: file.name || (kind === "image" ? "image.png" : "video.mp4"),
    kind,
  };
}

/** Pick one or more insert images/videos using the native dialog or browser fallback. */
export async function openInsertMediaFiles(): Promise<InsertMediaPick[]> {
  if (isTauriRuntime()) {
    const options: TauriDialogOptions = {
      multiple: true,
      directory: false,
      title: "Choose images or videos to insert",
      filters: [
        {
          name: "Images & Videos",
          extensions: [...INSERT_IMAGE_EXTENSIONS, ...INSERT_VIDEO_EXTENSIONS],
        },
        { name: "Images", extensions: [...INSERT_IMAGE_EXTENSIONS] },
        { name: "Videos", extensions: [...INSERT_VIDEO_EXTENSIONS] },
      ],
    };
    try {
      const globalOpen = tauriWindow()?.__TAURI__?.dialog?.open;
      const raw =
        typeof globalOpen === "function" ? await globalOpen(options) : await openDialog(options);
      const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
      const picks: InsertMediaPick[] = [];
      for (const path of list) {
        const kind = classifyInsertFile(path);
        if (kind) picks.push({ path, name: fileNameFromPath(path), kind });
      }
      return picks;
    } catch {
      return [];
    }
  }

  const files = await pickInsertFilesWithInput();
  const picks: InsertMediaPick[] = [];
  for (const file of files) {
    const pick = pickFromBrowserFile(file);
    if (pick) picks.push(pick);
  }
  return picks;
}

/** Read copied file paths from the OS clipboard (Windows Explorer Ctrl+C). */
export async function readClipboardFilePaths(): Promise<string[]> {
  if (!isTauriRuntime()) return [];
  try {
    const result = await invoke<string[]>("read_clipboard_file_paths");
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

function extensionForImageMime(mime: string, fileName?: string): "png" | "jpg" | "webp" {
  const lowered = mime.toLowerCase();
  if (lowered.includes("jpeg") || lowered.includes("jpg")) return "jpg";
  if (lowered.includes("webp")) return "webp";
  if (lowered.includes("png")) return "png";
  if (fileName) {
    const ext = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
    if (ext === "jpg" || ext === "jpeg") return "jpg";
    if (ext === "webp") return "webp";
  }
  return "png";
}

/** Save a pasted clipboard image blob into app-managed project storage (or blob URL in browser). */
export async function saveClipboardImage(
  projectId: string,
  file: Blob,
  fileName?: string,
): Promise<InsertMediaPick | null> {
  const ext = extensionForImageMime(file.type, fileName);
  const displayName = fileName && fileName.trim() ? fileName.trim() : `pasted-image.${ext}`;
  if (isTauriRuntime()) {
    const buffer = await file.arrayBuffer();
    const bytes = Array.from(new Uint8Array(buffer));
    const savedPath = await invoke<string>("save_clipboard_asset", {
      projectId,
      extension: ext,
      bytes,
    });
    return { path: savedPath, name: displayName, kind: "image" };
  }
  return {
    path: URL.createObjectURL(file),
    name: displayName,
    kind: "image",
  };
}

export interface InsertMediaMetadata {
  duration: number | null;
  width: number | null;
  height: number | null;
}

const METADATA_PROBE_TIMEOUT_MS = 8_000;

/** Probe natural width/height and (for videos) source duration via media elements. */
export function probeInsertMedia(
  pathOrSrc: string,
  kind: InsertKind,
): Promise<InsertMediaMetadata> {
  const src = toMediaSrc(pathOrSrc);
  if (!src) {
    return Promise.reject(new Error("Could not resolve media preview path."));
  }

  if (kind === "image") {
    return new Promise((resolve, reject) => {
      const img = new Image();
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        img.src = "";
        reject(new Error("Timed out reading image dimensions."));
      }, METADATA_PROBE_TIMEOUT_MS);
      img.onload = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve({
          duration: null,
          width: img.naturalWidth || null,
          height: img.naturalHeight || null,
        });
      };
      img.onerror = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(new Error("Could not load this image file."));
      };
      img.src = src;
    });
  }

  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timer);
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute("src");
      video.load();
    };
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Timed out reading video duration."));
    }, METADATA_PROBE_TIMEOUT_MS);
    video.onloadedmetadata = () => {
      if (settled) return;
      settled = true;
      const duration =
        Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
      const width = video.videoWidth || null;
      const height = video.videoHeight || null;
      cleanup();
      resolve({ duration, width, height });
    };
    video.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Could not read this video file."));
    };
    video.src = src;
  });
}

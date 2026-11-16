/**
 * Optional GPU acceleration pack — renderer side.
 *
 * Hardware acceleration is optional and vendor-neutral in the UI (AGENTS.md
 * §3): the sidecar detects a GPU, the Rust shell provisions a signed pack, and
 * the app always keeps working on the CPU. Nothing here talks to a vendor SDK:
 *
 *  - `GET /health.acceleration` describes what the sidecar can use right now.
 *  - Tauri commands `acceleration_status()` / `download_acceleration_pack(url)`
 *    report and install the pack; the shell emits `acceleration-progress`.
 *
 * Every Tauri call is guarded by {@link isTauriRuntime}, so a plain-browser
 * build (Vite preview, Playwright) renders the "available in the installed
 * desktop app" state and never throws. `@tauri-apps/api/core` and `/event` are
 * already part of the browser bundle (`lib/media.ts`), so they are imported
 * statically; only plugin packages would need a dynamic import.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";

import type { AccelerationStatus, HealthResponse } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { isTauriRuntime } from "@/lib/media";

/**
 * Default manifest. The release workflow overrides this at build time via
 * `VITE_ACCEL_PACK_MANIFEST_URL`; a local/dev build must point at the real
 * published asset too, not a placeholder host. The repository has no custom
 * CDN, so the signed GitHub release is the source of truth (docs/GPU_PACK.md):
 * the manifest and its DLLs are uploaded to the same release as the installer.
 */
const DEFAULT_MANIFEST_URL =
  "https://github.com/reedsha/tafseer-clipper/releases/latest/download/accel-manifest.json";

function resolveManifestUrl(): string {
  const fromEnv = import.meta.env.VITE_ACCEL_PACK_MANIFEST_URL;
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  return DEFAULT_MANIFEST_URL;
}

/** Manifest the shell downloads the acceleration pack from. */
export const MANIFEST_URL: string = resolveManifestUrl();

/** Installed-pack description returned by both Tauri commands. */
export interface AccelerationPackStatus {
  installed: boolean;
  version: string | null;
  dir: string | null;
  size_bytes: number;
}

/** Payload of the shell's `acceleration-progress` event. */
export interface AccelerationProgress {
  phase: "download" | "verify" | "installed";
  file: string | null;
  file_index: number;
  file_count: number;
  downloaded_bytes: number;
  total_bytes: number;
}

/* -------------------------------------------------------------------------- */
/* Status snapshot                                                            */
/* -------------------------------------------------------------------------- */

export type AccelerationPackPhase =
  | "idle"
  | "checking"
  | "missing"
  | "downloading"
  | "installed"
  | "unsupported"
  | "error";

export interface AccelerationPackState {
  phase: AccelerationPackPhase;
  status: AccelerationPackStatus | null;
  progress: AccelerationProgress | null;
  /** Bytes downloaded across the whole pack (sum of finished files). */
  downloadedBytes: number;
  /** Total pack size when the manifest reports it, else 0. */
  totalBytes: number;
  /** Human-readable detail for `unsupported` / `error`. */
  message: string | null;
  checkedAt: number | null;
}

const INITIAL_STATE: AccelerationPackState = {
  phase: "idle",
  status: null,
  progress: null,
  downloadedBytes: 0,
  totalBytes: 0,
  message: null,
  checkedAt: null,
};

let state: AccelerationPackState = INITIAL_STATE;
const listeners = new Set<() => void>();

function publish(patch: Partial<AccelerationPackState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function getAccelerationPackState(): AccelerationPackState {
  return state;
}

export function subscribeAccelerationPack(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React binding for the pack snapshot (Settings → GPU acceleration). */
export function useAccelerationPack(): AccelerationPackState {
  return useSyncExternalStore(
    subscribeAccelerationPack,
    getAccelerationPackState,
    getAccelerationPackState,
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const UNSUPPORTED_MESSAGE = "Available in the installed desktop app";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizePackStatus(raw: unknown): AccelerationPackStatus {
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const size = typeof record.size_bytes === "number" ? record.size_bytes : 0;
  return {
    installed: record.installed === true,
    version: typeof record.version === "string" ? record.version : null,
    dir: typeof record.dir === "string" ? record.dir : null,
    size_bytes: Number.isFinite(size) && size > 0 ? size : 0,
  };
}

/** 0..1 download fraction, or `null` when the total size is unknown. */
export function accelerationFraction(current: AccelerationPackState): number | null {
  if (!current.totalBytes || current.totalBytes <= 0) return null;
  return Math.min(1, Math.max(0, current.downloadedBytes / current.totalBytes));
}

/** "12.4 MB of 96.0 MB" — shared by Settings and the Step 1 callout. */
export function accelerationProgressLabel(current: AccelerationPackState): string {
  const downloaded = formatBytes(current.downloadedBytes);
  if (!current.totalBytes) return downloaded;
  return `${downloaded} of ${formatBytes(current.totalBytes)}`;
}

/* -------------------------------------------------------------------------- */
/* Tauri commands                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Ask the shell whether the acceleration pack is installed.
 *
 * Never throws: returns `null` when the app runs in a browser or the command
 * fails (the snapshot carries the message for the UI).
 */
export async function getAccelerationStatus(): Promise<AccelerationPackStatus | null> {
  if (!isTauriRuntime()) {
    publish({
      phase: "unsupported",
      status: null,
      progress: null,
      message: UNSUPPORTED_MESSAGE,
      checkedAt: Date.now(),
    });
    return null;
  }

  publish({ phase: "checking", message: null });
  try {
    const status = normalizePackStatus(await invoke("acceleration_status"));
    publish({
      phase: status.installed ? "installed" : "missing",
      status,
      progress: null,
      downloadedBytes: status.installed ? status.size_bytes : 0,
      totalBytes: status.installed ? status.size_bytes : 0,
      message: null,
      checkedAt: Date.now(),
    });
    return status;
  } catch (error) {
    publish({
      phase: "error",
      status: null,
      progress: null,
      message: describeError(error),
      checkedAt: Date.now(),
    });
    return null;
  }
}

export type AccelerationDownloadResult =
  | { ok: true; status: AccelerationPackStatus }
  | { error: string };

let statusRequested = false;

/**
 * Ask the shell for the pack status once per session. Both Settings and the
 * Step 1 callout mount the panel, so the invoke is deduplicated here.
 */
export async function ensureAccelerationStatusLoaded(): Promise<AccelerationPackStatus | null> {
  if (statusRequested) return state.status;
  statusRequested = true;
  return getAccelerationStatus();
}

/**
 * Download + verify + install the acceleration pack through the shell.
 *
 * Progress arrives as `acceleration-progress` events and is mirrored into the
 * snapshot so both the Settings panel and the Step 1 callout show the same
 * numbers. The CPU path keeps working during and after the download. Never
 * throws.
 */
export async function downloadAccelerationPack(): Promise<AccelerationDownloadResult> {
  if (!isTauriRuntime()) {
    const message = UNSUPPORTED_MESSAGE;
    publish({ phase: "unsupported", message, checkedAt: Date.now() });
    return { error: message };
  }

  publish({
    phase: "downloading",
    progress: null,
    downloadedBytes: 0,
    totalBytes: 0,
    message: null,
  });

  let unlisten: (() => void) | null = null;
  try {
    unlisten = await listen<AccelerationProgress>("acceleration-progress", (event) => {
      const payload = event.payload;
      if (!payload || typeof payload !== "object") return;
      // The shell reports whole-pack byte counts; file_index/file_count are for
      // the "file 2 of 5" detail line.
      const total = Number.isFinite(payload.total_bytes) ? payload.total_bytes : 0;
      const done = Number.isFinite(payload.downloaded_bytes) ? payload.downloaded_bytes : 0;
      publish({
        phase: payload.phase === "installed" ? "installed" : "downloading",
        progress: payload,
        downloadedBytes: Math.max(0, done),
        totalBytes: total > 0 ? total : state.totalBytes,
      });
    });

    const status = normalizePackStatus(
      await invoke("download_acceleration_pack", { manifestUrl: MANIFEST_URL }),
    );
    publish({
      phase: "installed",
      status,
      progress: null,
      downloadedBytes: status.size_bytes,
      totalBytes: status.size_bytes,
      message: null,
      checkedAt: Date.now(),
    });
    return { ok: true, status };
  } catch (error) {
    const message = describeError(error);
    publish({ phase: "error", message, progress: null, checkedAt: Date.now() });
    return { error: message };
  } finally {
    unlisten?.();
  }
}

/* -------------------------------------------------------------------------- */
/* /health → UI model                                                         */
/* -------------------------------------------------------------------------- */

export type AccelerationState =
  | "ready"
  | "gpu-detected-needs-runtime"
  | "cpu-only"
  | "unknown";

export interface AccelerationSummary {
  state: AccelerationState;
  /** Short status label for a badge/row ("GPU ready", "CPU only", …). */
  label: string;
  /** One-sentence explanation that always names the CPU fallback. */
  description: string;
  transcription: "gpu" | "cpu";
  encoding: "gpu" | "cpu";
  gpuDetected: boolean;
  /** Detected adapter name — diagnostics/tooltip only. */
  gpuName: string | null;
  cudaRuntime: boolean;
  packInstalled: boolean;
  reason: string | null;
}

const UNKNOWN_SUMMARY: AccelerationSummary = {
  state: "unknown",
  label: "Acceleration unknown",
  description: "Start the sidecar to detect GPU support. CPU transcription and encoding always work.",
  transcription: "cpu",
  encoding: "cpu",
  gpuDetected: false,
  gpuName: null,
  cudaRuntime: false,
  packInstalled: false,
  reason: null,
};

/**
 * Turn `GET /health` into the vendor-neutral acceleration model the UI renders.
 * Falls back to `cuda_available` / `nvenc_available` when the sidecar predates
 * the `acceleration` block.
 */
export function describeAcceleration(
  health: HealthResponse | null | undefined,
): AccelerationSummary {
  if (!health) return UNKNOWN_SUMMARY;

  const acceleration: AccelerationStatus | undefined = health.acceleration;
  const gpuDetected = acceleration ? acceleration.gpu_detected : health.cuda_available;
  const cudaRuntime = acceleration ? acceleration.cuda_runtime : health.cuda_available;
  const transcription: "gpu" | "cpu" = acceleration
    ? acceleration.transcription
    : health.cuda_available
      ? "gpu"
      : "cpu";
  const encoding: "gpu" | "cpu" = acceleration
    ? acceleration.encoding
    : health.nvenc_available
      ? "gpu"
      : "cpu";
  const gpuName = acceleration?.gpu_name ?? null;
  const packInstalled = acceleration ? acceleration.pack_installed : health.cuda_available;
  const reason = acceleration?.reason ?? null;

  const base = { transcription, encoding, gpuDetected, gpuName, cudaRuntime, packInstalled, reason };

  if (transcription === "gpu" || encoding === "gpu") {
    return {
      ...base,
      state: "ready",
      label: "GPU ready",
      description:
        transcription === "gpu" && encoding === "gpu"
          ? "Transcription and encoding use the GPU."
          : transcription === "gpu"
            ? "Transcription uses the GPU; encoding runs on the CPU."
            : "Encoding uses the GPU; transcription runs on the CPU.",
    };
  }

  if (gpuDetected) {
    return {
      ...base,
      state: "gpu-detected-needs-runtime",
      label: "GPU detected — runtime not installed",
      description:
        "A GPU is available but its acceleration runtime is not installed. Everything still works on the CPU (slower).",
    };
  }

  return {
    ...base,
    state: "cpu-only",
    label: "CPU only",
    description: "No GPU detected — transcription and encoding run on the CPU. Slower, always available.",
  };
}

/** True when hardware encoding can be used right now. */
export function isGpuEncodingAvailable(summary: AccelerationSummary): boolean {
  return summary.encoding === "gpu";
}

/** True when the user could enable acceleration by installing the pack. */
export function canEnableGpu(summary: AccelerationSummary): boolean {
  return summary.state === "gpu-detected-needs-runtime";
}

/**
 * Human copy for the sidecar's machine-readable `reason` code. Diagnostics keep
 * the raw code; the Settings panel shows this sentence instead of leaking
 * `cuda-runtime-missing` into the UI.
 */
const ACCELERATION_REASON_COPY: Record<string, string> = {
  "no-nvidia-gpu": "No supported GPU was detected on this machine.",
  "cuda-runtime-missing": "A GPU was detected, but the acceleration runtime is not installed.",
  "cuda-runtime-unusable": "The acceleration runtime is installed but could not be loaded.",
};

export function humanizeAccelerationReason(reason: string | null): string | null {
  if (!reason) return null;
  // A code this build does not know yet still reads as a sentence, never as
  // the raw token; the diagnostics bundle keeps the untranslated value.
  return (
    ACCELERATION_REASON_COPY[reason] ??
    "Acceleration is unavailable; transcription and encoding run on the CPU."
  );
}

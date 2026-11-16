/**
 * Support diagnostics bundle for the release build.
 *
 * "Copy diagnostics" in Settings → Main needs one pasteable blob with the
 * versions, paths and health snapshot a maintainer would ask for. It is built
 * from data the app already has (the `/health` payload polled by the store) and
 * never includes API keys, prompts, transcripts or file contents.
 */

import { getAccelerationPackState } from "@/lib/acceleration";
import { getHealth, SIDECAR_URL, type HealthResponse } from "@/lib/api";
import { isTauriRuntime } from "@/lib/media";
import { getUpdaterStatus } from "@/lib/updater";
import { useAiActivityStore } from "@/store/aiActivityStore";
import type { AiActivityEntry } from "@/lib/aiActivity";

export interface DiagnosticsInput {
  /** Last successful `/health` payload from the settings store, if any. */
  health: HealthResponse | null;
  sidecarStatus: string;
  sidecarError: string | null;
  /** Settings → Main → Project folder. */
  projectFolder: string;
  lastAutosaveError: string | null;
}

export interface DiagnosticsBundle {
  generatedAt: string;
  app: {
    name: string;
    version: string | null;
    versionSource: string;
    runtime: "desktop" | "browser";
    platform: string;
    userAgent: string;
    language: string;
  };
  sidecar: {
    url: string;
    status: string;
    error: string | null;
    health: HealthResponse | null;
  };
  paths: {
    work_dir: string | null;
    fonts_dir: string | null;
    project_folder: string | null;
  };
  storage: {
    last_autosave_error: string | null;
  };
  /** Optional GPU acceleration pack state (hardware names stay in this bundle). */
  acceleration: ReturnType<typeof getAccelerationPackState>;
  updater: ReturnType<typeof getUpdaterStatus>;
  /** Recent AI task provenance: task, model and connection — never keys or prompts. */
  ai_activity: AiActivityEntry[];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Build the JSON diagnostics bundle (pretty-printed for a support report). */
export async function buildDiagnostics(input: DiagnosticsInput): Promise<string> {
  let health = input.health;
  let sidecarError = input.sidecarError;
  if (!health) {
    try {
      health = await getHealth();
    } catch (error) {
      sidecarError = sidecarError ?? describeError(error);
    }
  }

  const bundle: DiagnosticsBundle = {
    generatedAt: new Date().toISOString(),
    app: {
      name: "Tafseer Clipper",
      // The sidecar reports the app version it was bundled with; there is no
      // separate renderer version channel in the six-endpoint contract.
      version: health?.version ?? null,
      versionSource: "GET /health",
      runtime: isTauriRuntime() ? "desktop" : "browser",
      platform: typeof navigator === "undefined" ? "unknown" : navigator.platform,
      userAgent: typeof navigator === "undefined" ? "unknown" : navigator.userAgent,
      language: typeof navigator === "undefined" ? "unknown" : navigator.language,
    },
    sidecar: {
      url: SIDECAR_URL,
      status: input.sidecarStatus,
      error: sidecarError,
      health,
    },
    paths: {
      work_dir: health?.work_dir ?? null,
      fonts_dir: health?.fonts_dir ?? null,
      project_folder: input.projectFolder.trim() || null,
    },
    storage: {
      last_autosave_error: input.lastAutosaveError,
    },
    acceleration: getAccelerationPackState(),
    updater: getUpdaterStatus(),
    ai_activity: useAiActivityStore.getState().entries,
  };

  return JSON.stringify(bundle, null, 2);
}

/**
 * Copy text to the clipboard, with an `execCommand` fallback for WebViews where
 * the async Clipboard API is unavailable. Returns `false` instead of throwing.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* Permission denied or insecure context — try the legacy path. */
  }

  if (typeof document === "undefined") return false;
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

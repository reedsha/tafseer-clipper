/**
 * Typed REST + SSE client for the FastAPI sidecar (localhost:8008).
 *
 * The architecture contract allows exactly six endpoints; this module exposes
 * nothing else and performs no heavy work — every call is a thin transport.
 */

declare global {
  interface Window {
    /**
     * Sidecar base URL injected by the Tauri shell at boot (e.g.
     * `"http://127.0.0.1:53412"`) once it has picked a free port for
     * `backend.exe`. Absent when the app runs in a plain browser.
     */
    __TAFSEER_SIDECAR_URL__?: string;
  }
}

/** Documented default port used when neither override is present. */
const DEFAULT_SIDECAR_URL = "http://127.0.0.1:8008";

function normalizeSidecarUrl(candidate: unknown): string | null {
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the sidecar base URL, first non-empty value wins:
 * 1. `VITE_SIDECAR_URL` — build-time env override.
 * 2. `window.__TAFSEER_SIDECAR_URL__` — runtime URL injected by the Tauri shell
 *    (dynamic port negotiation, see `src-tauri/src/lib.rs`).
 * 3. `http://127.0.0.1:8008` — the documented default port.
 */
function resolveSidecarUrl(): string {
  const fromEnv = normalizeSidecarUrl(import.meta.env.VITE_SIDECAR_URL);
  if (fromEnv) return fromEnv;
  const fromShell =
    typeof window === "undefined"
      ? null
      : normalizeSidecarUrl(window.__TAFSEER_SIDECAR_URL__);
  return fromShell ?? DEFAULT_SIDECAR_URL;
}

export const SIDECAR_URL: string = resolveSidecarUrl();

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(message: string, status = 0, detail = "") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

interface ValidationErrorItem {
  loc?: unknown;
  msg?: unknown;
}

/**
 * FastAPI/Pydantic validation failures return `detail` as an array of
 * `{ loc, msg, type }` objects. Render one readable line (`field: message`)
 * instead of dumping a JSON array into a toast.
 */
function formatValidationDetail(items: unknown[]): string | null {
  const parts: string[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as ValidationErrorItem;
    const message = typeof record.msg === "string" ? record.msg.trim() : "";
    if (!message) continue;
    const location = Array.isArray(record.loc)
      ? record.loc
          .filter((part) => typeof part === "string" || typeof part === "number")
          .map((part) => String(part))
          .filter((part) => part !== "body")
          .join(".")
      : "";
    parts.push(location ? `${location}: ${message}` : message);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

async function errorFromResponse(response: Response): Promise<ApiError> {
  let detail = `${response.status} ${response.statusText}`;
  try {
    const payload = (await response.json()) as { detail?: unknown };
    if (typeof payload.detail === "string") detail = payload.detail;
    else if (Array.isArray(payload.detail)) {
      detail = formatValidationDetail(payload.detail) ?? detail;
    } else if (payload.detail) detail = JSON.stringify(payload.detail);
  } catch {
    /* Non-JSON error body — keep the status line. */
  }
  return new ApiError(detail, response.status, detail);
}

/** Wrap transport failures in the same actionable `ApiError` used by REST calls. */
function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ApiError("The request was cancelled.", 0, "aborted");
  }
  return new ApiError(
    `Cannot reach the FastAPI sidecar on ${SIDECAR_URL}. Is backend.exe running?`,
    0,
    error instanceof Error ? error.message : String(error),
  );
}

interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

function withTimeout(
  timeoutMs: number,
  external?: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  external?.addEventListener("abort", onAbort);
  return {
    signal: controller.signal,
    dispose: () => {
      window.clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
  };
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  { timeoutMs = 30_000, signal }: RequestOptions = {},
): Promise<T> {
  const timeout = withTimeout(timeoutMs, signal);
  try {
    const response = await fetch(`${SIDECAR_URL}${path}`, {
      ...init,
      signal: timeout.signal,
    });
    if (!response.ok) throw await errorFromResponse(response);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiError(
        `The sidecar did not answer within ${Math.round(timeoutMs / 1000)}s.`,
        0,
        "timeout",
      );
    }
    throw toApiError(error);
  } finally {
    timeout.dispose();
  }
}

function jsonBody(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/* -------------------------------------------------------------------------- */
/* 1. GET /health                                                              */
/* -------------------------------------------------------------------------- */

export interface WhisperStatus {
  model: string;
  loaded: boolean;
  device: string;
  compute_type: string;
}

/**
 * Vendor-neutral acceleration state reported by `GET /health`.
 *
 * Optional: a sidecar built before the acceleration pack existed only reports
 * `cuda_available` / `nvenc_available`, and the UI falls back to those.
 */
export interface AccelerationStatus {
  transcription: "gpu" | "cpu";
  encoding: "gpu" | "cpu";
  gpu_detected: boolean;
  /** Detected adapter name, for diagnostics only (never a product-line label). */
  gpu_name: string | null;
  cuda_runtime: boolean;
  pack_installed: boolean;
  /** Why acceleration is unavailable, when the sidecar knows. */
  reason: string | null;
}

export interface HealthResponse {
  status: "ok";
  version: string;
  cuda_available: boolean;
  nvenc_available: boolean;
  vram_mb: number;
  ffmpeg_available: boolean;
  ffmpeg_path: string | null;
  ffprobe_available: boolean;
  fonts_dir: string;
  work_dir: string;
  /** Bytes currently used by temporary WAV / job files under `work_dir`. */
  disk_cache_bytes: number;
  whisper: WhisperStatus;
  /** Hardware acceleration summary; absent on older sidecars. */
  acceleration?: AccelerationStatus;
}

export function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  // The first /health call runs the hardware-encoder probe (a one-frame null
  // encode), which can exceed 4 s on a cold driver; 8 s avoids a false
  // "sidecar offline".
  return request<HealthResponse>("/health", { method: "GET" }, { timeoutMs: 8_000, signal });
}

/* -------------------------------------------------------------------------- */
/* 2. POST /extract-and-transcribe                                             */
/* -------------------------------------------------------------------------- */

export interface CloudSttConfig {
  base_url: string;
  api_key?: string | null;
  model?: string;
  language?: string | null;
}

export interface TranscribeRequest {
  file_path: string;
  use_local_whisper?: boolean;
  initial_prompt?: string;
  language?: string | null;
  glossary?: Record<string, string>;
  model?: string | null;
  device?: "auto" | "cuda" | "cpu";
  compute_type?: string | null;
  auto_unload?: boolean | null;
  vad_filter?: boolean;
  cloud?: CloudSttConfig | null;
}

export interface TranscribeResponse {
  transcript_id: string;
  status: "completed";
  duration: number;
  language: string | null;
  language_probability: number | null;
  segments: TranscriptSegment[];
  audio_path: string;
  model: string;
  device: string;
  compute_type: string;
  vram_unloaded: boolean;
  /**
   * Downsampled peak envelope of the extracted WAV (0..1). Lets the Step-2
   * waveform render without decoding a multi-hundred-MB PCM file in WebView2.
   * Absent on older sidecars.
   */
  waveform_peaks?: number[];
}

export interface TranscriptSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  language: string | null;
}

export function extractAndTranscribe(
  body: TranscribeRequest,
  options?: RequestOptions,
): Promise<TranscribeResponse> {
  return request<TranscribeResponse>("/extract-and-transcribe", jsonBody(body), {
    timeoutMs: 30 * 60_000,
    ...options,
  });
}

/* -------------------------------------------------------------------------- */
/* 3. POST /discover-clips                                                     */
/* -------------------------------------------------------------------------- */

export interface TimeRange {
  start: number;
  end: number;
}

export interface ProviderOverride {
  base_url?: string | null;
  api_key?: string | null;
  model?: string | null;
  timeout?: number | null;
}

export interface DiscoverRequest {
  transcript_id: string;
  base_prompt?: string;
  session_guide?: string;
  refinement_note?: string;
  excluded_ranges?: TimeRange[];
  max_clips?: number;
  min_duration?: number;
  max_duration?: number;
  language?: string;
  provider?: ProviderOverride | null;
}

export interface ClipProposal {
  start: number;
  end: number;
  title: string;
  rationale: string;
}

export interface DiscoverResponse {
  clips: ClipProposal[];
  model: string;
  excluded_ranges_applied: number;
}

export function discoverClips(
  body: DiscoverRequest,
  options?: RequestOptions,
): Promise<DiscoverResponse> {
  return request<DiscoverResponse>("/discover-clips", jsonBody(body), {
    timeoutMs: 5 * 60_000,
    ...options,
  });
}

/* -------------------------------------------------------------------------- */
/* 4. POST /verify-arabic                                                      */
/* -------------------------------------------------------------------------- */

export interface VerifyArabicRequest {
  arabic_text: string;
  context_thai?: string;
  provider?: ProviderOverride | null;
}

export interface VerifyArabicResponse {
  verified_text: string;
  correction_applied: boolean;
  notes: string;
  model: string;
}

export function verifyArabic(
  body: VerifyArabicRequest,
  options?: RequestOptions,
): Promise<VerifyArabicResponse> {
  // The sidecar's provider timeout is 120 s; give it headroom so the provider's
  // real error wins the race instead of a generic client-side timeout.
  return request<VerifyArabicResponse>("/verify-arabic", jsonBody(body), {
    timeoutMs: 180_000,
    ...options,
  });
}

/* -------------------------------------------------------------------------- */
/* 5. POST /fonts/import                                                       */
/* -------------------------------------------------------------------------- */

export interface FontInfo {
  family: string;
  style: string;
  path: string;
  format: string;
}

export interface FontImportResponse {
  imported_fonts: string[];
  fonts: FontInfo[];
  fonts_dir: string;
}

/** Upload `.ttf` / `.otf` files as multipart/form-data under `files`. */
export function importFonts(
  files: File[],
  options?: RequestOptions,
): Promise<FontImportResponse> {
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);
  return request<FontImportResponse>(
    "/fonts/import",
    { method: "POST", body: form },
    { timeoutMs: 60_000, ...options },
  );
}

/* -------------------------------------------------------------------------- */
/* 6. POST /render-batch (SSE)                                                 */
/* -------------------------------------------------------------------------- */

export interface RenderCue {
  start: number;
  end: number;
  arabic?: string;
  thai?: string;
}

export interface RenderClip {
  start: number;
  end: number;
  subtitles?: RenderCue[];
  title?: string;
  output_path?: string | null;
}

/**
 * Per-style overrides for the generated `.ass`. The field names must match the
 * sidecar's `StyleSpec` model exactly — unknown fields are silently dropped by
 * Pydantic, so a rename here would quietly disable the override.
 */
export interface StyleSpec {
  font?: string | null;
  size?: number | null;
  color?: string | null;
  outline?: number | null;
  shadow?: number | null;
  /** Per-style outline colour (`#RRGGBB`); defaults to the sidecar's black. */
  outline_color?: string | null;
  /**
   * Background box opacity, 0..1. `0` keeps the outline-only `BorderStyle 1`;
   * any value > 0 switches the style to an opaque box (`BorderStyle 3`) whose
   * BackColour alpha is derived from this value.
   */
  box_opacity?: number | null;
  /**
   * Harakat line-height padding (`>= 1`). ASS has no line-height field, so the
   * sidecar maps the extra leading to an equivalent upward shift of `MarginV`.
   */
  line_height_pad?: number | null;
  margin_v?: number | null;
  margin_l?: number | null;
  margin_r?: number | null;
  bold?: boolean | null;
}

export interface RenderBatchRequest {
  project_name?: string;
  source_path?: string | null;
  transcript_id?: string | null;
  clips: RenderClip[];
  resolution?: "1080x1920" | "1920x1080";
  framing?: "blur-fill" | "center-crop";
  use_nvenc?: boolean;
  export_srt?: boolean;
  output_dir?: string | null;
  filename_template?: string;
  subtitle_timebase?: "clip" | "source";
  styles?: { arabic?: StyleSpec; thai?: StyleSpec };
}

export type RenderEventName =
  | "start"
  | "progress"
  | "fallback"
  | "clip_done"
  | "clip_error"
  | "done";

/** The sidecar's resolved plan for one clip, announced by the `start` event. */
export interface RenderClipPlan {
  index: number;
  start: number;
  end: number;
  duration: number;
  outputPath: string;
  assPath: string;
  srtPath: string | null;
}

export interface RenderEvent {
  event: RenderEventName;
  jobId: string;
  status: string;
  /** Overall batch progress, 0..1. */
  progress: number;
  clipIndex?: number;
  clipCount?: number;
  clipProgress?: number;
  encoder?: string;
  failedEncoder?: string | null;
  reason?: string | null;
  stage?: string;
  outputPath?: string;
  srtPath?: string | null;
  detail?: string;
  elapsed?: number;
  renderedClips?: number;
  failedClips?: number;
  outputDir?: string;
  /** Resolved per-clip plan, announced once by the `start` event. */
  clips?: RenderClipPlan[];
}

interface RawRenderClipPlan {
  index?: number;
  start?: number;
  end?: number;
  duration?: number;
  output_path?: string;
  ass_path?: string;
  srt_path?: string | null;
}

interface RawRenderPayload {
  job_id?: string;
  status?: string;
  progress?: number;
  clip_index?: number;
  clip_count?: number;
  clip_progress?: number;
  encoder?: string;
  failed_encoder?: string | null;
  reason?: string | null;
  stage?: string;
  output_path?: string;
  srt_path?: string | null;
  detail?: string;
  elapsed?: number;
  rendered_clips?: number;
  failed_clips?: number;
  output_dir?: string;
  clips?: RawRenderClipPlan[];
}

function toRenderClipPlan(raw: RawRenderClipPlan): RenderClipPlan {
  return {
    index: raw.index ?? 0,
    start: raw.start ?? 0,
    end: raw.end ?? 0,
    duration: raw.duration ?? 0,
    outputPath: raw.output_path ?? "",
    assPath: raw.ass_path ?? "",
    srtPath: raw.srt_path ?? null,
  };
}

function toRenderEvent(event: RenderEventName, raw: RawRenderPayload): RenderEvent {
  return {
    event,
    jobId: raw.job_id ?? "",
    status: raw.status ?? "processing",
    progress: typeof raw.progress === "number" ? raw.progress : 0,
    clipIndex: raw.clip_index,
    clipCount: raw.clip_count,
    clipProgress: raw.clip_progress,
    encoder: raw.encoder,
    failedEncoder: raw.failed_encoder,
    reason: raw.reason,
    stage: raw.stage,
    outputPath: raw.output_path,
    srtPath: raw.srt_path,
    detail: raw.detail,
    elapsed: raw.elapsed,
    renderedClips: raw.rendered_clips,
    failedClips: raw.failed_clips,
    outputDir: raw.output_dir,
    clips: Array.isArray(raw.clips) ? raw.clips.map(toRenderClipPlan) : undefined,
  };
}

/**
 * Outcome of a render stream. `completed` is `true` only when the sidecar sent
 * its terminal `done` event; `false` means the stream closed early (sidecar
 * crash, dropped connection, proxy truncation) and the batch state is unknown.
 */
export interface RenderStreamResult {
  completed: boolean;
}

/**
 * Start a batch render and stream progress via Server-Sent Events.
 * Resolves when the stream closes, reporting whether a `done` event arrived;
 * individual clip failures arrive as events.
 */
export async function streamRenderBatch(
  body: RenderBatchRequest,
  onEvent: (event: RenderEvent) => void,
  signal?: AbortSignal,
): Promise<RenderStreamResult> {
  let response: Response;
  try {
    response = await fetch(`${SIDECAR_URL}/render-batch`, {
      ...jsonBody(body),
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      signal,
    });
  } catch (error) {
    // Offline / DNS / abort before the stream opens: surface the same
    // actionable message as the REST calls instead of a raw "Failed to fetch".
    throw toApiError(error);
  }
  if (!response.ok) throw await errorFromResponse(response);
  if (!response.body) throw new ApiError("The render stream returned no body.", 0);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;

  const flushChunk = (chunk: string) => {
    let event: RenderEventName = "progress";
    const dataLines: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim() as RenderEventName;
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    try {
      const payload = JSON.parse(dataLines.join("\n")) as RawRenderPayload;
      if (event === "done") completed = true;
      onEvent(toRenderEvent(event, payload));
    } catch {
      /* Ignore malformed frames; the stream keeps flowing. */
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        flushChunk(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
    }
    if (buffer.trim()) flushChunk(buffer);
  } catch (error) {
    // Network drop or abort mid-stream: normalise to ApiError like request().
    throw toApiError(error);
  }
  return { completed };
}

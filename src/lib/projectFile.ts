/**
 * `.tafseer` project file support: serialization, validation, disk I/O and the
 * localStorage auto-save journal that powers "Recent Lectures / Resume".
 *
 * Disk I/O prefers the File System Access API (available in Chromium/WebView2)
 * and falls back to an anchor download / file-input picker elsewhere.
 */

import {
  DEFAULT_EXPORT_SETTINGS,
  type InsertFit,
  type InsertRect,
  type MediaInsert,
  type ProjectClip,
  type ProjectData,
  type RecentProject,
  type SubtitleCue,
  type TranscriptData,
  type TranscriptWord,
  type WizardStep,
} from "./projectTypes";
import { DEFAULT_INSERT_RECT, MIN_INSERT_RECT_DIM } from "./insertTiming";
import { sanitizeWindowsFileName } from "./filenameTemplate";
import { MIN_RENDERABLE_CLIP_SECONDS } from "./clipMath";

export { MIN_RENDERABLE_CLIP_SECONDS };

export const PROJECT_FORMAT = "tafseer-project";
export const PROJECT_SCHEMA_VERSION = 1;
export const PROJECT_EXTENSION = ".tafseer";

interface TafseerFile {
  format: typeof PROJECT_FORMAT;
  schemaVersion: number;
  app: string;
  savedAt: string;
  project: ProjectData;
}

export function suggestProjectFileName(project: Pick<ProjectData, "name">): string {
  const base = (project.name || "untitled")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${base || "untitled"}${PROJECT_EXTENSION}`;
}

export function serializeProject(project: ProjectData, pretty = true): string {
  const file: TafseerFile = {
    format: PROJECT_FORMAT,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    app: "Tafseer Clipper",
    savedAt: new Date().toISOString(),
    project,
  };
  return pretty ? JSON.stringify(file, null, 2) : JSON.stringify(file);
}

/* -------------------------------------------------------------------------- */
/* Parsing / validation                                                        */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function normalizeStep(value: unknown): WizardStep {
  return value === 2 || value === 3 || value === 4 ? value : 1;
}

function normalizeCues(value: unknown): SubtitleCue[] {
  if (!Array.isArray(value)) return [];
  const cues: SubtitleCue[] = [];
  value.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    let start = Math.max(0, num(raw.start, 0));
    let end = Math.max(0, num(raw.end, start));
    if (end < start) [start, end] = [end, start];
    // A zero-length cue can never be burned in — drop it instead of keeping it.
    if (end - start <= 0) return;
    cues.push({
      id: str(raw.id, `cue-${index}`),
      start,
      end,
      arabic: str(raw.arabic),
      thai: str(raw.thai),
      ...(raw.reviewed === true ? { reviewed: true } : {}),
      ...(raw.edited === true ? { edited: true } : {}),
      ...(raw.source ? { source: str(raw.source) } : {}),
      ...(raw.reference ? { reference: str(raw.reference) } : {}),
      ...(typeof raw.confidence === "number" ? { confidence: raw.confidence } : {}),
      ...(raw.originalText ? { originalText: str(raw.originalText) } : {}),
      ...(raw.translation ? { translation: str(raw.translation) } : {}),
    });
  });
  return cues;
}

function normalizeInsertRect(value: unknown): InsertRect {
  if (!isRecord(value)) return { ...DEFAULT_INSERT_RECT };
  const width = Math.min(1, Math.max(MIN_INSERT_RECT_DIM, num(value.width, 1)));
  const height = Math.min(1, Math.max(MIN_INSERT_RECT_DIM, num(value.height, 1)));
  const x = Math.min(1 - width, Math.max(0, num(value.x, 0)));
  const y = Math.min(1 - height, Math.max(0, num(value.y, 0)));
  return { x, y, width, height };
}

function normalizeInsertFit(value: unknown, kind: "image" | "video"): InsertFit {
  if (value === "cover" || value === "blur-fill" || value === "contain") return value;
  return kind === "video" ? "cover" : "blur-fill";
}

function normalizeInserts(value: unknown): MediaInsert[] {
  if (!Array.isArray(value)) return [];
  const items: MediaInsert[] = [];
  value.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const kind = raw.kind === "image" ? "image" : raw.kind === "video" ? "video" : null;
    const path = str(raw.path).trim();
    if (!kind || !path) return;
    let start = Math.max(0, num(raw.start, 0));
    let end = Math.max(0, num(raw.end, start));
    if (end < start) [start, end] = [end, start];
    if (end - start <= 0) return;
    const sourceDuration =
      kind === "video" && typeof raw.sourceDuration === "number" && Number.isFinite(raw.sourceDuration) && raw.sourceDuration > 0
        ? raw.sourceDuration
        : null;
    const sourceStart =
      kind === "video" ? Math.max(0, num(raw.sourceStart, 0)) : 0;
    const fade =
      typeof raw.fade === "number" && Number.isFinite(raw.fade)
        ? Math.min(2, Math.max(0, raw.fade))
        : 0;
    items.push({
      id: str(raw.id, `insert-${index}`),
      kind,
      path,
      name: str(raw.name) || path.split(/[\\/]/).pop() || "insert",
      start,
      end,
      sourceStart,
      sourceDuration,
      rect: normalizeInsertRect(raw.rect),
      fit: normalizeInsertFit(raw.fit, kind),
      muted: raw.muted !== false,
      ...(fade > 0 ? { fade } : {}),
      ...(typeof raw.naturalWidth === "number" && Number.isFinite(raw.naturalWidth)
        ? { naturalWidth: raw.naturalWidth }
        : {}),
      ...(typeof raw.naturalHeight === "number" && Number.isFinite(raw.naturalHeight)
        ? { naturalHeight: raw.naturalHeight }
        : {}),
    });
  });
  return items.sort((a, b) => a.start - b.start || a.end - b.end);
}

function normalizeClips(value: unknown): ProjectClip[] {
  if (!Array.isArray(value)) return [];
  const clips: ProjectClip[] = [];
  value.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    let start = Math.max(0, num(raw.start, 0));
    let end = Math.max(0, num(raw.end, start));
    if (end < start) [start, end] = [end, start];
    // The sidecar rejects zero-length / sub-0.5 s clips with a 422 that fails
    // the whole batch, so a degenerate clip is dropped while loading.
    if (end - start < MIN_RENDERABLE_CLIP_SECONDS) return;
    let speechStart = Math.max(0, num(raw.speechStart, start));
    let speechEnd = Math.max(0, num(raw.speechEnd, end));
    if (speechEnd < speechStart) [speechStart, speechEnd] = [speechEnd, speechStart];
    clips.push({
      id: str(raw.id, `clip-${index}`),
      title: str(raw.title, `Clip ${index + 1}`),
      rationale: str(raw.rationale),
      start,
      end,
      speechStart,
      speechEnd,
      approved: raw.approved === true,
      createdAt: num(raw.createdAt, Date.now()),
    });
  });
  return clips;
}

function normalizeWords(value: unknown): TranscriptWord[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const words: TranscriptWord[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const text = str(item.text).trim();
    if (!text) continue;
    const start = typeof item.start === "number" && Number.isFinite(item.start) ? Math.max(0, item.start) : null;
    const end = typeof item.end === "number" && Number.isFinite(item.end) ? Math.max(0, item.end) : null;
    if (start === null || end === null) continue;
    words.push({ text, start, end: Math.max(start, end) });
  }
  return words.length > 0 ? words : undefined;
}

function normalizeTranscript(value: unknown): TranscriptData | null {
  if (!isRecord(value) || !Array.isArray(value.segments)) return null;
  return {
    language: strOrNull(value.language),
    languageProbability:
      typeof value.languageProbability === "number" ? value.languageProbability : null,
    segments: value.segments.filter(isRecord).map((segment, index) => {
      const words = normalizeWords(segment.words);
      return {
        id: num(segment.id, index),
        start: num(segment.start, 0),
        end: num(segment.end, 0),
        text: str(segment.text),
        language: strOrNull(segment.language),
        ...(typeof segment.sentence_id === "number"
          ? { sentence_id: segment.sentence_id }
          : {}),
        ...(typeof segment.source === "string" ? { source: segment.source } : {}),
        ...(typeof segment.reference === "string" ? { reference: segment.reference } : {}),
        ...(typeof segment.confidence === "number"
          ? { confidence: segment.confidence }
          : {}),
        ...(typeof segment.original_text === "string"
          ? { original_text: segment.original_text }
          : {}),
        ...(typeof segment.translation === "string"
          ? { translation: segment.translation }
          : {}),
        ...(words ? { words } : {}),
      };
    }),
    // Keep the precomputed waveform envelope so a resumed project does not have
    // to decode the 16 kHz WAV again; drop non-finite samples.
    peaks: Array.isArray(value.peaks)
      ? value.peaks.filter((peak): peak is number => typeof peak === "number" && Number.isFinite(peak))
      : undefined,
  };
}

function normalizeProject(raw: unknown): ProjectData {
  if (!isRecord(raw)) throw new Error("The project payload is not an object.");
  if (!isRecord(raw.project)) {
    throw new Error("This file does not contain a .tafseer project.");
  }
  const project = raw.project;
  const exportRaw = isRecord(project.export) ? project.export : {};

  const subtitles: Record<string, SubtitleCue[]> = {};
  if (isRecord(project.subtitles)) {
    for (const [clipId, cues] of Object.entries(project.subtitles)) {
      subtitles[clipId] = normalizeCues(cues);
    }
  }

  let inserts: Record<string, MediaInsert[]> | undefined;
  if (isRecord(project.inserts)) {
    const parsedInserts: Record<string, MediaInsert[]> = {};
    for (const [clipId, list] of Object.entries(project.inserts)) {
      const normalized = normalizeInserts(list);
      if (normalized.length > 0) parsedInserts[clipId] = normalized;
    }
    if (Object.keys(parsedInserts).length > 0) inserts = parsedInserts;
  }

  return {
    schemaVersion: 1,
    id: str(project.id) || crypto.randomUUID(),
    name: str(project.name, "Untitled session"),
    sourcePath: strOrNull(project.sourcePath),
    sourceFileName: strOrNull(project.sourceFileName),
    // Additive field: absent in every project saved before it existed.
    ...(typeof project.sourceSize === "number" && Number.isFinite(project.sourceSize)
      ? { sourceSize: project.sourceSize }
      : {}),
    duration:
      typeof project.duration === "number" && Number.isFinite(project.duration)
        ? project.duration
        : null,
    step: normalizeStep(project.step),
    transcriptId: strOrNull(project.transcriptId),
    transcript: normalizeTranscript(project.transcript),
    audioPath: strOrNull(project.audioPath),
    basePrompt: str(project.basePrompt),
    promptPresetId: strOrNull(project.promptPresetId),
    sessionGuide: str(project.sessionGuide),
    clips: normalizeClips(project.clips),
    // Additive field: absent in every project saved before it existed.
    trashedClips: normalizeClips(project.trashedClips).slice(-20),
    selectedClipId: strOrNull(project.selectedClipId),
    subtitles,
    ...(inserts ? { inserts } : {}),
    export: {
      resolution:
        exportRaw.resolution === "1920x1080" ? "1920x1080" : DEFAULT_EXPORT_SETTINGS.resolution,
      framing: exportRaw.framing === "center-crop" ? "center-crop" : "blur-fill",
      useNvenc: exportRaw.useNvenc !== false,
      exportSrt: exportRaw.exportSrt !== false,
      filenameTemplate: str(
        exportRaw.filenameTemplate,
        DEFAULT_EXPORT_SETTINGS.filenameTemplate,
      ),
      outputDir: strOrNull(exportRaw.outputDir),
    },
    createdAt: num(project.createdAt, Date.now()),
    updatedAt: num(project.updatedAt, Date.now()),
    // Sessions saved before this field existed inherit updatedAt so their
    // Today/Yesterday grouping keeps working.
    lastActivityAt: num(project.lastActivityAt, num(project.updatedAt, Date.now())),
  };
}

export function parseProjectFile(text: string): ProjectData {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("This file is not valid JSON.");
  }
  if (!isRecord(payload) || payload.format !== PROJECT_FORMAT) {
    throw new Error("This is not a Tafseer Clipper .tafseer project file.");
  }
  if (num(payload.schemaVersion, 0) > PROJECT_SCHEMA_VERSION) {
    throw new Error(
      "This project was saved by a newer app version. Update Tafseer Clipper and try again.",
    );
  }
  return normalizeProject(payload);
}

export function toRecentProject(project: ProjectData): RecentProject {
  return {
    id: project.id,
    name: project.name,
    sourceFileName: project.sourceFileName,
    step: project.step,
    duration: project.duration,
    clipCount: project.clips.length,
    updatedAt: project.updatedAt,
    lastActivityAt: project.lastActivityAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Disk I/O                                                                    */
/* -------------------------------------------------------------------------- */

interface SaveFileHandle {
  createWritable(): Promise<{
    write(data: string | Blob): Promise<void>;
    close(): Promise<void>;
  }>;
}

interface OpenFileHandle {
  getFile(): Promise<File>;
}

interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

interface WindowWithFileSystemAccess extends Window {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: FilePickerAcceptType[];
  }) => Promise<SaveFileHandle>;
  showOpenFilePicker?: (options?: {
    types?: FilePickerAcceptType[];
    multiple?: boolean;
  }) => Promise<OpenFileHandle[]>;
}

const PROJECT_PICKER_TYPES: FilePickerAcceptType[] = [
  {
    description: "Tafseer Clipper project",
    accept: { "application/json": [PROJECT_EXTENSION] },
  },
];

function downloadText(
  text: string,
  fileName: string,
  mimeType = "application/json",
): void {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

export interface SaveTextOptions {
  /** Browser file-picker description for the type. */
  description: string;
  /** Desktop save-dialog filter label, e.g. `Tafseer Project (*.tafseer)`. */
  filterName: string;
  /** Extension without the dot, e.g. `tafseer`. */
  extension: string;
  /** MIME type used by the anchor-download fallback. */
  mimeType: string;
}

async function writeProjectAtomicDesktop(filePath: string, contents: string): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("write_project_file_atomic", { path: filePath, contents });
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missingCommand =
      /command\s+write_project_file_atomic\s+not\s+found|unknown\s+command/i.test(message);
    if (!missingCommand) throw error;
  }
  const fs = await import("@tauri-apps/plugin-fs");
  await fs.writeTextFile(filePath, contents);
}

/**
 * Save a text file through the same chain as projects: desktop save dialog →
 * File System Access picker → anchor download. Returns `"saved"` or
 * `"cancelled"` (picker dismissed).
 */
export async function saveTextFile(
  text: string,
  fileName: string,
  options: SaveTextOptions,
): Promise<"saved" | "cancelled"> {
  if (isDesktopRuntime()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const selected = await save({
      defaultPath: fileName,
      filters: [{ name: options.filterName, extensions: [options.extension] }],
    });
    if (!selected) return "cancelled";
    if (options.extension === "tafseer") {
      await writeProjectAtomicDesktop(selected, text);
    } else {
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(selected, text);
    }
    return "saved";
  }

  const picker = (window as WindowWithFileSystemAccess).showSaveFilePicker;

  if (typeof picker === "function") {
    try {
      const handle = await picker.call(window, {
        suggestedName: fileName,
        types: [
          {
            description: options.description,
            accept: { [options.mimeType]: [`.${options.extension}`] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      return "saved";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
      throw error;
    }
  }

  downloadText(text, fileName, options.mimeType);
  return "saved";
}

/**
 * Save the project to disk. Returns `"saved"` or `"cancelled"` (picker dismissed).
 */
export async function saveProjectFile(project: ProjectData): Promise<"saved" | "cancelled"> {
  return saveTextFile(serializeProject(project), suggestProjectFileName(project), {
    description: "Tafseer Clipper project",
    filterName: "Tafseer Project (*.tafseer)",
    extension: "tafseer",
    mimeType: "application/json",
  });
}

function pickFileWithInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = `${PROJECT_EXTENSION},application/json`;
    input.style.display = "none";
    input.addEventListener("change", () => {
      const file = input.files?.[0] ?? null;
      input.remove();
      resolve(file);
    });
    input.addEventListener("cancel", () => {
      input.remove();
      resolve(null);
    });
    document.body.appendChild(input);
    input.click();
  });
}

/** Open a `.tafseer` file from disk. Returns `null` when the picker is dismissed. */
export async function openProjectFile(): Promise<ProjectData | null> {
  if (isDesktopRuntime()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const selected = await open({
      filters: [{ name: "Tafseer Project (*.tafseer)", extensions: ["tafseer"] }],
      multiple: false,
    });
    if (!selected || Array.isArray(selected)) {
      if (!selected) return null;
    }
    const path = Array.isArray(selected) ? selected[0] : selected;
    if (!path) return null;
    return parseProjectFile(await readTextFile(path));
  }

  const picker = (window as WindowWithFileSystemAccess).showOpenFilePicker;

  if (typeof picker === "function") {
    try {
      const [handle] = await picker.call(window, {
        types: PROJECT_PICKER_TYPES,
        multiple: false,
      });
      if (!handle) return null;
      const file = await handle.getFile();
      return parseProjectFile(await file.text());
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return null;
      throw error;
    }
  }

  const file = await pickFileWithInput();
  if (!file) return null;
  return parseProjectFile(await file.text());
}

/* -------------------------------------------------------------------------- */
/* Auto-save journal (localStorage)                                            */
/* -------------------------------------------------------------------------- */

const AUTOSAVE_PREFIX = "tafseer.autosave.v1.";

function autosaveKey(projectId: string): string {
  return `${AUTOSAVE_PREFIX}${projectId}`;
}

export function writeAutosave(project: ProjectData): boolean {
  // In the desktop runtime the full `.tafseer` state lives on disk (see
  // writeAutosaveFile); localStorage only keeps the lightweight session index.
  if (isDesktopRuntime()) return true;
  try {
    localStorage.setItem(
      autosaveKey(project.id),
      serializeProject({ ...project, updatedAt: Date.now() }),
    );
    return true;
  } catch (error) {
    // Browser fallback: evict oldest full-project payloads on quota exhaustion.
    if (error instanceof DOMException && error.name === "QuotaExceededError") {
      try {
        const keys: string[] = [];
        for (let i = 0; i < localStorage.length; i += 1) {
          const key = localStorage.key(i);
          if (key?.startsWith(AUTOSAVE_PREFIX)) keys.push(key);
        }
        // Keep at most 3 full projects: drop the oldest by key order heuristic.
        keys.sort();
        while (keys.length > 3) {
          const oldest = keys.shift();
          if (oldest) localStorage.removeItem(oldest);
        }
        localStorage.setItem(
          autosaveKey(project.id),
          serializeProject({ ...project, updatedAt: Date.now() }),
        );
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

export function readAutosave(projectId: string): ProjectData | null {
  try {
    const raw = localStorage.getItem(autosaveKey(projectId));
    if (!raw) return null;
    return parseProjectFile(raw);
  } catch {
    return null;
  }
}

export function deleteAutosave(projectId: string): void {
  try {
    localStorage.removeItem(autosaveKey(projectId));
  } catch {
    /* Storage unavailable — nothing to clean up. */
  }
}

export function listAutosavedProjectIds(): string[] {
  const ids: string[] = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(AUTOSAVE_PREFIX)) ids.push(key.slice(AUTOSAVE_PREFIX.length));
    }
  } catch {
    /* Storage unavailable. */
  }
  return ids;
}

/* -------------------------------------------------------------------------- */
/* Durable auto-save (Tauri plugin-fs)                                         */
/* -------------------------------------------------------------------------- */

/**
 * `true` when the renderer runs inside the Tauri shell, where `plugin-fs` is
 * available. Plain-browser builds skip disk auto-save entirely.
 */
export function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Default folder under `<appLocalDataDir>` used when Settings sets no folder. */
const DISK_AUTOSAVE_FOLDER = "projects";

/** Maps a project id to the last disk path written, so reads need no listing. */
const AUTOSAVE_PATH_PREFIX = "tafseer.autosave.disk.v1.";

function autosavePathKey(projectId: string): string {
  return `${AUTOSAVE_PATH_PREFIX}${projectId}`;
}

function rememberAutosavePath(projectId: string, filePath: string): void {
  try {
    localStorage.setItem(autosavePathKey(projectId), filePath);
  } catch {
    /* Storage unavailable — reads can still fall back to the derived name. */
  }
}

function readRememberedAutosavePath(projectId: string): string | null {
  try {
    return localStorage.getItem(autosavePathKey(projectId));
  } catch {
    return null;
  }
}

function forgetAutosavePath(projectId: string): void {
  try {
    localStorage.removeItem(autosavePathKey(projectId));
  } catch {
    /* Storage unavailable — nothing to clean up. */
  }
}

function shortProjectId(projectId: string): string {
  return projectId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "project";
}

/** `<sanitized name>-<short id>.tafseer` — the durable auto-save file name. */
export function diskAutosaveFileName(project: Pick<ProjectData, "id" | "name">): string {
  const base = sanitizeWindowsFileName(project.name, "project").slice(0, 80);
  return `${base}-${shortProjectId(project.id)}${PROJECT_EXTENSION}`;
}

/** `storage.projectFolder` when set, else `<appLocalDataDir>/projects`. */
async function resolveAutosaveFolder(projectFolder: string): Promise<string> {
  const trimmed = projectFolder.trim();
  if (trimmed) return trimmed;
  const { appLocalDataDir, join } = await import("@tauri-apps/api/path");
  return join(await appLocalDataDir(), DISK_AUTOSAVE_FOLDER);
}

/**
 * Write a compact `.tafseer` snapshot to the durable auto-save folder.
 * Returns the absolute path; throws when the write fails so the store can
 * surface `lastAutosaveError`. Only call this from {@link isDesktopRuntime}.
 */
export async function writeAutosaveFile(
  project: ProjectData,
  projectFolder: string,
): Promise<string> {
  const fs = await import("@tauri-apps/plugin-fs");
  const { join, appLocalDataDir } = await import("@tauri-apps/api/path");
  const trimmed = projectFolder.trim();

  // Try to grant scope for a user-selected folder on any drive (TAU-01).
  let primaryFolder = trimmed;
  let usedFallback = false;
  if (trimmed) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("grant_project_folder_scope", { folderPath: trimmed });
    } catch {
      primaryFolder = "";
    }
  }

  const fallbackFolder = await join(await appLocalDataDir(), DISK_AUTOSAVE_FOLDER);

  const writeOnce = async (folder: string): Promise<string> => {
    await fs.mkdir(folder, { recursive: true });
    const filePath = await join(folder, diskAutosaveFileName(project));
    await writeProjectAtomicDesktop(
      filePath,
      serializeProject({ ...project, updatedAt: Date.now() }, false),
    );
    rememberAutosavePath(project.id, filePath);
    return filePath;
  };

  if (primaryFolder) {
    try {
      return await writeOnce(primaryFolder);
    } catch {
      usedFallback = true;
      // Fall through to the local backup folder.
    }
  } else if (trimmed) {
    usedFallback = true;
  }

  const savedPath = await writeOnce(fallbackFolder);
  if (usedFallback) {
    throw new Error("Custom folder not writable; saved to local backup");
  }
  return savedPath;
}

/**
 * Read the durable auto-save for a project. Never throws: returns `null` when
 * the app is not running in Tauri, the file is missing, or the payload is bad.
 */
export async function readAutosaveFile(
  projectId: string,
  projectFolder: string,
  projectName?: string,
): Promise<ProjectData | null> {
  if (!isDesktopRuntime()) return null;
  try {
    const fs = await import("@tauri-apps/plugin-fs");
    const { join } = await import("@tauri-apps/api/path");
    const folder = await resolveAutosaveFolder(projectFolder);
    const candidates: string[] = [];
    const remembered = readRememberedAutosavePath(projectId);
    if (remembered) candidates.push(remembered);
    if (projectName !== undefined) {
      candidates.push(
        await join(folder, diskAutosaveFileName({ id: projectId, name: projectName })),
      );
    }
    for (const filePath of candidates) {
      try {
        if (!(await fs.exists(filePath))) continue;
        const project = parseProjectFile(await fs.readTextFile(filePath));
        rememberAutosavePath(projectId, filePath);
        return project;
      } catch {
        /* Try the next candidate if one copy is missing or unreadable. */
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Delete the durable auto-save for a project. Never throws: returns `true` when
 * at least one file was removed.
 */
export async function deleteAutosaveFile(
  projectId: string,
  projectFolder: string,
  projectName?: string,
): Promise<boolean> {
  if (!isDesktopRuntime()) return false;
  try {
    const fs = await import("@tauri-apps/plugin-fs");
    const { join } = await import("@tauri-apps/api/path");
    const folder = await resolveAutosaveFolder(projectFolder);
    const candidates = new Set<string>();
    const remembered = readRememberedAutosavePath(projectId);
    if (remembered) candidates.add(remembered);
    if (projectName !== undefined) {
      candidates.add(await join(folder, diskAutosaveFileName({ id: projectId, name: projectName })));
    }
    let removed = false;
    for (const filePath of candidates) {
      try {
        if (await fs.exists(filePath)) {
          await fs.remove(filePath);
          removed = true;
        }
      } catch {
        /* Keep trying the remaining candidates. */
      }
    }
    forgetAutosavePath(projectId);
    return removed;
  } catch {
    return false;
  }
}

/**
 * `.tafseer` project file support: serialization, validation, disk I/O and the
 * localStorage auto-save journal that powers "Recent Lectures / Resume".
 *
 * Disk I/O prefers the File System Access API (available in Chromium/WebView2)
 * and falls back to an anchor download / file-input picker elsewhere.
 */

import {
  DEFAULT_DISCOVERY_SETTINGS,
  DEFAULT_EXPORT_SETTINGS,
  type DiscoverySettings,
  type ProjectClip,
  type ProjectData,
  type RecentProject,
  type SubtitleCue,
  type TranscriptData,
  type WizardStep,
} from "./projectTypes";
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeDiscovery(value: unknown): DiscoverySettings {
  const raw = isRecord(value) ? value : {};
  const minDuration = clamp(
    num(raw.minDuration, DEFAULT_DISCOVERY_SETTINGS.minDuration),
    5,
    600,
  );
  const maxDuration = clamp(
    num(raw.maxDuration, DEFAULT_DISCOVERY_SETTINGS.maxDuration),
    minDuration + 1,
    1800,
  );
  const maxClips = Math.round(
    clamp(num(raw.maxClips, DEFAULT_DISCOVERY_SETTINGS.maxClips), 1, 50),
  );
  return { minDuration, maxDuration, maxClips };
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
      ...(raw.source ? { source: str(raw.source) } : {}),
      ...(raw.reference ? { reference: str(raw.reference) } : {}),
      ...(typeof raw.confidence === "number" ? { confidence: raw.confidence } : {}),
      ...(raw.originalText ? { originalText: str(raw.originalText) } : {}),
      ...(raw.translation ? { translation: str(raw.translation) } : {}),
    });
  });
  return cues;
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

function normalizeTranscript(value: unknown): TranscriptData | null {
  if (!isRecord(value) || !Array.isArray(value.segments)) return null;
  return {
    language: strOrNull(value.language),
    languageProbability:
      typeof value.languageProbability === "number" ? value.languageProbability : null,
    segments: value.segments.filter(isRecord).map((segment, index) => ({
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
    })),
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

  return {
    schemaVersion: 1,
    id: str(project.id) || crypto.randomUUID(),
    name: str(project.name, "Untitled session"),
    sourcePath: strOrNull(project.sourcePath),
    sourceFileName: strOrNull(project.sourceFileName),
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
    discovery: normalizeDiscovery(project.discovery),
    clips: normalizeClips(project.clips),
    // Additive field: absent in every project saved before it existed.
    trashedClips: normalizeClips(project.trashedClips).slice(-20),
    selectedClipId: strOrNull(project.selectedClipId),
    subtitles,
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

function downloadText(text: string, fileName: string): void {
  const blob = new Blob([text], { type: "application/json" });
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

/**
 * Save the project to disk. Returns `"saved"` or `"cancelled"` (picker dismissed).
 */
export async function saveProjectFile(project: ProjectData): Promise<"saved" | "cancelled"> {
  const text = serializeProject(project);
  const fileName = suggestProjectFileName(project);
  const picker = (window as WindowWithFileSystemAccess).showSaveFilePicker;

  if (typeof picker === "function") {
    try {
      const handle = await picker.call(window, {
        suggestedName: fileName,
        types: PROJECT_PICKER_TYPES,
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

  downloadText(text, fileName);
  return "saved";
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
  try {
    localStorage.setItem(
      autosaveKey(project.id),
      serializeProject({ ...project, updatedAt: Date.now() }),
    );
    return true;
  } catch {
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
  const { join } = await import("@tauri-apps/api/path");
  const folder = await resolveAutosaveFolder(projectFolder);
  await fs.mkdir(folder, { recursive: true });
  const filePath = await join(folder, diskAutosaveFileName(project));
  // Auto-save is written often, so skip the pretty-printing used for manual saves.
  await fs.writeTextFile(
    filePath,
    serializeProject({ ...project, updatedAt: Date.now() }, false),
  );
  rememberAutosavePath(project.id, filePath);
  return filePath;
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
      if (!(await fs.exists(filePath))) continue;
      const project = parseProjectFile(await fs.readTextFile(filePath));
      rememberAutosavePath(projectId, filePath);
      return project;
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

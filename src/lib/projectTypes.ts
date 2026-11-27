/**
 * Project domain types shared by the Zustand stores, the `.tafseer` file
 * serializer and the React shell. Kept dependency-free so both the store layer
 * and the file layer can import it without cycles.
 */

export type WizardStep = 1 | 2 | 3 | 4;

export type AspectRatio = "16:9" | "9:16";

export type FramingMode = "blur-fill" | "center-crop";

/** One label per framing concept, shared by Steps 3 and 4 (panel + queue rows). */
export const FRAMING_LABELS: Record<FramingMode, string> = {
  "blur-fill": "Blur fill",
  "center-crop": "Center crop",
};

export type Resolution = "1920x1080" | "1080x1920";

export interface TranscriptWord {
  text: string;
  start: number;
  end: number;
}

export interface TranscriptSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  language?: string | null;
  /** Stage-1 enrichment: sentence group for Thai lines. */
  sentence_id?: number | null;
  /** Arabic passage provenance: quran | hadith | quote | stt. */
  source?: string | null;
  /** Qur'an/hadith reference hint, e.g. "2:153". */
  reference?: string | null;
  confidence?: number | null;
  /** The original Thai transliteration, kept for Restore. */
  original_text?: string | null;
  /** Qur'an translation used as a review reference (never burned in). */
  translation?: string | null;
  /** Optional word-level timestamps from STT. */
  words?: TranscriptWord[] | null;
}

export interface TranscriptData {
  language: string | null;
  languageProbability?: number | null;
  segments: TranscriptSegment[];
  /**
   * Downsampled waveform envelope (0..1) returned by `/extract-and-transcribe`.
   * Lets the Step-2 waveform render without decoding the full PCM WAV in memory.
   */
  peaks?: number[];
}

export interface ProjectClip {
  id: string;
  title: string;
  rationale: string;
  /** Final cut start in seconds: the speech start minus the auto-pad buffer. */
  start: number;
  /** Final cut end in seconds: the speech end plus the auto-pad buffer. */
  end: number;
  /** Raw speech bounds proposed by the AI, before the cut buffer is applied. */
  speechStart: number;
  speechEnd: number;
  approved: boolean;
  createdAt: number;
}

export interface SubtitleCue {
  id: string;
  start: number;
  end: number;
  arabic: string;
  thai: string;
  /** The editor has proof-read this line. Cleared when the text is edited. */
  reviewed?: boolean;
  /** The editor manually modified, split, merged, or retimed this line. */
  edited?: boolean;
  /** Arabic-only cue provenance (Quran verification / AI suggestion). */
  source?: string;
  reference?: string;
  confidence?: number;
  originalText?: string;
  /** Review-only translation; not rendered in the burn-in. */
  translation?: string;
}

export type InsertKind = "image" | "video";

export type InsertFit = "cover" | "blur-fill" | "contain";

/** Normalized 0..1 position and size inside the export canvas. */
export interface InsertRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MediaInsert {
  id: string;
  kind: InsertKind;
  path: string;
  name: string;
  /** Clip-relative start in seconds. */
  start: number;
  /** Clip-relative end in seconds. */
  end: number;
  /** Offset into the insert video when trimmed from the front (seconds, 0 for images). */
  sourceStart: number;
  /** Natural video duration in seconds, or null for still images. */
  sourceDuration: number | null;
  rect: InsertRect;
  fit: InsertFit;
  /** Muted by default so the lecturer's audio remains uninterrupted. */
  muted: boolean;
  /** Optional fade in/out duration in seconds (0 = hard cut). */
  fade?: number;
  naturalWidth?: number | null;
  naturalHeight?: number | null;
}

export interface ProjectExportSettings {
  resolution: Resolution;
  framing: FramingMode;
  useNvenc: boolean;
  exportSrt: boolean;
  filenameTemplate: string;
  outputDir: string | null;
}

export interface ProjectData {
  /** `.tafseer` schema version for forward/backward compatibility. */
  schemaVersion: 1;
  id: string;
  name: string;
  sourcePath: string | null;
  sourceFileName: string | null;
  /**
   * Source file size in bytes, when known. Additive: lets a future reconnect
   * match a moved lecture on another volume by size. Absent in older projects.
   */
  sourceSize?: number | null;
  /** Lecture duration in seconds, when known. */
  duration: number | null;
  step: WizardStep;
  transcriptId: string | null;
  transcript: TranscriptData | null;
  /**
   * 16 kHz mono WAV extracted by the sidecar. Kept for the project record;
   * the Step 2 waveform renders from `transcript.peaks` instead.
   */
  audioPath: string | null;
  basePrompt: string;
  promptPresetId: string | null;
  sessionGuide: string;
  clips: ProjectClip[];
  /**
   * Clips the editor explicitly discarded, most recent last (capped). They are
   * never shown or rendered; they only travel with a re-roll request as
   * `rejected_exemplars` so the AI learns what to avoid. Optional so projects
   * saved before this field still load.
   */
  trashedClips?: ProjectClip[];
  selectedClipId: string | null;
  /** Clip id -> bilingual cues. */
  subtitles: Record<string, SubtitleCue[]>;
  /** Clip id -> visual insert footage (images or videos) layered over the lecture. */
  inserts?: Record<string, MediaInsert[]>;
  export: ProjectExportSettings;
  createdAt: number;
  updatedAt: number;
  /**
   * Clock of real workflow activity (edits, step changes). Deliberately not
   * the auto-save clock: opening or re-saving a session never advances it, so
   * the sidebar's Today/Yesterday groups reflect actual work.
   */
  lastActivityAt: number;
}

export interface RecentProject {
  id: string;
  name: string;
  sourceFileName: string | null;
  step: WizardStep;
  duration: number | null;
  clipCount: number;
  updatedAt: number;
  /** Mirrors `ProjectData.lastActivityAt`; falls back to `updatedAt`. */
  lastActivityAt: number;
}

export const DEFAULT_EXPORT_SETTINGS: ProjectExportSettings = {
  resolution: "1080x1920",
  framing: "blur-fill",
  useNvenc: true,
  exportSrt: true,
  filenameTemplate: "{LectureName}_Clip{01}_{Title}.mp4",
  outputDir: null,
};

export const STEP_LABELS: Record<WizardStep, string> = {
  1: "Upload",
  2: "Find Clips",
  3: "Subtitles",
  4: "Export",
};

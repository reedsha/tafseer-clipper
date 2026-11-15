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

export interface TranscriptSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  language?: string | null;
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

/** Per-project clip discovery bounds, usually seeded by a prompt preset. */
export interface DiscoverySettings {
  minDuration: number;
  maxDuration: number;
  maxClips: number;
}

export const DEFAULT_DISCOVERY_SETTINGS: DiscoverySettings = {
  minDuration: 15,
  maxDuration: 90,
  maxClips: 8,
};

export interface SubtitleCue {
  id: string;
  start: number;
  end: number;
  arabic: string;
  thai: string;
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
  /** Lecture duration in seconds, when known. */
  duration: number | null;
  step: WizardStep;
  transcriptId: string | null;
  transcript: TranscriptData | null;
  /** 16 kHz mono WAV extracted by the sidecar; feeds the Step 2 waveform. */
  audioPath: string | null;
  basePrompt: string;
  promptPresetId: string | null;
  sessionGuide: string;
  discovery: DiscoverySettings;
  clips: ProjectClip[];
  selectedClipId: string | null;
  /** Clip id -> bilingual cues. */
  subtitles: Record<string, SubtitleCue[]>;
  export: ProjectExportSettings;
  createdAt: number;
  updatedAt: number;
}

export interface RecentProject {
  id: string;
  name: string;
  sourceFileName: string | null;
  step: WizardStep;
  duration: number | null;
  clipCount: number;
  updatedAt: number;
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

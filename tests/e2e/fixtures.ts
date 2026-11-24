/**
 * Shared fixtures for the release E2E suite.
 *
 * The project-flow spec must start at Step 2 with a transcript and two clips,
 * exactly as a resumed auto-save would. Rather than driving Step 1 (which would
 * require a real lecture file and Whisper), the spec seeds the same localStorage
 * journal the app writes: `tafseer.projects.v1` (Recent Lectures index) and
 * `tafseer.autosave.v1.<id>` (the `.tafseer` snapshot).
 */

import type { Page } from "@playwright/test";

export const PROJECT_ID = "e2e00000-0000-4000-8000-000000000001";
export const CLIP1_ID = "e2e00000-0000-4000-8000-0000000000c1";
export const CLIP2_ID = "e2e00000-0000-4000-8000-0000000000c2";
export const PROJECT_NAME = "Tafseer-Lecture-01";
export const SOURCE_PATH = "C:/Lectures/Tafseer-Lecture-01.mp4";

/** Thai text used for the Ctrl+Enter split; shorter than maxCharsPerLine (40). */
export const THAI_CUE = "ทดสอบการแบ่งซับไทเทิลสองบล็อก";

const NOW = Date.now();

const RECENT = [
  {
    id: PROJECT_ID,
    name: PROJECT_NAME,
    sourceFileName: "Tafseer-Lecture-01.mp4",
    step: 2,
    duration: 1800,
    clipCount: 2,
    updatedAt: NOW,
  },
];

const PROJECT = {
  schemaVersion: 1,
  id: PROJECT_ID,
  name: PROJECT_NAME,
  sourcePath: SOURCE_PATH,
  sourceFileName: "Tafseer-Lecture-01.mp4",
  duration: 1800,
  step: 2,
  transcriptId: "e2e-transcript",
  transcript: {
    language: "th",
    languageProbability: 0.98,
    segments: [
      // One segment inside clip 1, so Step 3 seeds exactly one cue to split.
      {
        id: 1,
        start: 10.5,
        // A short segment keeps this flow at one seeded cue; the fragmented
        // transcript case is covered by tests/e2e/subtitles.spec.ts.
        end: 16.5,
        text: "ความอดทนเป็นครึ่งหนึ่งของความศรัทธา",
        language: "th",
      },
      {
        id: 2,
        start: 100.5,
        end: 128.5,
        text: "การบริจาคอย่างลับๆ ดีกว่าการบริจาคอย่างเปิดเผย",
        language: "th",
      },
    ],
  },
  audioPath: null,
  basePrompt: "",
  promptPresetId: null,
  sessionGuide: "",
  clips: [
    {
      id: CLIP1_ID,
      title: "The patience of Ayyub",
      rationale: "A clear lesson on sabr from the story of Ayyub.",
      start: 10,
      end: 40,
      speechStart: 10.3,
      speechEnd: 39.7,
      approved: false,
      createdAt: NOW,
    },
    {
      id: CLIP2_ID,
      title: "Charity in secret",
      rationale: "A practical ruling on giving without showing off.",
      start: 100,
      end: 130,
      speechStart: 100.3,
      speechEnd: 129.7,
      approved: false,
      createdAt: NOW,
    },
  ],
  selectedClipId: CLIP1_ID,
  subtitles: {},
  export: {
    resolution: "1080x1920",
    framing: "blur-fill",
    useNvenc: true,
    exportSrt: true,
    filenameTemplate: "{LectureName}_Clip{01}_{Title}.mp4",
    outputDir: null,
  },
  createdAt: NOW,
  updatedAt: NOW,
  lastActivityAt: NOW,
};

const AUTOSAVE = {
  format: "tafseer-project",
  schemaVersion: 1,
  app: "Tafseer Clipper",
  savedAt: new Date(NOW).toISOString(),
  project: PROJECT,
};

/**
 * Seed the Recent Lectures index and the `.tafseer` auto-save before the app
 * boots. The init script runs before every page script on the app origin.
 */
export async function seedResumableProject(page: Page): Promise<void> {
  await page.addInitScript(
    (seed) => {
      if (window.location.protocol !== "http:") return;
      window.localStorage.setItem(
        "tafseer.projects.v1",
        JSON.stringify({ state: { recentProjects: seed.recent }, version: 2 }),
      );
      window.localStorage.setItem(
        `tafseer.autosave.v1.${seed.projectId}`,
        JSON.stringify(seed.autosave),
      );
    },
    { projectId: PROJECT_ID, recent: RECENT, autosave: AUTOSAVE },
  );
}

/**
 * Seed any project payload at boot. Used by focused specs (for example the
 * fragmented-transcript subtitle seeding) that do not need the full flow.
 */
export async function seedProjectFile(
  page: Page,
  project: Record<string, unknown>,
): Promise<void> {
  const now = Date.now();
  const clips = Array.isArray(project.clips) ? project.clips : [];
  const recent = {
    id: String(project.id),
    name: String(project.name),
    sourceFileName: (project.sourceFileName as string | null) ?? null,
    step: (project.step as number | undefined) ?? 1,
    duration: (project.duration as number | null) ?? null,
    clipCount: clips.length,
    updatedAt: now,
  };
  const autosave = {
    format: "tafseer-project",
    schemaVersion: 1,
    app: "Tafseer Clipper",
    savedAt: new Date(now).toISOString(),
    project,
  };

  await page.addInitScript(
    (seed) => {
      if (window.location.protocol !== "http:") return;
      window.localStorage.setItem(
        "tafseer.projects.v1",
        JSON.stringify({ state: { recentProjects: [seed.recent] }, version: 2 }),
      );
      window.localStorage.setItem(
        `tafseer.autosave.v1.${seed.projectId}`,
        JSON.stringify(seed.autosave),
      );
    },
    { recent, autosave, projectId: recent.id },
  );
}

/* -------------------------------------------------------------------------- */
/* Mocked `/render-batch` SSE stream                                           */
/* -------------------------------------------------------------------------- */

function sseFrame(event: string, payload: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}`;
}

const OUTPUT_DIR = "C:/Users/Public/Tafseer/exports";
const OUTPUT_MP4 = `${OUTPUT_DIR}/Tafseer-Lecture-01_Clip01_The patience of Ayyub.mp4`;
const OUTPUT_SRT = `${OUTPUT_DIR}/Tafseer-Lecture-01_Clip01_The patience of Ayyub.srt`;

/**
 * A complete happy-path stream mirroring `backend/main.py:_stream_batch`
 * frame-for-frame (`start` → `progress` → `clip_done` → terminal `done`).
 * The renderer must reach the "done" state from this alone — no sidecar
 * FFmpeg runs in the test.
 */
export const SSE_RENDER_BODY =
  [
    sseFrame("start", {
      job_id: "e2e-job",
      status: "processing",
      progress: 0,
      clip_count: 1,
      resolution: "1080x1920",
      framing: "blur-fill",
      source_path: "C:/Lectures/Tafseer-Lecture-01.mp4",
      // Real `start` frames carry NO `output_dir`; the client falls back to
      // its own default and updates when SSE `done` announces the truth.
      clips: [
        {
          index: 0,
          start: 10,
          end: 40,
          duration: 30,
          output_path: OUTPUT_MP4,
          ass_path: `${OUTPUT_DIR}/clip01.ass`,
          srt_path: OUTPUT_SRT,
        },
      ],
    }),
    sseFrame("progress", {
      job_id: "e2e-job",
      status: "processing",
      progress: 0.5,
      clip_index: 0,
      clip_count: 1,
      clip_progress: 0.5,
      encoder: "h264_nvenc",
      failed_encoder: null,
      reason: null,
      stage: "encoding",
      output_path: OUTPUT_MP4,
      elapsed: 0.5,
    }),
    sseFrame("clip_done", {
      job_id: "e2e-job",
      status: "processing",
      progress: 0.8,
      clip_index: 0,
      clip_count: 1,
      encoder: "h264_nvenc",
      output_path: OUTPUT_MP4,
      srt_path: OUTPUT_SRT,
      duration: 30,
      elapsed: 0.8,
    }),
    sseFrame("done", {
      job_id: "e2e-job",
      status: "completed",
      progress: 1,
      clip_count: 1,
      failed_clips: 0,
      rendered_clips: 1,
      elapsed: 1.2,
      output_dir: OUTPUT_DIR,
    }),
  ].join("\n\n") + "\n\n";

/**
 * A fallback frame (GPU → CPU) exactly as the sidecar emits before retrying a
 * clip with `libx264`. The renderer must dedupe the repeated warning toast.
 */
export const SSE_RENDER_FALLBACK_FRAME = sseFrame("fallback", {
  job_id: "e2e-job",
  status: "processing",
  progress: 0.1,
  clip_index: 0,
  clip_count: 1,
  clip_progress: 0,
  encoder: "libx264",
  failed_encoder: "h264_nvenc",
  reason: "NVENC is not available on this machine (GPU/driver probe failed); using libx264.",
  stage: "fallback",
  output_path: OUTPUT_MP4,
  elapsed: 0.3,
});

/** A clip error frame as the sidecar emits on an FFmpeg failure. */
export const SSE_RENDER_CLIP_ERROR_FRAME = sseFrame("clip_error", {
  job_id: "e2e-job",
  status: "error",
  progress: 0.4,
  clip_index: 0,
  clip_count: 1,
  detail: "h264_nvenc failed (exit 1): /dev/null",
  output_path: OUTPUT_MP4,
});

/** Expected queue file name (default template, source stem + clip title). */
export const EXPECTED_FILE_NAME =
  "Tafseer-Lecture-01_Clip01_The patience of Ayyub.mp4";

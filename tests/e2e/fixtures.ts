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
        end: 38.5,
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
  discovery: { minDuration: 15, maxDuration: 90, maxClips: 8 },
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
 * A complete happy-path stream: `start` (with the resolved clip plan),
 * `progress`, `clip_done` and the terminal `done`. The renderer must reach the
 * "done" state from this alone — no sidecar FFmpeg runs in the test.
 */
export const SSE_RENDER_BODY =
  [
    sseFrame("start", {
      job_id: "e2e-job",
      status: "running",
      progress: 0,
      clip_count: 1,
      output_dir: OUTPUT_DIR,
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
      status: "rendering",
      progress: 0.5,
      clip_index: 0,
      clip_count: 1,
      clip_progress: 0.5,
      encoder: "h264_nvenc",
      elapsed: 0.5,
    }),
    sseFrame("clip_done", {
      job_id: "e2e-job",
      status: "rendering",
      progress: 0.8,
      clip_index: 0,
      clip_count: 1,
      clip_progress: 1,
      output_path: OUTPUT_MP4,
      srt_path: OUTPUT_SRT,
      elapsed: 0.8,
    }),
    sseFrame("done", {
      job_id: "e2e-job",
      status: "completed",
      progress: 1,
      rendered_clips: 1,
      failed_clips: 0,
      elapsed: 1.2,
      output_dir: OUTPUT_DIR,
    }),
  ].join("\n\n") + "\n\n";

/** Expected queue file name (default template, source stem + clip title). */
export const EXPECTED_FILE_NAME =
  "Tafseer-Lecture-01_Clip01_The patience of Ayyub.mp4";

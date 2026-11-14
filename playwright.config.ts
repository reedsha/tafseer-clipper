import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

/**
 * Release E2E harness for the Tauri renderer + real FastAPI sidecar.
 *
 * Two servers are managed for the suite:
 *  - the built SPA on 127.0.0.1:4173 (`vite preview`), and
 *  - the real Python sidecar on 127.0.0.1:8008, so `/health` is genuine.
 *
 * Everything external (LLM discovery, FFmpeg render) is mocked per test. Run
 * `npm run test:e2e`, which builds `dist/` before Playwright starts.
 *
 * CI overrides (see `.github/workflows/ci.yml`):
 *  - `PYTHON_BIN` selects the interpreter (`python` on GitHub Actions; the
 *    Windows launcher `py -3.12` is the local default).
 *  - `TAFSEER_FFMPEG` / `TAFSEER_FFPROBE` point at the runner's FFmpeg build;
 *    locally they default to %LOCALAPPDATA%\tafseer-clipper-tools\ffmpeg\bin.
 *  - `E2E_PREVIEW_PORT` overrides 4173 if the port is already taken.
 */

const pythonBin =
  process.env.PYTHON_BIN ?? (process.platform === "win32" ? "py -3.12" : "python");

const PREVIEW_PORT = process.env.E2E_PREVIEW_PORT ?? "4173";
const PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}`;

const FFMPEG_BIN_DIR = path.join(
  process.env.LOCALAPPDATA ?? "",
  "tafseer-clipper-tools",
  "ffmpeg",
  "bin",
);
const FFMPEG_PATH = process.env.TAFSEER_FFMPEG ?? path.join(FFMPEG_BIN_DIR, "ffmpeg.exe");
const FFPROBE_PATH = process.env.TAFSEER_FFPROBE ?? path.join(FFMPEG_BIN_DIR, "ffprobe.exe");

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  // One worker: both webServers are shared and the sidecar is single-instance.
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // CI uploads `playwright-report/` on failure (see .github/workflows/ci.yml);
  // local runs stay on the terse list reporter.
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }]]
    : [["list"]],
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: PREVIEW_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: `npm run preview -- --port ${PREVIEW_PORT} --strictPort --host 127.0.0.1`,
      url: PREVIEW_URL,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `${pythonBin} backend/main.py`,
      url: "http://127.0.0.1:8008/health",
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        TAFSEER_FFMPEG: FFMPEG_PATH,
        TAFSEER_FFPROBE: FFPROBE_PATH,
        PYTHONIOENCODING: "utf-8",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});

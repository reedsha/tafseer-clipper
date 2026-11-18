/**
 * Step 2 is now entirely user-triggered: a resumed project with a transcript
 * and zero clips must never call /discover-clips on its own. The finding
 * itself is mocked here so the test exercises only orchestration.
 */

import { expect, test } from "@playwright/test";

import { seedProjectFile } from "./fixtures";

const PROJECT_ID = "e2e00000-0000-4000-8000-000000000002";

const NO_CLIPS_PROJECT = {
  schemaVersion: 1,
  id: PROJECT_ID,
  name: "No-clips-resume",
  sourcePath: "C:/Lectures/No-clips-resume.mp4",
  sourceFileName: "No-clips-resume.mp4",
  duration: 600,
  step: 2,
  transcriptId: "e2e-transcript-no-clips",
  transcript: {
    language: "th",
    segments: [
      {
        id: 1,
        start: 10,
        end: 40,
        text: "ความอดทนเป็นครึ่งหนึ่งของความศรัทธา",
        language: "th",
      },
    ],
  },
  audioPath: null,
  basePrompt: "",
  promptPresetId: null,
  sessionGuide: "",
  discovery: { minDuration: 15, maxDuration: 90, maxClips: 8 },
  clips: [],
  selectedClipId: null,
  subtitles: {},
  export: {
    resolution: "1080x1920",
    framing: "blur-fill",
    useNvenc: true,
    exportSrt: true,
    filenameTemplate: "{LectureName}_Clip{01}_{Title}.mp4",
    outputDir: null,
  },
  createdAt: Date.now(),
  updatedAt: Date.now(),
  lastActivityAt: Date.now(),
};

/** A local analysis model avoids the provider pre-flight blocking the click. */
const SETTINGS = {
  state: {
    analysisMode: "local",
    ollama: { baseUrl: "http://127.0.0.1:11434", model: "test-model" },
  },
  version: 2,
};

test.describe("Step 2 search orchestration", () => {
  test("resume does not find clips until Start is clicked", async ({ page }) => {
    await page.addInitScript((settings) => {
      if (window.location.protocol !== "http:") return;
      window.localStorage.setItem("tafseer.settings.v1", JSON.stringify(settings));
    }, SETTINGS);
    await seedProjectFile(page, NO_CLIPS_PROJECT);

    let discoveryCalls = 0;
    await page.route("**/discover-clips", async (route) => {
      discoveryCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ clips: [], model: "test-model", excluded_ranges_applied: 0 }),
      });
    });

    await page.goto("/");
    await page
      .getByRole("complementary", { name: "Sessions" })
      .getByRole("button", { name: /No-clips-resume/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Find clips" })).toBeVisible();
    await expect(page.getByText("No clips proposed yet")).toBeVisible();
    await page.waitForTimeout(500);
    expect(discoveryCalls, "resume must not start a search").toBe(0);

    await page.getByRole("button", { name: "Find clips", exact: true }).last().click();
    await expect.poll(() => discoveryCalls).toBe(1);
  });
});

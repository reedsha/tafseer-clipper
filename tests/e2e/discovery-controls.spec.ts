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

/** Two proposals whose exported ranges collide (10–40 and 30–60). */
const OVERLAP_PROJECT = {
  ...NO_CLIPS_PROJECT,
  id: "e2e00000-0000-4000-8000-000000000003",
  name: "Overlapping-clips",
  clips: [
    {
      id: "e2e00000-0000-4000-8000-0000000000a1",
      title: "The patience of Ayyub",
      rationale: "A clear lesson on sabr.",
      start: 10,
      end: 40,
      speechStart: 10.3,
      speechEnd: 39.7,
      approved: false,
      createdAt: 1,
    },
    {
      id: "e2e00000-0000-4000-8000-0000000000a2",
      title: "Charity in secret",
      rationale: "A practical ruling.",
      start: 30,
      end: 60,
      speechStart: 30.3,
      speechEnd: 59.7,
      approved: false,
      createdAt: 2,
    },
  ],
  selectedClipId: "e2e00000-0000-4000-8000-0000000000a1",
};

/** One approved clip and one unapproved clip, for the confirmed re-roll flow. */
const REROLL_PROJECT = {
  ...OVERLAP_PROJECT,
  id: "e2e00000-0000-4000-8000-000000000005",
  name: "Reroll-confirmation",
  clips: [
    { ...OVERLAP_PROJECT.clips[0], approved: true },
    {
      ...OVERLAP_PROJECT.clips[1],
      title: "Unapproved trim",
      start: 100,
      end: 140,
      speechStart: 100.3,
      speechEnd: 139.7,
      approved: false,
    },
  ],
  subtitles: {
    "e2e00000-0000-4000-8000-0000000000a2": [
      { id: "cue-1", start: 0, end: 2, arabic: "", thai: "แก้ไขแล้ว", reviewed: true },
    ],
  },
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
    const discoveryBodies: Record<string, unknown>[] = [];
    await page.route("**/discover-clips", async (route) => {
      discoveryCalls += 1;
      discoveryBodies.push(route.request().postDataJSON() as Record<string, unknown>);
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

    // The search panel now exposes only the per-search note. Clip count and
    // length are decided by the model, not by project settings.
    await expect(page.getByLabel("Topic focus for this lecture")).toHaveCount(0);
    await expect(page.getByLabel("To find")).toHaveCount(0);
    await expect(page.getByLabel("Shortest (s)")).toHaveCount(0);
    await page
      .getByLabel("Additional instructions for this search")
      .fill("Focus on patience and gratitude");

    await page.waitForTimeout(500);
    expect(discoveryCalls, "resume must not start a search").toBe(0);

    await page.getByRole("button", { name: "Find clips", exact: true }).last().click();
    await expect.poll(() => discoveryCalls).toBe(1);
    expect(discoveryBodies[0]).toMatchObject({
      refinement_note: "Focus on patience and gratitude",
    });
    expect(discoveryBodies[0]).not.toHaveProperty("session_guide");
    expect(discoveryBodies[0]).not.toHaveProperty("max_clips");
    expect(discoveryBodies[0]).not.toHaveProperty("min_duration");
    expect(discoveryBodies[0]).not.toHaveProperty("max_duration");
    // An empty result reads as "nothing more found" and keeps the deck as is.
    await expect(page.getByText("No new clips found")).toBeVisible();
  });

  test("re-roll confirms replacement and keeps a proposal adjacent after padding", async ({
    page,
  }) => {
    await page.addInitScript((settings) => {
      if (window.location.protocol !== "http:") return;
      window.localStorage.setItem("tafseer.settings.v1", JSON.stringify(settings));
    }, SETTINGS);
    await seedProjectFile(page, REROLL_PROJECT);

    let discoveryCalls = 0;
    await page.route("**/discover-clips", async (route) => {
      discoveryCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          clips: [
            {
              start: 40.1,
              end: 70,
              title: "Adjacent discovery",
              rationale: "Starts immediately after the approved clip.",
            },
          ],
          model: "test-model",
          excluded_ranges_applied: 1,
        }),
      });
    });

    await page.goto("/");
    await page
      .getByRole("complementary", { name: "Sessions" })
      .getByRole("button", { name: /Reroll-confirmation/ })
      .first()
      .click();

    const searchButton = page.getByRole("button", {
      name: "Search again (keeps approved)",
      exact: true,
    });
    await searchButton.click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText("Replace unapproved clips?")).toBeVisible();
    await expect(dialog.getByText(/1 approved clip/)).toBeVisible();
    await expect(dialog.getByText(/1 unapproved clip/)).toBeVisible();
    expect(discoveryCalls, "confirmation must precede the request").toBe(0);

    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Unapproved trim", { exact: true })).toBeVisible();
    expect(discoveryCalls).toBe(0);

    await searchButton.click();
    await dialog.getByRole("button", { name: "Search and replace", exact: true }).click();
    await expect.poll(() => discoveryCalls).toBe(1);

    // 40.1s speech becomes a 39.8s cut with the default 0.3s buffer. It
    // overlaps the approved 10–40s cut only because of that padding, so it
    // must be shown and labelled rather than silently discarded.
    await expect(page.getByText("Unapproved trim", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Adjacent discovery", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Overlaps: The patience of Ayyub")).toBeVisible();
    await expect(page.getByText("The patience of Ayyub", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Search complete", { exact: true })).toBeVisible();
    await expect(
      page.getByText("1 new clip — approved clips kept; unapproved clips replaced"),
    ).toBeVisible();
  });

  test("an empty confirmed re-roll leaves unapproved clips unchanged", async ({ page }) => {
    await page.addInitScript((settings) => {
      if (window.location.protocol !== "http:") return;
      window.localStorage.setItem("tafseer.settings.v1", JSON.stringify(settings));
    }, SETTINGS);
    await seedProjectFile(page, REROLL_PROJECT);

    let discoveryCalls = 0;
    await page.route("**/discover-clips", async (route) => {
      discoveryCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ clips: [], model: "test-model", excluded_ranges_applied: 1 }),
      });
    });

    await page.goto("/");
    await page
      .getByRole("complementary", { name: "Sessions" })
      .getByRole("button", { name: /Reroll-confirmation/ })
      .first()
      .click();
    await page
      .getByRole("button", { name: "Search again (keeps approved)", exact: true })
      .click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Search and replace", exact: true })
      .click();

    await expect.poll(() => discoveryCalls).toBe(1);
    await expect(page.getByText("No new clips found")).toBeVisible();
    await expect(page.getByText("Unapproved trim", { exact: true })).toBeVisible();
    await expect(page.getByText("The patience of Ayyub", { exact: true }).first()).toBeVisible();
  });

  test("colliding clips are both kept and labelled with each other's titles", async ({
    page,
  }) => {
    await page.addInitScript((settings) => {
      if (window.location.protocol !== "http:") return;
      window.localStorage.setItem("tafseer.settings.v1", JSON.stringify(settings));
    }, SETTINGS);
    await seedProjectFile(page, OVERLAP_PROJECT);

    await page.goto("/");
    await page
      .getByRole("complementary", { name: "Sessions" })
      .getByRole("button", { name: /Overlapping-clips/ })
      .first()
      .click();

    // Neither clip is dropped: each names the other one.
    await expect(page.getByText("Overlaps: Charity in secret")).toBeVisible();
    await expect(page.getByText("Overlaps: The patience of Ayyub")).toBeVisible();
  });

  test("forwards non-empty sessionGuide in session_guide payload", async ({ page }) => {
    await page.addInitScript((settings) => {
      if (window.location.protocol !== "http:") return;
      window.localStorage.setItem("tafseer.settings.v1", JSON.stringify(settings));
    }, SETTINGS);
    await seedProjectFile(page, {
      ...NO_CLIPS_PROJECT,
      id: "e2e00000-0000-4000-8000-000000000006",
      name: "Guided-session",
      sessionGuide: "Surah Al-Asr and patience",
    });

    const discoveryBodies: Record<string, unknown>[] = [];
    await page.route("**/discover-clips", async (route) => {
      discoveryBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ clips: [], model: "test-model", excluded_ranges_applied: 0 }),
      });
    });

    await page.goto("/");
    await page
      .getByRole("complementary", { name: "Sessions" })
      .getByRole("button", { name: /Guided-session/ })
      .first()
      .click();
    await page.getByRole("button", { name: "Find clips", exact: true }).last().click();
    await expect.poll(() => discoveryBodies.length).toBe(1);
    expect(discoveryBodies[0]).toMatchObject({
      session_guide: "Surah Al-Asr and patience",
    });
  });

  test("consumes text/event-stream progress and renders final clips from /discover-clips", async ({
    page,
  }) => {
    await page.addInitScript((settings) => {
      if (window.location.protocol !== "http:") return;
      window.localStorage.setItem("tafseer.settings.v1", JSON.stringify(settings));
    }, SETTINGS);
    await seedProjectFile(page, {
      ...NO_CLIPS_PROJECT,
      id: "e2e00000-0000-4000-8000-000000000007",
      name: "SSE-discovery-session",
    });

    let sawAcceptHeader = false;
    await page.route("**/discover-clips", async (route) => {
      const accept = route.request().headers()["accept"] ?? "";
      sawAcceptHeader = accept.includes("text/event-stream");
      const donePayload = {
        clips: [
          {
            start: 10,
            end: 40,
            title: "Streamed SSE clip",
            rationale: "Delivered over SSE progress stream.",
          },
        ],
        model: "test-model",
        excluded_ranges_applied: 0,
      };
      const sseBody = [
        ": keepalive\n\n",
        `event: start\ndata: ${JSON.stringify({ stage: "planning", progress: 0.0, label: "Preparing clip search…" })}\n\n`,
        `event: progress\ndata: ${JSON.stringify({ stage: "discovering", progress: 0.5, label: "Scanning section 1 of 2…", done: 1, total: 2 })}\n\n`,
        `event: done\ndata: ${JSON.stringify(donePayload)}\n\n`,
      ].join("");
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream; charset=utf-8",
        body: sseBody,
      });
    });

    await page.goto("/");
    await page
      .getByRole("complementary", { name: "Sessions" })
      .getByRole("button", { name: /SSE-discovery-session/ })
      .first()
      .click();
    await page.getByRole("button", { name: "Find clips", exact: true }).last().click();

    await expect(page.getByText("Streamed SSE clip", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Clip proposals ready")).toBeVisible();
    expect(sawAcceptHeader).toBe(true);
  });
});

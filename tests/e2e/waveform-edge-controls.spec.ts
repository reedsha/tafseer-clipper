/**
 * Step 2's waveform is now the clip itself: there is no shaded region, no
 * full-lecture toggle, and the only boundary changes come from the edge
 * buttons or the Shift (cut-in) / Alt (cut-out) arrow shortcuts.
 *
 * The seeded project has no audio extract, so this spec exercises the
 * orchestration (keyboard mapping + step settings) rather than wavesurfer
 * rendering. The clip times are read from the TrimRow aria-labels, which use
 * the same absolute clock the renderer uses everywhere else in Step 2.
 */

import { expect, test, type Page } from "@playwright/test";

import { seedProjectFile, seedResumableProject } from "./fixtures";

/** A tiny silent WAV so wavesurfer can reach `ready` without a real lecture. */
function silentWavDataUrl(): string {
  const sampleRate = 8000;
  const samples = sampleRate; // one second of silence
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  return `data:audio/wav;base64,${buffer.toString("base64")}`;
}

function trimTime(page: Page, edge: "Cut in" | "Cut out", clock: string) {
  return page
    .getByRole("button", { name: `${edge} trim controls` })
    .locator(`[aria-label="${clock}"]`);
}

test.describe("Step 2 waveform edge controls", () => {
  test("clip-only chrome, modifier arrows and configurable steps", async ({ page }) => {
    await seedResumableProject(page);
    await page.goto("/");
    await page
      .getByRole("complementary", { name: "Sessions" })
      .getByRole("button", { name: /Tafseer-Lecture-01/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Find clips" })).toBeVisible();

    // The normal-editor affordances are gone, and the model selector is no
    // longer on the wizard screen — it belongs to the Find Clips config.
    await expect(page.getByRole("button", { name: /Focus clip|Fit lecture/ })).toHaveCount(0);
    await expect(page.getByText("drag the shaded region to trim")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Change finding model" })).toHaveCount(0);
    await expect(page.getByText("Finding model", { exact: true })).toHaveCount(0);

    // Step settings live in the Cut in / Cut out section with distinct defaults.
    await expect(page.getByText("Edge step size")).toBeVisible();
    const buttonStep = page.getByLabel("Buttons (s)");
    const keyStep = page.getByLabel("Keyboard (s)");
    await expect(buttonStep).toHaveValue("5");
    await expect(keyStep).toHaveValue("0.2");
    const share = page.getByRole("switch", { name: "Use the same step for buttons and keys" });
    await expect(share).not.toBeChecked();

    await expect(trimTime(page, "Cut in", "0:10.0")).toBeVisible();
    await expect(trimTime(page, "Cut out", "0:40.0")).toBeVisible();

    // Shift + ←/→ move the cut-in edge earlier/later by the key step.
    await page.keyboard.press("Shift+ArrowLeft");
    await expect(trimTime(page, "Cut in", "0:09.8")).toBeVisible();
    await page.keyboard.press("Shift+ArrowRight");
    await expect(trimTime(page, "Cut in", "0:10.0")).toBeVisible();

    // Alt + ←/→ move the cut-out edge earlier/later by the key step.
    await page.keyboard.press("Alt+ArrowLeft");
    await expect(trimTime(page, "Cut out", "0:39.8")).toBeVisible();
    await page.keyboard.press("Alt+ArrowRight");
    await expect(trimTime(page, "Cut out", "0:40.0")).toBeVisible();

    // Plain arrows were removed: no modifier means no trim at all.
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowRight");
    await expect(trimTime(page, "Cut in", "0:10.0")).toBeVisible();
    await expect(trimTime(page, "Cut out", "0:40.0")).toBeVisible();

    // Editing the keyboard step changes the amount the shortcuts move.
    await keyStep.fill("1");
    await keyStep.press("Tab");
    await page.keyboard.press("Shift+ArrowLeft");
    await expect(trimTime(page, "Cut in", "0:09.0")).toBeVisible();
    await page.keyboard.press("Shift+ArrowRight");
    await expect(trimTime(page, "Cut in", "0:10.0")).toBeVisible();

    // "Same" copies the button step into the keyboard step and locks the key
    // input so both controls cannot drift apart.
    await share.click();
    await expect(keyStep).toBeDisabled();
    await expect(keyStep).toHaveValue("5");
    await page.keyboard.press("Shift+ArrowLeft");
    await expect(trimTime(page, "Cut in", "0:05.0")).toBeVisible();

    // The selector is available where the stage is configured instead.
    await page
      .getByRole("navigation", { name: "Wizard steps" })
      .getByRole("button", { name: "Step 2 configuration" })
      .click();
    await expect(page.getByRole("heading", { name: "Find Clips configuration" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Change model" })).toHaveCount(0);
    await expect(page.getByText("Finding model", { exact: true })).toBeVisible();
  });

  test("edge buttons grow and trim the clip shown by the waveform", async ({ page }) => {
    const now = Date.now();
    await seedProjectFile(page, {
      schemaVersion: 1,
      id: "e2e00000-0000-4000-8000-000000000003",
      name: "Waveform-audio",
      sourcePath: null,
      sourceFileName: null,
      duration: 60,
      step: 2,
      transcriptId: "e2e-waveform-transcript",
      transcript: {
        language: "th",
        segments: [{ id: 1, start: 11, end: 39, text: "ความอดทน", language: "th" }],
        peaks: Array.from({ length: 1200 }, () => 0.5),
      },
      audioPath: silentWavDataUrl(),
      basePrompt: "",
      promptPresetId: null,
      sessionGuide: "",
      discovery: { minDuration: 15, maxDuration: 90, maxClips: 8 },
      clips: [
        {
          id: "e2e00000-0000-4000-8000-0000000000c3",
          title: "Waveform clip",
          rationale: "",
          start: 10,
          end: 40,
          speechStart: 10.3,
          speechEnd: 39.7,
          approved: false,
          createdAt: now,
        },
      ],
      selectedClipId: "e2e00000-0000-4000-8000-0000000000c3",
      subtitles: {},
      export: {
        resolution: "1080x1920",
        framing: "blur-fill",
        useNvenc: true,
        exportSrt: true,
        filenameTemplate: "{LectureName}_Clip{01}_{Title}.mp4",
        outputDir: null,
      },
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    });

    await page.goto("/");
    await page
      .getByRole("complementary", { name: "Sessions" })
      .getByRole("button", { name: /Waveform-audio/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Find clips" })).toBeVisible();

    // The buttons only render once wavesurfer has loaded the clip's audio.
    await expect(page.getByRole("button", { name: "Grow clip at the start" })).toBeVisible();
    await expect(trimTime(page, "Cut in", "0:10.0")).toBeVisible();

    // One button press uses the button step (5 s), not the keyboard step.
    await page.getByRole("button", { name: "Grow clip at the start" }).click();
    await expect(trimTime(page, "Cut in", "0:05.0")).toBeVisible();
    await expect(trimTime(page, "Cut out", "0:40.0")).toBeVisible();

    await page.getByRole("button", { name: "Trim clip at the end" }).click();
    await expect(trimTime(page, "Cut out", "0:35.0")).toBeVisible();
  });
});

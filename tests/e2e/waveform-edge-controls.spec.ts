/**
 * Step 2's waveform is now the clip itself: there is no shaded region, no
 * full-lecture toggle, and the only boundary changes come from the edge
 * buttons or the Shift (cut-in) / Alt (cut-out) arrow shortcuts. Plain arrows
 * move the preview playhead instead of trimming.
 *
 * The clip times are read from the compact "speech … · cut … → …" readout,
 * which uses the same absolute clock the renderer uses everywhere else in Step 2.
 * The playhead is read from the waveform's `data-playhead` hook.
 */

import { expect, test, type Page } from "@playwright/test";

import { seedProjectFile, seedResumableProject } from "./fixtures";

function playheadTime(page: Page, clock: string) {
  return page.locator(`[data-playhead="${clock}"]`);
}

function windowSeconds(page: Page, seconds: string) {
  return page.locator(`[data-window="${seconds}"]`);
}

function trimTime(page: Page, edge: "Cut in" | "Cut out", clock: string) {
  // The two per-edge TrimRows were replaced by one compact readout:
  // "speech <t> → <t> · cut <t> → <t>". The cut pair are the 3rd and 4th
  // labelled TimeFlow spans; keep `edge` in the locator so a clock can never
  // be matched against the wrong boundary.
  const readout = page.locator("p").filter({ hasText: /· cut/ });
  const cutIndex = edge === "Cut in" ? 2 : 3;
  return readout
    .locator("span[aria-label]")
    .nth(cutIndex)
    .and(page.locator(`[aria-label="${clock}"]`));
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

    // This session predates stored peaks. It must never fall back to drawing a
    // misleading full-lecture waveform; it points at re-transcription instead.
    await expect(
      page.getByText(/this session has no stored waveform/),
    ).toBeVisible();

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

    // Plain ←/→ move the playhead by 1 s and never touch the cut bounds.
    await expect(playheadTime(page, "10.000")).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(playheadTime(page, "11.000")).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(playheadTime(page, "10.000")).toBeVisible();
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

    // The engine toggle moved here from Step 1's AI setup card; Step 3 inherits
    // whatever this selects.
    const engine = page.getByRole("group", { name: "Clip finding engine" });
    await expect(engine).toBeVisible();
    await expect(engine.getByRole("button", { name: "Your AI account" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
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
      basePrompt: "",
      promptPresetId: null,
      sessionGuide: "",
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

    // The waveform renders from the stored peaks alone (this project has no
    // 16 kHz audio extract), and the edge buttons sit below it. Its duration is
    // the 30 s clip window, not the 60 s lecture.
    await expect(page.getByRole("button", { name: "Grow clip at the start" })).toBeVisible();
    await expect(trimTime(page, "Cut in", "0:10.0")).toBeVisible();
    await expect(windowSeconds(page, "30.000")).toBeVisible();

    // One button press uses the button step (5 s), not the keyboard step.
    // Growing the front edge parks the playhead on the new in-point.
    await page.getByRole("button", { name: "Grow clip at the start" }).click();
    await expect(trimTime(page, "Cut in", "0:05.0")).toBeVisible();
    await expect(trimTime(page, "Cut out", "0:40.0")).toBeVisible();
    await expect(playheadTime(page, "5.000")).toBeVisible();
    // Growing the front edge stretches the waveform window from 30 s to 35 s.
    await expect(windowSeconds(page, "35.000")).toBeVisible();

    // Trimming the front edge snaps the playhead forward to the new in-point
    // and shrinks the window back to 30 s.
    await page.getByRole("button", { name: "Trim clip at the start" }).click();
    await expect(trimTime(page, "Cut in", "0:10.0")).toBeVisible();
    await expect(playheadTime(page, "10.000")).toBeVisible();
    await expect(windowSeconds(page, "30.000")).toBeVisible();

    // Trimming the back edge leaves the playhead where it is and shrinks the
    // window to the new 25 s cut.
    await page.getByRole("button", { name: "Trim clip at the end" }).click();
    await expect(trimTime(page, "Cut out", "0:35.0")).toBeVisible();
    await expect(playheadTime(page, "10.000")).toBeVisible();
    await expect(windowSeconds(page, "25.000")).toBeVisible();

    // Move the playhead to the current out-point, then trim past it: the
    // playhead is clamped to the new end so it never sits outside the clip.
    for (let index = 0; index < 25; index += 1) {
      await page.keyboard.press("ArrowRight");
    }
    await expect(playheadTime(page, "35.000")).toBeVisible();
    await page.getByRole("button", { name: "Trim clip at the end" }).click();
    await expect(trimTime(page, "Cut out", "0:30.0")).toBeVisible();
    await expect(playheadTime(page, "30.000")).toBeVisible();
    await expect(windowSeconds(page, "20.000")).toBeVisible();
  });

  test("trimming the cut-out drops the subtitle lines it can no longer show", async ({ page }) => {
    const now = Date.now();
    const clipId = "e2e00000-0000-4000-8000-0000000000c4";
    await seedProjectFile(page, {
      schemaVersion: 1,
      id: "e2e00000-0000-4000-8000-000000000004",
      name: "Trim-sync",
      sourcePath: null,
      sourceFileName: null,
      duration: 60,
      step: 2,
      transcriptId: "e2e-trim-sync-transcript",
      transcript: {
        language: "th",
        segments: [{ id: 1, start: 11, end: 39, text: "ความอดทน", language: "th" }],
        peaks: Array.from({ length: 1200 }, () => 0.5),
      },
      basePrompt: "",
      promptPresetId: null,
      sessionGuide: "",
      clips: [
        {
          id: clipId,
          title: "Trim sync",
          rationale: "",
          start: 10,
          end: 40,
          speechStart: 10.3,
          speechEnd: 39.7,
          approved: true,
          createdAt: now,
        },
      ],
      selectedClipId: clipId,
      // Clip-relative lines: the last one sits past a 25 s cut-out.
      subtitles: {
        [clipId]: [
          { id: "cue-1", start: 0, end: 2, arabic: "", thai: "บรรทัดแรก", reviewed: true },
          { id: "cue-2", start: 2, end: 4, arabic: "", thai: "บรรทัดที่สอง", reviewed: true },
          { id: "cue-3", start: 30, end: 32, arabic: "", thai: "บรรทัดสุดท้าย", reviewed: true },
        ],
      },
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
      .getByRole("button", { name: /Trim-sync/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Find clips" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Trim clip at the end" })).toBeVisible();

    // 40 s → 35 s leaves the 30–32 s line outside the clip.
    await page.getByRole("button", { name: "Trim clip at the end" }).click();
    await expect(trimTime(page, "Cut out", "0:35.0")).toBeVisible();

    await page
      .getByRole("navigation", { name: "Wizard steps" })
      .getByRole("button", { name: /3\. Subtitles/ })
      .click();
    await expect(page.getByRole("heading", { name: "Subtitles" })).toBeVisible();
    // The orphaned line is gone; the two inside the clip are untouched, so no
    // rebuild (which would discard hand edits) is needed.
    const rows = page.locator("[data-cue-row]");
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "บรรทัดแรก" })).toHaveCount(1);
    await expect(rows.filter({ hasText: "บรรทัดสุดท้าย" })).toHaveCount(0);
  });
});

/**
 * E2E coverage for the Subtitles-only workflow mode:
 * - Step 1 mode selector UI, StepperHeader Option A (dimmed Skipped Step 2), and Thai i18n
 * - Transcribing a pre-clipped video auto-creates one full-length clip and jumps straight to Step 3
 * - Output frame 16:9 / 9:16 controls + `{LectureName}_subtitled.mp4` without mutating lecture defaults
 * - Step 2 Skipped view + lossless switch back to full workflow
 * - Duration mismatch hints, < 0.5s video guard, and clip-replacement confirmation dialog
 */

import { expect, test } from "@playwright/test";

import { seedProjectFile } from "./fixtures";
import { goToWorkspace } from "./navigation";

const NOW = Date.now();

function buildStep1Project(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "e2e-subonly-0000-4000-8000-000000000001",
    name: "Patience-Clip",
    mode: "subtitle-only",
    sourcePath: "C:/Clips/Patience-Clip.mp4",
    sourceFileName: "Patience-Clip.mp4",
    duration: 45,
    step: 1,
    transcriptId: null,
    transcript: null,
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
      filenameTemplate: "{LectureName}_subtitled.mp4",
      outputDir: null,
    },
    createdAt: NOW,
    updatedAt: NOW,
    lastActivityAt: NOW,
    ...overrides,
  };
}

test.describe("subtitles-only workflow", () => {
  test("Step 1 mode selector adapts UI, StepperHeader Option A, and Thai labels", async ({
    page,
  }) => {
    await goToWorkspace(page);

    const modeGroup = page.getByRole("radiogroup", { name: "Workflow mode" });
    await expect(modeGroup).toBeVisible();
    const lectureRadio = modeGroup.getByRole("radio", { name: /Find clips & subtitle/ });
    const subOnlyRadio = modeGroup.getByRole("radio", { name: /Subtitles only/ });

    await expect(lectureRadio).toHaveAttribute("aria-checked", "true");
    await expect(subOnlyRadio).toHaveAttribute("aria-checked", "false");
    await expect(page.getByRole("button", { name: "Clip brief & system prompt" })).toBeVisible();

    const stepper = page.getByRole("navigation", { name: "Wizard steps" });
    await expect(stepper.getByRole("button")).toHaveCount(8);

    await subOnlyRadio.click();

    await expect(subOnlyRadio).toHaveAttribute("aria-checked", "true");
    await expect(lectureRadio).toHaveAttribute("aria-checked", "false");
    await expect(page.getByRole("heading", { name: "Add your clip" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Drop a clip video or browse" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Transcribe & open subtitles" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Clip brief & system prompt" }),
    ).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Output frame" })).toBeVisible();
    await expect(page.getByRole("button", { name: "9:16 Vertical" })).toBeVisible();
    await expect(page.getByRole("button", { name: "16:9 Widescreen" })).toBeVisible();

    // Option A: Step 2 stays visible as Skipped and its configuration gear is hidden.
    await expect(stepper.getByRole("button")).toHaveCount(7);
    const step2Pill = stepper.getByRole("button", { name: "2. Find Clips, skipped" });
    await expect(step2Pill).toBeVisible();
    await expect(step2Pill.getByText("Skipped")).toBeVisible();
    await expect(stepper.getByRole("button", { name: "Step 2 configuration" })).toHaveCount(0);

    // Thai language switch updates the subtitle-only headings and mode cards too.
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("button", { name: "Language", exact: true }).click();
    await page.getByRole("combobox", { name: "Language", exact: true }).click();
    await page.getByRole("option", { name: "ไทย" }).click();
    await page.getByRole("button", { name: "กลับไปแอป" }).click();

    await expect(page.getByRole("heading", { name: "เพิ่มคลิปของคุณ" })).toBeVisible();
    await expect(page.getByRole("radio", { name: /ทำซับอย่างเดียว/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  test("transcribing in Subtitles-only mode creates one full clip, jumps to Step 3, and keeps global defaults isolated", async ({
    page,
  }) => {
    const project = buildStep1Project({
      sourceWidth: 1920,
      sourceHeight: 1080,
      export: {
        resolution: "1920x1080",
        framing: "blur-fill",
        useNvenc: true,
        exportSrt: true,
        filenameTemplate: "{LectureName}_subtitled.mp4",
        outputDir: null,
      },
    });
    await seedProjectFile(page, project);

    await page.route("**/extract-and-transcribe", async (route) => {
      const corsHeaders = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      };
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: corsHeaders });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: corsHeaders,
        contentType: "application/json",
        body: JSON.stringify({
          transcript_id: "subonly-tr-1",
          status: "completed",
          duration: 45,
          language: "th",
          language_probability: 0.99,
          segments: [
            {
              id: 0,
              start: 0.5,
              end: 6.0,
              text: "ความอดทนเป็นครึ่งหนึ่งของความศรัทธา",
              language: "th",
            },
            {
              id: 1,
              start: 10.0,
              end: 16.0,
              text: "การขอบคุณต่ออัลลอฮ์นำมาซึ่งความจำเริญ",
              language: "th",
            },
          ],
          audio_path: "C:/tmp/patience-audio.wav",
          model: "tiny",
          device: "cpu",
          compute_type: "int8",
          vram_unloaded: false,
        }),
      });
    });

    await page.goto("/");

    const sidebar = page.getByRole("complementary", { name: "Sessions" });
    const sessionRow = sidebar.getByRole("button", { name: /Patience-Clip/ }).first();
    await expect(sessionRow.getByText("Subtitles only")).toBeVisible();
    await sessionRow.click();

    await expect(page.getByText(/Detected 1920×1080 \(16:9\)/)).toBeVisible();
    await expect(page.getByRole("button", { name: "16:9 Widescreen" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByText("16:9 uses the whole frame.")).toBeVisible();

    // User can freely toggle between 9:16 and 16:9 on Step 1.
    await page.getByRole("button", { name: "9:16 Vertical" }).click();
    await expect(page.getByRole("button", { name: "9:16 Vertical" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByRole("button", { name: "16:9 Widescreen" }).click();
    await expect(page.getByRole("button", { name: "16:9 Widescreen" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await page.getByRole("button", { name: "Transcribe & open subtitles" }).click();

    await expect(page.getByText("Clip ready for subtitles")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Subtitles" })).toBeVisible();
    await expect(page.locator("[data-cue-row]")).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Back to upload" })).toBeVisible();
    await expect(
      page.getByRole("group", { name: "Aspect ratio" }).getByRole("button", { name: "16:9" }),
    ).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "Continue to export" }).click();
    await expect(page.getByRole("heading", { name: "Export", exact: true })).toBeVisible();

    const queueRow = page
      .getByRole("main")
      .locator("li")
      .filter({ hasText: "Patience-Clip" })
      .first();
    await expect(queueRow.getByText("Patience-Clip_subtitled.mp4")).toBeVisible();
    await expect(queueRow.getByText("16:9 Widescreen")).toBeVisible();

    // Global lecture defaults in settingsStore must remain untouched.
    const persistedSettings = await page.evaluate(() => {
      const raw = window.localStorage.getItem("tafseer.settings.v1");
      return raw ? JSON.parse(raw) : null;
    });
    if (persistedSettings?.state?.editor) {
      expect(persistedSettings.state.editor.resolution).toBe("1080x1920");
      expect(persistedSettings.state.editor.filenameTemplate).toBe(
        "{LectureName}_Clip{01}_{Title}.mp4",
      );
    }
  });

  test("Step 2 Skipped view offers a lossless switch to the full workflow", async ({ page }) => {
    const clipId = "e2e-subonly-clip-1";
    await seedProjectFile(
      page,
      buildStep1Project({
        id: "e2e-subonly-0000-4000-8000-000000000002",
        name: "Lossless-Switch",
        step: 3,
        transcriptId: "subonly-tr-2",
        transcript: {
          language: "th",
          segments: [
            {
              id: 0,
              start: 1,
              end: 6,
              text: "ทดสอบซับไตเติล",
              language: "th",
            },
          ],
        },
        clips: [
          {
            id: clipId,
            title: "Lossless-Switch",
            rationale: "",
            start: 0,
            end: 45,
            speechStart: 0,
            speechEnd: 45,
            approved: true,
            createdAt: NOW,
          },
        ],
        selectedClipId: clipId,
        subtitles: {
          [clipId]: [
            {
              id: "cue-edited",
              start: 1,
              end: 6,
              arabic: "",
              thai: "ข้อความที่แก้ไขแล้ว",
              edited: true,
            },
          ],
        },
      }),
    );

    await page.goto("/");
    await page
      .getByRole("complementary", { name: "Sessions" })
      .getByRole("button", { name: /Lossless-Switch/ })
      .first()
      .click();

    await expect(page.getByRole("heading", { name: "Subtitles" })).toBeVisible();

    const stepper = page.getByRole("navigation", { name: "Wizard steps" });
    await stepper.getByRole("button", { name: "2. Find Clips, skipped" }).click();

    await expect(page.getByText("Skipped in Subtitles-only mode")).toBeVisible();
    await expect(
      page.getByText(/This video is treated as one complete clip \(0:00 → 0:45\)/),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Go to Subtitles" })).toBeVisible();

    await page.getByRole("button", { name: "Switch to full workflow" }).click();

    await expect(page.getByRole("heading", { name: "Find clips" })).toBeVisible();
    await expect(stepper.getByRole("button", { name: "Step 2 configuration" })).toBeVisible();
    await expect(page.getByText("Lossless-Switch", { exact: true }).first()).toBeVisible();

    // Edited subtitles stay intact after switching modes.
    await page.getByRole("button", { name: "Continue to subtitles" }).click();
    await expect(page.getByText("ข้อความที่แก้ไขแล้ว").first()).toBeVisible();
  });

  test("duration mismatch hints, < 0.5s guard, and existing-clips confirmation behave as designed", async ({
    page,
  }) => {
    // 1. Short video in lecture mode -> inline Subtitles-only switch hint.
    await seedProjectFile(
      page,
      buildStep1Project({
        id: "e2e-subonly-0000-4000-8000-000000000003",
        name: "Short-Clip-In-Lecture",
        mode: "lecture",
        duration: 60,
        export: {
          resolution: "1080x1920",
          framing: "blur-fill",
          useNvenc: true,
          exportSrt: true,
          filenameTemplate: "{LectureName}_Clip{01}_{Title}.mp4",
          outputDir: null,
        },
      }),
    );

    await page.goto("/");
    await page
      .getByRole("complementary", { name: "Sessions" })
      .getByRole("button", { name: /Short-Clip-In-Lecture/ })
      .first()
      .click();

    await expect(page.getByText("Short video (1:00) — already clipped?")).toBeVisible();
    await page.getByRole("button", { name: "Switch to Subtitles only" }).click();
    await expect(
      page.getByRole("radio", { name: /Subtitles only/ }),
    ).toHaveAttribute("aria-checked", "true");

    // 2. Long video in Subtitles-only mode -> inline Find-clips switch hint.
    await seedProjectFile(
      page,
      buildStep1Project({
        id: "e2e-subonly-0000-4000-8000-000000000004",
        name: "Long-Lecture-In-SubOnly",
        mode: "subtitle-only",
        duration: 1800,
      }),
    );
    await page.reload();
    await page
      .getByRole("complementary", { name: "Sessions" })
      .getByRole("button", { name: /Long-Lecture-In-SubOnly/ })
      .first()
      .click();

    await expect(page.getByText(/Long video \(30:00\)/)).toBeVisible();
    await page.getByRole("button", { name: "Switch to Find clips" }).click();
    await expect(
      page.getByRole("radio", { name: /Find clips & subtitle/ }),
    ).toHaveAttribute("aria-checked", "true");

    // 3. Switching from lecture with existing clips asks confirmation first.
    await seedProjectFile(
      page,
      buildStep1Project({
        id: "e2e-subonly-0000-4000-8000-000000000005",
        name: "Has-Existing-Clips",
        mode: "lecture",
        duration: 120,
        transcriptId: "tr-existing",
        transcript: {
          language: "th",
          segments: [{ id: 0, start: 1, end: 10, text: "บทเรียน", language: "th" }],
        },
        clips: [
          {
            id: "c1",
            title: "Clip 1",
            rationale: "",
            start: 1,
            end: 30,
            speechStart: 1,
            speechEnd: 30,
            approved: true,
            createdAt: NOW,
          },
          {
            id: "c2",
            title: "Clip 2",
            rationale: "",
            start: 40,
            end: 80,
            speechStart: 40,
            speechEnd: 80,
            approved: false,
            createdAt: NOW,
          },
        ],
      }),
    );
    await page.reload();
    await page
      .getByRole("complementary", { name: "Sessions" })
      .getByRole("button", { name: /Has-Existing-Clips/ })
      .first()
      .click();

    await page.getByRole("radio", { name: /Subtitles only/ }).click();
    const confirmDialog = page.getByRole("dialog", { name: "Switch to Subtitles only?" });
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(confirmDialog).toBeHidden();
    await expect(
      page.getByRole("radio", { name: /Find clips & subtitle/ }),
    ).toHaveAttribute("aria-checked", "true");

    await page.getByRole("radio", { name: /Subtitles only/ }).click();
    await confirmDialog.getByRole("button", { name: "Switch to Subtitles only" }).click();
    await expect(
      page.getByRole("radio", { name: /Subtitles only/ }),
    ).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("button", { name: "Continue to subtitles" })).toBeVisible();

    // 4. Ultra-short (< 0.5s) video returned by transcription stays on Step 1 with warning.
    await seedProjectFile(
      page,
      buildStep1Project({
        id: "e2e-subonly-0000-4000-8000-000000000006",
        name: "Tiny-Clip",
        mode: "subtitle-only",
        duration: null,
      }),
    );
    await page.route("**/extract-and-transcribe", async (route) => {
      const corsHeaders = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      };
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: corsHeaders });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: corsHeaders,
        contentType: "application/json",
        body: JSON.stringify({
          transcript_id: "subonly-tr-tiny",
          status: "completed",
          duration: 0.3,
          language: "th",
          language_probability: 0.9,
          segments: [],
          audio_path: "C:/tmp/tiny.wav",
          model: "tiny",
          device: "cpu",
          compute_type: "int8",
          vram_unloaded: false,
        }),
      });
    });

    await page.reload();
    await page
      .getByRole("complementary", { name: "Sessions" })
      .getByRole("button", { name: /Tiny-Clip/ })
      .first()
      .click();

    await page.getByRole("button", { name: "Transcribe & open subtitles" }).click();
    await expect(page.getByText("Video is too short to export")).toBeVisible();
    await expect(page.getByText("Too short", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Add your clip" })).toBeVisible();
  });
});

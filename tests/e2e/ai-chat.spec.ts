/**
 * AI-chat round-trip: Step 1 exports the clip-finding brief as a markdown file
 * the editor pastes into a browser chat AI, and Step 2 imports the chat AI's
 * JSON reply back as unapproved clip proposals.
 *
 * The sidecar is real; no LLM is called on either side of the trip — the
 * export is a pure renderer function and the import bypasses /discover-clips
 * entirely, which is the point of the feature.
 */

import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import { PROJECT_NAME, seedResumableProject } from "./fixtures";
import { goToWorkspace } from "./navigation";

/** Seed the project and land on Step 2 with the two seeded clips. */
async function openStep2(page: Page): Promise<void> {
  await seedResumableProject(page);
  await goToWorkspace(page);
  const sidebar = page.getByRole("complementary", { name: "Sessions" });
  await sidebar.getByRole("button", { name: new RegExp(PROJECT_NAME) }).first().click();
  await expect(page.getByRole("heading", { name: "Find clips" })).toBeVisible();
}

test.describe("AI chat round-trip", () => {
  test("Step 1 exports a brief with the schema, transcript and 15s floor", async ({
    page,
  }) => {
    await seedResumableProject(page);
    await goToWorkspace(page);

    // Resume the seeded project — the boot session is a fresh Untitled one.
    const sidebar = page.getByRole("complementary", { name: "Sessions" });
    await sidebar.getByRole("button", { name: new RegExp(PROJECT_NAME) }).first().click();
    await expect(page.getByRole("heading", { name: "Find clips" })).toBeVisible();

    // Force the anchor-download fallback: the native save picker cannot run
    // headless, and the fallback is the same path non-Tauri builds use.
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).showSaveFilePicker = undefined;
    });

    await page.getByRole("button", { name: /1\. Upload/ }).click();
    // The transcript card (not the dropzone title, which shares the wording).
    await expect(page.getByRole("button", { name: "Export for AI chat" })).toBeVisible();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export for AI chat" }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe("Tafseer-Lecture-01-ai-clips.md");
    const brief = readFileSync(await download.path(), "utf8");

    // Main prompt (empty base prompt falls back to the default role), rules,
    // the exact JSON contract, and the transcript in sidecar line format.
    expect(brief).toContain("senior Islamic-studies video editor");
    expect(brief).toContain("at least 15 seconds");
    expect(brief).toContain("[10.5-16.5]");
    expect(brief).toContain("```json");
    expect(brief).toContain('{"clips": [{"start": 83.5');
    // Editorial limits stay out of the brief: the chat AI decides count/length.
    expect(brief).not.toContain("CONSTRAINTS");
    expect(brief).not.toContain("duration bounds");
  });

  test("paste JSON imports proposals and never touches the approved clip", async ({
    page,
  }) => {
    await openStep2(page);

    // Approve a seeded clip first: the import must leave it alone. The deck
    // list is scoped because the preview panel mirrors the selected clip's
    // Approve/Approved button.
    const deck = page.locator("ul");
    await page.getByRole("button", { name: "Approve", exact: true }).first().click();
    await expect(deck.getByRole("button", { name: "Approved", exact: true })).toHaveCount(
      1,
    );

    await page.getByRole("button", { name: "Import clips from chat" }).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("textbox")
      .fill(
        [
          "```json",
          '{"clips": [',
          '  {"start": 30, "end": 75, "title": "Imported patience", "rationale": "Kept by the editor."},',
          '  {"start": 100, "end": 110, "title": "Too short", "rationale": "Under the floor."},',
          '  {"start": 500, "end": 560, "title": "Imported charity", "rationale": "Second good clip."}',
          "]}",
          "```",
        ].join("\n"),
      );

    // Preview: 2 of 3 survive, the 10 s entry is reported, and the overlap
    // with the approved clip is flagged but not filtered.
    await expect(dialog.getByText("Showing 2/3 clips")).toBeVisible();
    await expect(dialog.getByText("1 dropped")).toBeVisible();
    await expect(dialog.getByText(/under 15 seconds/)).toBeVisible();
    await expect(dialog.getByText("Overlaps an approved clip")).toBeVisible();

    await dialog.getByRole("button", { name: /Import clips/ }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Added clips: 2")).toBeVisible();

    // Both imported clips land unapproved; the approved seed survives. Exact
    // text: the approved card also lists "Imported patience" as a collision.
    await expect(deck.getByText("Imported patience", { exact: true })).toBeVisible();
    await expect(deck.getByText("Imported charity", { exact: true })).toBeVisible();
    await expect(deck.getByRole("button", { name: "Approved", exact: true })).toHaveCount(
      1,
    );
  });

  test("salvages prose-wrapped JSON and thins floods to the lecture ceiling", async ({
    page,
  }) => {
    await openStep2(page);

    await page.getByRole("button", { name: "Import clips from chat" }).click();
    const dialog = page.getByRole("dialog");

    // 45 valid clips in a 30-minute lecture: the ceiling is 15
    // (clamp(ceil(1800 / 120), 6, 120)), so the preview must thin evenly.
    const clips = Array.from({ length: 45 }, (_slot, index) => {
      const start = 60 + index * 30;
      return {
        start,
        end: start + 20,
        title: `Flood ${index + 1}`,
        rationale: "One of many candidates.",
      };
    });
    const prose = [
      "Here are the clips you asked for:",
      JSON.stringify({ clips }, null, 2),
      "Let me know if you need more!",
    ].join("\n");
    await dialog.getByRole("textbox").fill(prose);

    await expect(dialog.getByText("Showing 15/45 clips")).toBeVisible();
    await expect(dialog.getByText(/Too many clips for this lecture/)).toBeVisible();

    // Cancel must leave the deck untouched.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Flood 1")).toHaveCount(0);
  });
});

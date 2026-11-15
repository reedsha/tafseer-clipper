/**
 * Project-flow E2E: resume a seeded `.tafseer` auto-save at Step 2, approve a
 * clip, split a Thai cue at the caret with Ctrl+Enter in Step 3, inspect the
 * Step 4 queue metadata, and drive a mocked `/render-batch` SSE stream to
 * completion.
 *
 * Only external work is mocked (render). `/health` and the app itself are real;
 * `/discover-clips` is never called because the seeded project already has two
 * clips, so Step 2 does not auto-discover.
 */

import { expect, test } from "@playwright/test";

import {
  EXPECTED_FILE_NAME,
  PROJECT_NAME,
  SSE_RENDER_BODY,
  THAI_CUE,
  seedResumableProject,
} from "./fixtures";

test.describe("project flow", () => {
  test("resume, approve, split a cue, and render a mocked batch", async ({ page }) => {
    await seedResumableProject(page);
    await page.goto("/");

    /* ------------------------------ resume ------------------------------ */
    // The app opens on the Recent Lectures bar above the stepper.
    const recentBar = page.getByRole("region", { name: "Recent lectures" }).first();
    await expect(recentBar).toBeVisible();
    await recentBar.getByRole("button", { name: new RegExp(PROJECT_NAME) }).first().click();

    await expect(page.getByRole("heading", { name: "Find clips" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Approved", exact: true })).toHaveCount(0);

    /* --------------------------- approve a clip -------------------------- */
    await page.getByRole("button", { name: "Approve", exact: true }).first().click();
    await expect(page.getByRole("button", { name: "Approved", exact: true }).first()).toBeVisible();

    /* ----------------------- Step 3: split a cue ------------------------- */
    await page.getByRole("button", { name: /3\. Subtitles/ }).click();
    await expect(page.getByRole("heading", { name: "Subtitles" })).toBeVisible();

    const thaiFields = page.locator('textarea[lang="th"]');
    await expect(thaiFields).toHaveCount(1);

    const thai = thaiFields.first();
    await thai.fill(THAI_CUE);
    const full = await thai.inputValue();
    expect(full.length).toBeGreaterThan(4);

    // Put the caret in the middle of the line, then Ctrl+Enter splits there.
    await thai.evaluate((element, offset) => {
      const field = element as HTMLTextAreaElement;
      field.focus();
      field.setSelectionRange(offset, offset);
    }, Math.floor(full.length / 2));
    await page.keyboard.press("Control+Enter");

    await expect(thaiFields).toHaveCount(2);
    const halves = await thaiFields.evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLTextAreaElement).value),
    );
    expect(halves).toHaveLength(2);
    // The two halves must join back to the original text: split, not duplicated.
    expect(halves[0] + halves[1]).toBe(full);
    expect(halves[0].length).toBeGreaterThan(0);
    expect(halves[1].length).toBeGreaterThan(0);

    /* ---------------------- Step 4: queue metadata ----------------------- */
    await page.getByRole("button", { name: "Continue to export" }).click();
    await expect(page.getByRole("heading", { name: "Export", exact: true })).toBeVisible();

    const queueRow = page.locator("li").filter({ hasText: "The patience of Ayyub" }).first();
    await expect(queueRow).toBeVisible();
    await expect(queueRow.getByText(EXPECTED_FILE_NAME)).toBeVisible();
    await expect(queueRow.getByText("9:16 Vertical")).toBeVisible();
    await expect(queueRow.getByText("Blur fill")).toBeVisible();
    await expect(queueRow.getByText("2 lines")).toBeVisible();
    await expect(queueRow.getByText("Queued", { exact: true })).toBeVisible();

    /* -------------------- mocked /render-batch SSE ----------------------- */
    // The browser origin is the Vite preview, not the sidecar: fulfil with CORS
    // headers (and answer the JSON preflight) so the app's fetch is not blocked.
    await page.route("**/render-batch", async (route) => {
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
        headers: {
          ...corsHeaders,
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
        body: SSE_RENDER_BODY,
      });
    });

    await page.getByRole("button", { name: "Render 1 clip" }).click();

    // The mocked stream must drive the UI to the completed state.
    await expect(page.getByText("Batch rendered")).toBeVisible();
    await expect(queueRow.getByText("Rendered", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Render again" })).toBeVisible();
    // No clip may be left queued after the terminal `done` event.
    await expect(page.getByText("Queued", { exact: true })).toBeHidden();
  });
});

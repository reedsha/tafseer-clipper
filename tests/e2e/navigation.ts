/**
 * Navigation helpers for specs that exercise the wizard.
 *
 * A cold start now opens the no-session landing screen instead of Step 1, and
 * the open project is intentionally not persisted. Tests that need a wizard
 * (stepper, dropzone, stage configuration) must therefore create a session
 * first; tests for the landing screen itself keep using `page.goto("/")`.
 */

import { expect, type Page } from "@playwright/test";

/** Create a session when the no-session landing screen is showing. */
export async function ensureSession(page: Page): Promise<void> {
  const create = page.getByRole("button", { name: "Create new session" });
  if (await create.isVisible().catch(() => false)) {
    await create.click();
    await expect(
      page.getByRole("button", { name: "Drop a lecture video or browse" }),
    ).toBeVisible();
  }
}

/** Navigate to the app and land inside a wizard session. */
export async function goToWorkspace(page: Page): Promise<void> {
  await page.goto("/");
  await ensureSession(page);
}

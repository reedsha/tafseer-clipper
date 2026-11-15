/**
 * Settings-correctness regressions.
 *
 * Covers the persistence edges the drawer can hit without any provider calls:
 * importing a snapshot with out-of-range numbers, a half-typed glossary pair
 * surviving a restart, and the preset dialogs refusing empty/no-op names.
 */

import { expect, test } from "@playwright/test";

/** Minimal `.tafseer` settings backup with deliberately out-of-range numbers. */
const OUT_OF_RANGE_BACKUP = {
  format: "tafseer-settings",
  version: 1,
  settings: {
    arabic: { fontSize: 500 },
    editor: { maxCharsPerLine: 500, cutBufferSeconds: 9 },
    storage: { autosaveIntervalMs: 20_000, projectFolder: "" },
  },
};

test.describe("settings persistence edges", () => {
  test("import snaps out-of-range numbers to slider bounds and labels a custom interval", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("tab", { name: "Storage & Backup" }).click();

    await page
      .locator('input[type="file"][accept*="json"]')
      .setInputFiles({
        name: "tafseer-settings.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(OUT_OF_RANGE_BACKUP)),
      });

    await expect(page.getByText("Settings imported")).toBeVisible();

    // A non-preset interval must read as a value, not an empty trigger.
    await expect(page.getByRole("combobox").filter({ hasText: "Custom (20 s)" })).toBeVisible();

    // The store keeps only values the sliders can represent.
    const persisted = await page.evaluate(() =>
      JSON.parse(window.localStorage.getItem("tafseer.settings.v1") ?? "null"),
    );
    expect(persisted.state.arabic.fontSize).toBe(120);
    expect(persisted.state.editor.maxCharsPerLine).toBe(80);
    expect(persisted.state.editor.cutBufferSeconds).toBe(1.5);
    expect(persisted.state.storage.autosaveIntervalMs).toBe(20_000);
  });

  test("a glossary pair with only the replacement typed survives a restart", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("tab", { name: "Glossary & Whisper" }).click();

    await page.getByRole("button", { name: "Add pair" }).click();
    await page.getByLabel("Replace with").last().fill("ทดสอบ");

    await page.reload();
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("tab", { name: "Glossary & Whisper" }).click();

    await expect(page.getByLabel("Replace with").last()).toHaveValue("ทดสอบ");
    // The row is kept, so the panel must say why it is inert.
    await expect(page.getByText(/1 pair is missing the text to find/)).toBeVisible();
  });

  test("renaming a preset requires a new, non-empty name", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("tab", { name: "Fonts & Style" }).click();

    await page.getByRole("button", { name: /^Rename / }).first().click();
    const nameInput = page.getByPlaceholder("Preset name");
    const renameButton = page.getByRole("button", { name: "Rename", exact: true });

    // Prefilled with the current name: confirming would be a no-op.
    await expect(renameButton).toBeDisabled();
    await nameInput.fill("");
    await expect(renameButton).toBeDisabled();

    await nameInput.fill("Mobile studio");
    await expect(renameButton).toBeEnabled();
    await renameButton.click();
    await expect(page.getByText("Preset renamed")).toBeVisible();
  });
});

/**
 * Settings regressions.
 *
 * Covers the persistence edges the drawer can hit without any provider calls
 * (out-of-range imports, half-typed glossary pairs, preset-name guards), the
 * affordances added for routing/template drift, the exact-value popover and the
 * Thai line-width hint, and the pointer gestures that must not drag the sheet.
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

test.describe("settings affordances", () => {
  test("filename templates flag placeholders the sidecar will not resolve", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("tab", { name: "Editor & Export" }).click();

    const template = page.getByLabel("Filename template");
    await template.fill("{LectureName}_{LecureName}_{01}");

    const warning = page.getByText(/Unknown placeholder/);
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("{LecureName}");

    // A fully supported template clears the warning.
    await template.fill("{LectureName}_{Clip}_{01}");
    await expect(page.getByText(/Unknown placeholder/)).toHaveCount(0);
  });

  test("provider sections say whether the current routing uses them", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("tab", { name: "AI Providers" }).click();

    const section = (heading: string) =>
      page.locator("section", { has: page.getByRole("heading", { name: heading }) });
    const cloud = section("Unified cloud API");
    const ollama = section("Local Ollama");
    const cloudStt = section("Cloud STT API");

    // Defaults: cloud analysis + local transcription.
    await expect(cloud.getByText("In use", { exact: true })).toBeVisible();
    await expect(ollama.getByText("Not used", { exact: true })).toBeVisible();
    await expect(cloudStt.getByText("Not used", { exact: true })).toBeVisible();

    await page.getByRole("combobox", { name: "Topic analysis engine" }).click();
    await page.getByRole("option", { name: "Local Ollama" }).click();

    await expect(cloud.getByText("Not used", { exact: true })).toBeVisible();
    await expect(ollama.getByText("In use", { exact: true })).toBeVisible();
    // Routing to Ollama without a model id must warn before Step 2 fails.
    await expect(ollama.getByText(/Clip discovery will fail/)).toBeVisible();
  });

  test("editing the live style marks the active preset modified and updates it", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("tab", { name: "Fonts & Style" }).click();

    const slider = page.getByRole("slider", { name: "Arabic font size" });
    await expect(page.getByText("Modified", { exact: true })).toHaveCount(0);

    await slider.focus();
    await slider.press("ArrowRight");
    await expect(page.getByText("Modified", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: /Update Studio default/ }).click();
    await expect(page.getByText("Preset updated")).toBeVisible();
    await expect(page.getByText("Modified", { exact: true })).toHaveCount(0);

    const persisted = await page.evaluate(() =>
      JSON.parse(window.localStorage.getItem("tafseer.settings.v1") ?? "null"),
    );
    const studio = persisted.state.presets.find(
      (item: { id: string }) => item.id === "studio-default",
    );
    expect(studio.arabic.fontSize).toBe(persisted.state.arabic.fontSize);
  });

  test("a slider read-out accepts an exact typed value and snaps it into range", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("tab", { name: "Fonts & Style" }).click();

    const trigger = page.getByRole("button", {
      name: "Type an exact value for Arabic font size",
    });
    const input = page.getByRole("textbox", { name: "Arabic font size" });
    const slider = page.getByRole("slider", { name: "Arabic font size" });

    // A value between two slider positions is reachable by typing it.
    await trigger.click();
    await input.fill("73");
    await input.press("Enter");
    await expect(slider).toHaveAttribute("aria-valuenow", "73");

    // Typed values go through the same bounds as an imported snapshot.
    await trigger.click();
    await input.fill("500");
    await input.press("Enter");
    await expect(slider).toHaveAttribute("aria-valuenow", "120");

    // Fractional steps snap to the grid the slider can show.
    await page.getByRole("tab", { name: "Editor & Export" }).click();
    await page.getByRole("button", { name: "Type an exact value for Cut buffer padding" }).click();
    await page.getByRole("textbox", { name: "Cut buffer padding" }).fill("0.42");
    await page.getByRole("textbox", { name: "Cut buffer padding" }).press("Enter");
    await expect(page.getByRole("slider", { name: "Cut buffer padding" })).toHaveAttribute(
      "aria-valuenow",
      "0.4",
    );
  });

  test("Thai line wrapping sits with the Thai style and flags an overflowing pair", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("tab", { name: "Fonts & Style" }).click();

    // Master plan §5.2: max chars per line belongs to the Thai defaults, next to
    // the font size it multiplies into a rendered line width.
    const maxChars = page.getByRole("slider", { name: "Max characters per line" });
    await expect(maxChars).toBeVisible();

    // The largest Thai size at 40 chars overruns the .ass text column.
    await page.getByRole("button", { name: "Type an exact value for Thai font size" }).click();
    await page.getByRole("textbox", { name: "Thai font size" }).fill("96");
    await page.getByRole("textbox", { name: "Thai font size" }).press("Enter");

    const warning = page.getByText(/runs past the subtitle column/);
    await expect(warning).toBeVisible();

    // One click applies the measured suggestion and clears the warning.
    await page.getByRole("button", { name: /^Use \d+ chars$/ }).click();
    await expect(warning).toHaveCount(0);
    const shortened = Number(await maxChars.getAttribute("aria-valuenow"));
    expect(shortened).toBeLessThan(40);

    // The control no longer lives in the editor tab.
    await page.getByRole("tab", { name: "Editor & Export" }).click();
    await expect(page.getByRole("slider", { name: "Max characters per line" })).toHaveCount(0);
  });

  test("horizontal drags inside the drawer never slide the panel", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("tab", { name: "Fonts & Style" }).click();

    const drawer = page.locator("[data-vaul-drawer]");
    const startX = (await drawer.boundingBox())!.x;

    // Dragging a slider thumb must move the thumb, not the sheet.
    const thumb = page.getByRole("slider", { name: "Arabic font size" });
    const before = await thumb.getAttribute("aria-valuenow");
    const box = (await thumb.boundingBox())!;
    const thumbY = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, thumbY);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 40, thumbY, { steps: 6 });
    const duringSlider = (await drawer.boundingBox())!.x;
    await page.mouse.up();

    expect(Math.round(duringSlider)).toBe(Math.round(startX));
    await expect(thumb).not.toHaveAttribute("aria-valuenow", before ?? "");

    // The tab strip scrolls horizontally; dragging it must not move the panel.
    const tablist = (await page.getByRole("tablist").boundingBox())!;
    await page.mouse.move(tablist.x + 80, tablist.y + tablist.height / 2);
    await page.mouse.down();
    await page.mouse.move(tablist.x - 40, tablist.y + tablist.height / 2, { steps: 6 });
    const duringTabs = (await drawer.boundingBox())!.x;
    await page.mouse.up();

    expect(Math.round(duringTabs)).toBe(Math.round(startX));
    await expect(drawer).toBeVisible();
  });
});

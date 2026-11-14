/**
 * Shell smoke tests: the app boots against the real sidecar, the five Settings
 * tabs render, the command palette opens with Ctrl+K, and Step 1 shows the
 * dropzone plus the first-run local-transcription hint.
 */

import { expect, test } from "@playwright/test";

test.describe("app shell", () => {
  test("loads the header, stepper and a live sidecar", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Ingest a lecture" })).toBeVisible();

    const stepper = page.getByRole("navigation", { name: "Wizard steps" });
    await expect(stepper).toBeVisible();
    await expect(stepper.getByRole("button")).toHaveCount(4);
    await expect(stepper.getByRole("button", { name: /1\. Upload/ })).toHaveAttribute(
      "aria-current",
      "step",
    );

    // /health is real: the LED flips to online once the sidecar answers.
    await expect(page.getByRole("button", { name: "Sidecar online" })).toBeVisible({
      timeout: 30_000,
    });
  });

  test("Settings drawer has all five tabs, updates state and diagnostics", async ({ page }) => {
    // Clipboard writes are granted so "Copy diagnostics" can succeed headlessly.
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/");

    await page.getByRole("button", { name: "Open settings" }).click();
    const drawerSubtitle = page.getByText(
      "Power-user configuration. Changes save automatically.",
    );
    await expect(drawerSubtitle).toBeVisible();

    await expect(page.getByRole("tab")).toHaveCount(5);
    for (const name of [
      "AI Providers",
      "Fonts & Style",
      "Glossary & Whisper",
      "Editor & Export",
      "Storage & Backup",
    ]) {
      await expect(page.getByRole("tab", { name })).toBeVisible();
    }

    await page.getByRole("tab", { name: "Storage & Backup" }).click();
    await expect(page.getByRole("heading", { name: "Updates" })).toBeVisible();
    await expect(
      page.getByText("Updates are available in the installed desktop app."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy diagnostics" })).toBeVisible();

    await page.getByRole("button", { name: "Copy diagnostics" }).click();
    await expect(page.getByText("Diagnostics copied")).toBeVisible();

    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(drawerSubtitle).toBeHidden();
  });

  test("Ctrl+K opens and closes the command palette", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Sidecar online" })).toBeVisible({
      timeout: 30_000,
    });

    await page.keyboard.press("Control+k");
    const paletteInput = page.getByPlaceholder(
      "Jump to a step, toggle a setting, or open a panel…",
    );
    await expect(paletteInput).toBeVisible();
    await expect(page.getByText("No matching command.")).toBeHidden();

    await page.keyboard.press("Escape");
    await expect(paletteInput).toBeHidden();
  });

  test("Step 1 shows the dropzone and the hardware-agnostic acceleration hint", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(
      page.getByRole("button", { name: "Drop a lecture video or browse" }),
    ).toBeVisible();
    await expect(page.getByText(/~1\.5 GB/)).toBeVisible();

    // The hint names GPU/CPU capability only — never a product line, and the
    // CPU fallback is always stated. Either the GPU is ready or the CPU path
    // is spelled out, depending on the machine running the suite.
    await expect(
      page.getByText(/GPU ready|CPU transcription|acceleration runtime is not installed/),
    ).toBeVisible();
  });

  test("Settings exposes the GPU acceleration section and stays vendor-neutral", async ({
    page,
  }) => {
    await page.goto("/");

    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("tab", { name: "Glossary & Whisper" }).click();

    await expect(page.getByRole("heading", { name: "GPU acceleration" })).toBeVisible();
    // Browser builds cannot download the pack: the section must say so instead
    // of failing, and the CPU fallback has to stay visible.
    await expect(page.getByText("Available in the installed desktop app").first()).toBeVisible();
    await expect(page.getByText(/CPU/i).first()).toBeVisible();

    // Product-line wording is banned from the rendered app (AGENTS.md §3).
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toMatch(/GTX|RTX|NVIDIA NVENC|4–6 GB|4-6 GB/);
  });
});

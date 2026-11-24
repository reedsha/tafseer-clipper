/**
 * Shell smoke tests: the app boots against the real sidecar, the full-page
 * Settings screen renders with its sidebar sections, a stage's configuration
 * screen replaces the step, the command palette opens with Ctrl+K, and Step 1
 * shows the dropzone plus the first-run local-transcription hint.
 */

import { expect, test } from "@playwright/test";

import { PROJECT_NAME, seedResumableProject } from "./fixtures";
import { goToWorkspace } from "./navigation";

test.describe("app shell", () => {
  test("loads the header, stepper and a live sidecar", async ({ page }) => {
    await goToWorkspace(page);

    await expect(page.getByRole("heading", { name: "Add your lecture" })).toBeVisible();

    const stepper = page.getByRole("navigation", { name: "Wizard steps" });
    await expect(stepper).toBeVisible();
    // Each stage pill holds the step button plus its configuration gear.
    await expect(stepper.getByRole("button")).toHaveCount(8);
    await expect(stepper.getByRole("button", { name: /1\. Upload/ })).toHaveAttribute(
      "aria-current",
      "step",
    );

    // The gear on a stage pill replaces the screen with that stage's
    // configuration, and Back returns to the wizard.
    await stepper.getByRole("button", { name: "Step 2 configuration" }).click();
    await expect(page.getByRole("heading", { name: "Find Clips configuration" })).toBeVisible();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Find Clips configuration" })).toBeHidden();

    // /health is real: the LED flips to online once the sidecar answers.
    await expect(page.getByRole("button", { name: "Engine ready" })).toBeVisible({
      timeout: 30_000,
    });
  });

  test("Settings is a full page with a sidebar and working diagnostics", async ({ page }) => {
    // Clipboard writes are granted so "Copy diagnostics" can succeed headlessly.
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await goToWorkspace(page);

    await page.getByRole("button", { name: "Open settings" }).click();

    // The sidebar lists every section; the content pane follows it.
    await expect(page.getByRole("heading", { name: "AI connection", exact: true })).toBeVisible();
    for (const section of [
      "GPU acceleration",
      "Storage & cache",
      "Engine & diagnostics",
      "Language",
      "Backup & reset",
      "Updates",
      "Keyboard shortcuts",
    ]) {
      await expect(
        page.locator("aside").getByRole("button", { name: section, exact: true }),
      ).toBeVisible();
    }

    // Diagnostics live in Engine & diagnostics.
    await page.getByRole("button", { name: "Engine & diagnostics", exact: true }).click();
    await expect(page.getByRole("button", { name: "Copy diagnostics" })).toBeVisible();
    await page.getByRole("button", { name: "Copy diagnostics" }).click();
    await expect(page.getByText("Diagnostics copied")).toBeVisible();

    await page.getByRole("button", { name: "Back to app" }).click();
    await expect(page.getByRole("button", { name: "Back to app" })).toBeHidden();
  });

  test("Ctrl+K opens and closes the command palette", async ({ page }) => {
    await goToWorkspace(page);
    await expect(page.getByRole("button", { name: "Engine ready" })).toBeVisible({
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

  test("recent AI activity is reachable from the header and the palette", async ({ page }) => {
    await goToWorkspace(page);
    await expect(page.getByRole("button", { name: "Engine ready" })).toBeVisible({
      timeout: 30_000,
    });

    await page.getByRole("button", { name: "Recent AI activity" }).click();
    await expect(page.getByText("No AI runs yet this session.")).toBeVisible();
    await page.keyboard.press("Escape");

    await page.keyboard.press("Control+k");
    const paletteInput = page.getByPlaceholder(
      "Jump to a step, toggle a setting, or open a panel…",
    );
    await expect(paletteInput).toBeVisible();
    await page.getByText("Show recent AI activity").click();
    await expect(page.getByText("No AI runs yet this session.")).toBeVisible();
  });

  test("Step 1 shows the dropzone and the hardware-agnostic acceleration hint", async ({
    page,
  }) => {
    await goToWorkspace(page);

    await expect(
      page.getByRole("button", { name: "Drop a lecture video or browse" }),
    ).toBeVisible();
    await expect(page.getByText(/1\.5 GB/)).toBeVisible();

    // The AI setup card is gone; its vocabulary hint now lives on this screen.
    await expect(page.getByRole("heading", { name: "AI setup" })).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "Transcription vocabulary hint" }),
    ).toBeVisible();

    // The engine is chosen on this screen instead of only behind the stage
    // gear, so a first-run editor never has to hunt for it…
    const engine = page.getByRole("group", { name: "Speech-to-text engine" });
    await expect(engine).toBeVisible();
    await expect(engine.getByRole("button", { name: "This computer" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // …and the clip brief opens without leaving the step. The desktop title-bar
    // offset lives on <html> so the portal-rendered drawer starts below it
    // instead of sliding underneath the window controls.
    await page.evaluate(() => document.documentElement.classList.add("desktop-shell"));
    await page.getByRole("button", { name: "Clip brief & system prompt" }).click();
    await expect(page.getByRole("heading", { name: "Initial prompt — clip finding" })).toBeVisible();
    const panel = page.getByRole("dialog");
    await expect.poll(async () => (await panel.boundingBox())?.y ?? 0).toBeGreaterThanOrEqual(31);
    await page.getByRole("button", { name: "Close initial prompt" }).click();
    await expect(
      page.getByRole("heading", { name: "Initial prompt — clip finding" }),
    ).toBeHidden();
    await page.evaluate(() => document.documentElement.classList.remove("desktop-shell"));

    // The hint names GPU/CPU capability only — never a product line, and the
    // CPU fallback is always stated. Either the GPU is ready or the CPU path
    // is spelled out, depending on the machine running the suite.
    await expect(
      page.getByText(/GPU ready|CPU transcription|acceleration runtime is not installed/),
    ).toBeVisible();
  });

  test("the import dialog clears the desktop title bar", async ({ page }) => {
    await seedResumableProject(page);
    await goToWorkspace(page);

    const sidebar = page.getByRole("complementary", { name: "Sessions" });
    await sidebar.getByRole("button", { name: new RegExp(PROJECT_NAME) }).first().click();
    await expect(page.getByRole("heading", { name: "Find clips" })).toBeVisible();

    // Same regression as the prompt drawer: the portal must inherit the
    // title-bar offset from <html>, so it starts below the window controls.
    await page.evaluate(() => document.documentElement.classList.add("desktop-shell"));
    await page.getByRole("button", { name: "Import clips from chat" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect
      .poll(async () => (await dialog.boundingBox())?.y ?? 0)
      .toBeGreaterThanOrEqual(31);
    await page.evaluate(() => document.documentElement.classList.remove("desktop-shell"));
  });

  test("prompt presets can be saved, picked and deleted from the drawer", async ({
    page,
  }) => {
    await goToWorkspace(page);

    // A success toast can stack over this trigger: sonner pauses its dismiss
    // timer while hovered (the pointer rests on the toaster after saving), so
    // move it away and let the toast fade before clicking.
    const openDrawer = async () => {
      await page.mouse.move(0, 0);
      await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
      await page.getByRole("button", { name: "Clip brief & system prompt" }).click();
    };
    await openDrawer();
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByText("No saved presets yet — save one above.")).toBeVisible();

    const prompt = "Focus on stories about patience and gratitude.";
    await drawer.getByLabel("What to look for").fill(prompt);
    await drawer.getByPlaceholder("Preset name").fill("Short reminders");
    await drawer.getByRole("button", { name: "Save preset" }).click();
    await expect(drawer).toBeHidden();

    await openDrawer();
    const reopened = page.getByRole("dialog");
    const row = reopened.getByRole("button", { name: /^Short reminders/ });
    await expect(row).toBeVisible();
    await row.click();
    await expect(reopened.getByLabel("What to look for")).toHaveValue(prompt);
    await expect(reopened.getByRole("button", { name: "Save prompt" })).toBeVisible();
    await reopened.getByRole("button", { name: "Save prompt" }).click();
    await expect(reopened).toBeHidden();

    await openDrawer();
    const third = page.getByRole("dialog");
    await expect(third.getByRole("button", { name: /^Short reminders/ })).toBeVisible();
    await third.getByRole("button", { name: "Delete preset Short reminders" }).click();
    const confirm = page.getByRole("dialog", { name: "Delete this preset?" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Delete preset", exact: true }).click();
    await expect(third.getByText("No saved presets yet — save one above.")).toBeVisible();
  });

  test("Settings exposes the GPU acceleration section and stays vendor-neutral", async ({
    page,
  }) => {
    await goToWorkspace(page);

    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("button", { name: "GPU acceleration", exact: true }).click();

    await expect(page.getByRole("heading", { name: "GPU acceleration", exact: true })).toBeVisible();
    // Browser builds cannot download the pack: the section must say so instead
    // of failing, and the CPU fallback has to stay visible.
    await expect(page.getByText("Available in the installed desktop app").first()).toBeVisible();
    await expect(page.getByText(/CPU/i).first()).toBeVisible();

    // Product-line wording is banned from the rendered app (AGENTS.md §3).
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toMatch(/GTX|RTX|NVIDIA NVENC|4–6 GB|4-6 GB/);
  });

  test("interface language switches the add-lecture screen to Thai", async ({ page }) => {
    await goToWorkspace(page);
    await expect(page.getByRole("heading", { name: "Add your lecture" })).toBeVisible();

    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("button", { name: "Language", exact: true }).click();
    await page.getByRole("combobox", { name: "Language", exact: true }).click();
    await page.getByRole("option", { name: "ไทย" }).click();
    // The settings chrome also translates once Thai is selected.
    await page.getByRole("button", { name: "กลับไปแอป" }).click();

    await expect(page.getByRole("heading", { name: "เพิ่มบทบรรยายของคุณ" })).toBeVisible();
  });
});

test.describe("no-session start screen", () => {
  test("a cold start offers open or create instead of the upload wizard", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "You're not in a session" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create new session" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open a .tafseer file…" })).toBeVisible();
    // No meaningless steps until a session exists, but the header chrome stays.
    await expect(page.getByRole("navigation", { name: "Wizard steps" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open settings" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Engine ready" })).toBeVisible({
      timeout: 30_000,
    });
  });

  test("create enters the wizard; a recent session can be resumed inline", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("main").getByRole("button", { name: "Create new session" }).click();
    await expect(page.getByRole("heading", { name: "Add your lecture" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Wizard steps" })).toBeVisible();

    await seedResumableProject(page);
    await page.reload();
    await expect(page.getByRole("heading", { name: "You're not in a session" })).toBeVisible();
    await page
      .getByRole("main")
      .getByRole("button", { name: new RegExp(PROJECT_NAME) })
      .click();
    await expect(page.getByRole("heading", { name: "Find clips" })).toBeVisible();
  });
});

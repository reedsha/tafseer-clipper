/**
 * Settings & configuration regressions.
 *
 * The full-page Settings screen (sidebar + content pane) and the per-stage
 * "<Stage> configuration" screens. Covers the persistence edges the screens
 * can hit without any provider calls (out-of-range imports, half-typed
 * glossary pairs, preset-name guards), the affordances added for
 * routing/template drift, the exact-value popover and the Thai line-width
 * hint, and that a configuration screen replaces — but never interrupts —
 * the step underneath.
 */

import { expect, test, type Page } from "@playwright/test";

/** Open the full-page Settings screen and jump to a sidebar section. */
async function openSettingsSection(page: Page, section: string) {
  const configBack = page.getByRole("button", { name: "Back", exact: true });
  if (await configBack.isVisible().catch(() => false)) {
    await configBack.click();
    await expect(configBack).toBeHidden();
  }
  const closeButton = page.getByRole("button", { name: "Back to app" });
  if (await closeButton.isVisible().catch(() => false)) {
    await closeButton.click();
    await expect(closeButton).toBeHidden();
  }
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: section, exact: true }).click();
  // The page title (level 1), not a same-named sub-section heading.
  await expect(
    page.getByRole("heading", { name: section, level: 1, exact: true }),
  ).toBeVisible();
}

/** Open a stage's configuration screen via its gear in the stepper. */
async function openStepConfig(page: Page, step: number, label: string) {
  const backButton = page.getByRole("button", { name: "Back", exact: true });
  if (await backButton.isVisible().catch(() => false)) {
    await backButton.click();
    await expect(backButton).toBeHidden();
  }
  await page
    .getByRole("navigation", { name: "Wizard steps" })
    .getByRole("button", { name: `Step ${step} configuration` })
    .click();
  await expect(page.getByRole("heading", { name: `${label} configuration` })).toBeVisible();
}

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
    await openSettingsSection(page, "Backup & reset");

    await page
      .locator('input[type="file"][accept*="json"]')
      .setInputFiles({
        name: "tafseer-settings.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(OUT_OF_RANGE_BACKUP)),
      });

    await expect(page.getByText("Settings imported")).toBeVisible();

    // A non-preset interval must read as a value, not an empty trigger.
    await openSettingsSection(page, "Storage & cache");
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
    await openStepConfig(page, 1, "Upload");

    await page.getByRole("button", { name: "Add pair" }).click();
    await page.getByLabel("Replace with").last().fill("ทดสอบ");

    await page.reload();
    await openStepConfig(page, 1, "Upload");

    await expect(page.getByLabel("Replace with").last()).toHaveValue("ทดสอบ");
    // The row is kept, so the panel must say why it is inert.
    await expect(page.getByText(/1 pair is missing the text to find/)).toBeVisible();
  });

  test("renaming a preset requires a new, non-empty name", async ({ page }) => {
    await page.goto("/");
    await openStepConfig(page, 3, "Subtitles");

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

test.describe("configuration screens", () => {
  test("a configuration screen swaps only the content area; the stepper stays live", async ({
    page,
  }) => {
    await page.goto("/");

    await openStepConfig(page, 1, "Upload");
    // The configuration is up, but the chrome (sessions sidebar + stepper) is
    // still in place and the stages remain clickable.
    await expect(page.getByRole("heading", { name: "Upload configuration" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Speech-to-text" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Wizard steps" })).toBeVisible();

    // The steppers' gears switch the configuration directly between stages.
    await page
      .getByRole("navigation", { name: "Wizard steps" })
      .getByRole("button", { name: "Step 3 configuration" })
      .click();
    await expect(page.getByRole("heading", { name: "Subtitles configuration" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Upload configuration" })).toBeHidden();

    // Back returns to the step that was configured.
    await openStepConfig(page, 1, "Upload");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Upload configuration" })).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Drop a lecture video or browse" }),
    ).toBeVisible();
  });

  test("the Settings sidebar jumps straight to each section", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open settings" }).click();

    for (const section of [
      "AI connection",
      "Fast judgments",
      "GPU acceleration",
      "Storage & cache",
      "Engine & diagnostics",
      "Language",
      "Backup & reset",
      "Updates",
      "Keyboard shortcuts",
    ]) {
      await page.getByRole("button", { name: section, exact: true }).click();
      await expect(
        page.getByRole("heading", { name: section, level: 1, exact: true }),
      ).toBeVisible();
    }

    await page.getByRole("button", { name: "Back to app" }).click();
    await expect(page.getByRole("heading", { name: "Keyboard shortcuts" })).toBeHidden();
  });
});

test.describe("settings affordances", () => {
  test("filename templates flag placeholders the sidecar will not resolve", async ({ page }) => {
    await page.goto("/");
    await openStepConfig(page, 4, "Export");

    const template = page.getByLabel("Filename template");
    await template.fill("{LectureName}_{LecureName}_{01}");

    const warning = page.getByText(/Unknown placeholder/);
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("{LecureName}");

    // A fully supported template clears the warning.
    await template.fill("{LectureName}_{Clip}_{01}");
    await expect(page.getByText(/Unknown placeholder/)).toHaveCount(0);
  });

  test("each screen warns about the missing piece it owns", async ({ page }) => {
    await page.goto("/");

    // Engine routing is always visible on Step 1; each screen owns the warning
    // for the piece it configures.
    // Defaults: cloud analysis with no key/model yet → the clip-finding
    // configuration names the first missing field.
    await openStepConfig(page, 2, "Find Clips");
    await expect(page.getByText(/Clip finding isn't set up yet: add the API key/)).toBeVisible();

    // Settings owns the connection itself and repeats the same gap.
    await openSettingsSection(page, "AI connection");
    await expect(page.getByText(/Not set up yet: add the API key/)).toBeVisible();

    await page.getByRole("button", { name: "Back to app" }).click();
    await page
      .getByRole("group", { name: "Topic analysis engine" })
      .getByRole("button", { name: "This computer" })
      .click();

    // Routing to Ollama without a model must warn before Step 2 fails.
    await openStepConfig(page, 2, "Find Clips");
    await expect(page.getByText(/won't work until you choose a model/)).toBeVisible();
  });

  test("cloud speech-to-text can use its own service without touching chat", async ({ page }) => {
    await page.goto("/");
    await openStepConfig(page, 1, "Upload");

    // Cloud mode defaults to the shared AI connection, so no extra credential
    // fields are shown until the user asks for a separate speech service.
    await page
      .getByRole("group", { name: "Speech-to-text engine" })
      .getByRole("button", { name: "AI service (cloud)" })
      .click();
    await expect(page.getByText(/Uses the AI connection saved in Settings/)).toBeVisible();

    await page.getByRole("button", { name: "Use a different speech service" }).click();
    const address = page.getByLabel("Speech service address");
    await expect(address).toBeVisible();
    await address.fill("https://api.openai.com/v1");
    await expect(page.getByLabel("Speech service API key", { exact: true })).toBeVisible();

    // Clearing the override returns to the shared AI connection.
    await page
      .getByRole("button", { name: "Use the AI connection for speech instead" })
      .click();
    await expect(address).toBeHidden();
  });

  test("the Ollama address is editable so a non-default port can be found", async ({ page }) => {
    await page.goto("/");
    await openSettingsSection(page, "AI connection");

    const address = page.getByLabel("Ollama server address");
    await expect(address).toBeVisible();
    await address.fill("http://127.0.0.1:11435/v1");
    await expect(address).toHaveValue("http://127.0.0.1:11435/v1");
    // The picker is owned by Step 2, not by Settings.
    await expect(page.getByLabel("Local AI model")).toHaveCount(0);
  });

  test("Test connection lists models without spending a generation", async ({ page }) => {
    await page.goto("/");
    await openSettingsSection(page, "AI connection");
    await page.getByLabel("AI connection server address").fill("https://models.example/v1");
    await page.getByLabel("Cloud API key", { exact: true }).fill("test-key");

    let modelCalls = 0;
    let verifyCalls = 0;
    await page.route("**/list-models", async (route) => {
      modelCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ models: ["tiny-test-model"] }),
      });
    });
    await page.route("**/verify-arabic", async (route) => {
      verifyCalls += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.getByRole("button", { name: "Test connection" }).click();

    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    await expect(page.getByText(/1 model available · no tokens used/)).toBeVisible();
    expect(modelCalls).toBe(1);
    expect(verifyCalls).toBe(0);
  });

  test("editing the live style marks the active preset modified and updates it", async ({
    page,
  }) => {
    await page.goto("/");
    await openStepConfig(page, 3, "Subtitles");

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
    await openStepConfig(page, 3, "Subtitles");

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
    await openStepConfig(page, 2, "Find Clips");
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
    await openStepConfig(page, 3, "Subtitles");

    // Max chars per line belongs to the Thai defaults, next to the font size it
    // multiplies into a rendered line width.
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

    // The control no longer lives with the export configuration.
    await openStepConfig(page, 4, "Export");
    await expect(page.getByRole("slider", { name: "Max characters per line" })).toHaveCount(0);
  });
});

test.describe("fast judgments", () => {
  test("a slot stays off until enabled, filters the model list and probes on demand", async ({
    page,
  }) => {
    // A ready cloud connection, so the decision pickers fetch their list through
    // the sidecar instead of showing the "connect first" placeholder.
    await page.addInitScript(() => {
      if (window.location.protocol !== "http:") return;
      window.localStorage.setItem(
        "tafseer.settings.v1",
        JSON.stringify({
          state: {
            analysisMode: "cloud",
            cloud: {
              baseUrl: "https://models.example/v1",
              apiKey: "test-key",
              model: "mock-model",
              timeout: 120,
            },
          },
          version: 2,
        }),
      );
    });

    const listed: Record<string, unknown>[] = [];
    await page.route("**/list-models", async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      listed.push(body);
      const probe = typeof body.probe_model === "string";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          // `unrelated-llm` is a generative-only id: the picker must hide it.
          models: ["jev-fast", "nimble-decider", "unrelated-llm"],
          probe: probe
            ? {
                ok: true,
                model: body.probe_model,
                detail: "Answered",
                confidence: 0.93,
              }
            : null,
        }),
      });
    });

    await page.goto("/");
    await openSettingsSection(page, "Fast judgments");

    const toggle = page.getByRole("switch", {
      name: "Arabic triage fast judgments",
    });
    const probeButton = page.getByRole("button", { name: "Test", exact: true }).last();

    await expect(toggle).not.toBeChecked();
    await expect(probeButton).toBeDisabled();

    await toggle.click();
    // Enabled but empty: the screen asks for a model instead of guessing one.
    await expect(page.getByText("Choose a model to switch this on.")).toBeVisible();

    await page
      .getByRole("button", { name: "Arabic triage model", exact: true })
      .click();
    const listbox = page.getByRole("listbox", { name: "Arabic triage model" });
    await expect(listbox.getByRole("option", { name: "jev-fast" })).toBeVisible();
    await expect(listbox.getByRole("option", { name: "nimble-decider" })).toBeVisible();
    await expect(listbox.getByRole("option", { name: "unrelated-llm" })).toHaveCount(0);
    await listbox.getByRole("option", { name: "jev-fast" }).click();

    await expect(probeButton).toBeEnabled();
    await probeButton.click();
    await expect(page.getByText("Answered correctly (93%).")).toBeVisible();

    const probeRequest = listed.find((body) => typeof body.probe_model === "string");
    expect(probeRequest).toMatchObject({
      base_url: "https://models.example/v1",
      api_key: "test-key",
      probe_model: "jev-fast",
      endpoint_style: "auto",
    });

    const persisted = await page.evaluate(() =>
      JSON.parse(window.localStorage.getItem("tafseer.settings.v1") ?? "null"),
    );
    expect(persisted.state.decisionSlots.verify_triage).toEqual({
      enabled: true,
      mode: "cloud",
      model: "jev-fast",
    });
  });
});

test.describe("sessions sidebar", () => {
  test("creates a session, renames it inline and collapses", async ({ page }) => {
    await page.goto("/");
    const sidebar = page.getByRole("complementary", { name: "Sessions" });
    await expect(sidebar).toBeVisible();

    // New session appears in the list and is the active one.
    await sidebar.getByRole("button", { name: "New session" }).click();
    await expect(sidebar.getByText("Untitled session").first()).toBeVisible();

    // Double-click the name to rename inline; Enter commits the change.
    const row = sidebar.getByRole("button", { name: /Resume Untitled session/ }).first();
    await row.dblclick();
    const nameInput = sidebar.getByLabel("Session name");
    await nameInput.fill("Friday tafseer");
    await nameInput.press("Enter");
    await expect(sidebar.getByText("Friday tafseer").first()).toBeVisible();
    await expect(sidebar.getByText("Untitled session")).toHaveCount(0);

    // The pencil opens the same inline editor; Escape cancels.
    await sidebar.getByRole("button", { name: /Rename Friday tafseer/ }).click();
    await expect(sidebar.getByLabel("Session name")).toBeVisible();
    await sidebar.getByLabel("Session name").press("Escape");
    await expect(sidebar.getByLabel("Session name")).toHaveCount(0);
  });
});

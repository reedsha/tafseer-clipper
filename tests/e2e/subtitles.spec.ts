import { expect, test, type Locator, type Page } from "@playwright/test";

import { seedProjectFile } from "./fixtures";

/**
 * Regression for the fragmented-transcript seed: some Cloud STT providers
 * return Thai as character-level segments. Step 3 must merge those into
 * readable subtitle lines instead of seeding hundreds of 0.1 s slivers.
 */

const PROJECT_ID = "e2e-frag0000-0000-4000-8000-000000000001";
const CLIP_ID = "e2e-frag0000-0000-4000-8000-0000000000c1";
const THAI = "ความอดทนเป็นครึ่งหนึ่งของความศรัทธา";

function buildProject(
  withBrokenSeed: boolean,
  text: string = THAI,
  withLegacySeed = false,
): Record<string, unknown> {
  const now = Date.now();
  const chars = [...text];
  const segments = chars.map((char, index) => ({
    id: index,
    start: Math.round(index * 10) / 100,
    end: Math.round((index + 1) * 10) / 100,
    text: char,
    language: "th",
  }));
  const brokenSeed = chars.map((char, index) => ({
    id: `micro-${index}`,
    start: Math.round(index * 10) / 100,
    end: Math.round((index + 1) * 10) / 100,
    arabic: "",
    thai: char,
  }));
  const legacySeed = Array.from(
    { length: Math.ceil(text.length / 40) },
    (_, index) => {
      const offset = index * 40;
      return {
        id: `legacy-${index}`,
        start: Math.round(offset * 10) / 100,
        end: Math.round(Math.min(offset + 40, text.length) * 10) / 100,
        arabic: "",
        thai: text.slice(offset, offset + 40),
      };
    },
  );
  const seed = withBrokenSeed ? brokenSeed : withLegacySeed ? legacySeed : [];

  return {
    schemaVersion: 1,
    id: PROJECT_ID,
    name: "Fragmented lecture",
    sourcePath: null,
    sourceFileName: "fragmented-lecture.mp4",
    duration: 10,
    step: 3,
    transcriptId: "e2e-frag-transcript",
    transcript: { language: "th", segments },
    audioPath: null,
    basePrompt: "",
    promptPresetId: null,
    sessionGuide: "",
    clips: [
      {
        id: CLIP_ID,
        title: "A fragmented transcript",
        rationale: "",
        start: 0,
        end: 10,
        speechStart: 0,
        speechEnd: 3.6,
        approved: true,
        createdAt: now,
      },
    ],
    selectedClipId: CLIP_ID,
    subtitles: seed.length ? { [CLIP_ID]: seed } : {},
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
  };
}

async function openFragmentedProject(
  page: Page,
  withBrokenSeed: boolean,
  text: string = THAI,
  withLegacySeed = false,
) {
  await seedProjectFile(page, buildProject(withBrokenSeed, text, withLegacySeed));
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "Sessions" });
  await sidebar
    .getByRole("button", { name: /Fragmented lecture/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Subtitles" })).toBeVisible();
}

function cueEndSeconds(label: string | null): number {
  const match = label ? /to (\d+):(\d+)\.(\d+)/.exec(label) : null;
  if (!match) throw new Error(`Unexpected cue label: ${label}`);
  return Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 10;
}

test.describe("subtitle line seeding", () => {
  test("character-level transcript segments merge into one readable line", async ({ page }) => {
    await openFragmentedProject(page, false);

    const rows = page.locator("[data-cue-row]");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("ความอดทน");

    const block = page
      .locator('div[role="button"][aria-label^="Subtitle line 0:"]')
      .first();
    await expect(block).toHaveCount(1);
    // The whole short sentence is on screen for its spoken span, not 0.1 s.
    expect(cueEndSeconds(await block.getAttribute("aria-label"))).toBeGreaterThan(1.5);
  });

  test("a saved one-cue-per-character seed is rebuilt on open", async ({ page }) => {
    await openFragmentedProject(page, true);

    const rows = page.locator("[data-cue-row]");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("ความอดทน");

    const block = page
      .locator('div[role="button"][aria-label^="Subtitle line 0:"]')
      .first();
    expect(cueEndSeconds(await block.getAttribute("aria-label"))).toBeGreaterThan(1.5);
  });

  test("long runs are cut at word boundaries, not mid-word", async ({ page }) => {
    // 100 characters: more than two 40-character lines. Every cut must land on
    // a word boundary, so the next line starts with a whole word.
    await openFragmentedProject(page, false, THAI.repeat(3).slice(0, 100));

    const rows = page.locator("[data-cue-row]");
    await expect(rows).toHaveCount(2);
    const firstThai = (await rows.nth(0).locator('p[lang="th"]').textContent()) ?? "";
    const secondThai = (await rows.nth(1).locator('p[lang="th"]').textContent()) ?? "";
    expect(firstThai.endsWith("ศรัทธา")).toBe(true);
    expect(firstThai.length).toBeLessThanOrEqual(81);
    expect(secondThai.startsWith("ความ")).toBe(true);
  });

  test("does not leave a one-character last line", async ({ page }) => {
    // 41 characters: a naive char cap leaves a 0.1 s "อ" tail. It must fold
    // into the previous line instead of becoming a sliver cue.
    await openFragmentedProject(page, false, THAI.repeat(2).slice(0, 41));

    const rows = page.locator("[data-cue-row]");
    await expect(rows).toHaveCount(1);
    const text = (await rows.first().locator('p[lang="th"]').textContent()) ?? "";
    expect(text.replace(/\s/g, "").length).toBe(41);
  });

  test("offers a rebuild for an old mid-word track and rebuilds word-safe", async ({ page }) => {
    // A track from the previous char-cap builder: 40-character chunks, no
    // fragment-sized cues, so only the boundary comparison can catch it.
    await openFragmentedProject(page, false, THAI.repeat(3).slice(0, 100), true);

    await expect(page.getByText("These lines were cut in the middle of words")).toBeVisible();
    await page.getByRole("button", { name: "Rebuild lines", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Rebuild lines", exact: true }).click();

    await expect(page.getByText("These lines were cut in the middle of words")).toBeHidden();
    const rows = page.locator("[data-cue-row]");
    await expect(rows).toHaveCount(2);
    const secondThai = (await rows.nth(1).locator('p[lang="th"]').textContent()) ?? "";
    expect(secondThai.startsWith("ความ")).toBe(true);
  });

  test("sentence groups, Arabic-only cues and the review strip", async ({ page }) => {
    const now = Date.now();
    const project = {
      schemaVersion: 1,
      id: "e2e-arabic-lecture",
      name: "Arabic passage lecture",
      sourcePath: null,
      sourceFileName: "arabic-lecture.mp4",
      duration: 10,
      step: 3,
      transcriptId: "e2e-arabic-transcript",
      transcript: {
        language: "th",
        segments: [
          { id: 0, start: 0, end: 2, text: "ประโยคแรก", language: "th", sentence_id: 0 },
          { id: 1, start: 2, end: 4, text: "ต่อเนื่องกัน", language: "th", sentence_id: 0 },
          {
            id: 2,
            start: 4,
            end: 8,
            text: "بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ",
            language: "ar",
            source: "quran",
            reference: "1:1",
            confidence: 1,
            original_text: "บิสมิลลาฮิรเราะห์มานิรเราะฮีม",
            translation: "ด้วยพระนามของอัลลอฮฺ ผู้ทรงกรุณาปรานี ผู้ทรงเมตตาเสมอ",
          },
          { id: 3, start: 8, end: 10, text: "ประโยคหลัง", language: "th", sentence_id: 1 },
        ],
      },
      audioPath: null,
      basePrompt: "",
      promptPresetId: null,
      sessionGuide: "",
        clips: [
        {
          id: "arabic-clip",
          title: "Arabic passage",
          rationale: "",
          start: 0,
          end: 10,
          speechStart: 0,
          speechEnd: 10,
          approved: true,
          createdAt: now,
        },
      ],
      selectedClipId: "arabic-clip",
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
    };
    await seedProjectFile(page, project);
    await page.goto("/");
    await page
      .getByRole("complementary", { name: "Sessions" })
      .getByRole("button", { name: /Arabic passage lecture/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Subtitles" })).toBeVisible();

    const rows = page.locator("[data-cue-row]");
    await expect(rows).toHaveCount(3);
    // Two Thai segments share sentence_id 0, so they are one sentence cue.
    const firstThai = (await rows.nth(0).locator('p[lang="th"]').textContent()) ?? "";
    expect(firstThai).toContain("ประโยคแรก");
    expect(firstThai).toContain("ต่อเนื่องกัน");

    const arabicRow = rows.filter({ hasText: "بِسْمِ" });
    await expect(arabicRow).toHaveCount(1);
    await expect(arabicRow.getByText("No Thai line")).toBeVisible();

    await expect(page.getByText(/1 Arabic passage/)).toBeVisible();
    await page.getByRole("button", { name: "Review", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Qur'an 1:1")).toBeVisible();
    await dialog.getByRole("button", { name: "Approve 1 verified" }).click();
    await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
    await expect(page.getByText(/0 to review/)).toBeVisible();
  });
});

test.describe("batched Arabic check", () => {
  test("Check all Arabic sends one request per clip and applies cue-id results", async ({
    page,
  }) => {
    // The batch guard needs a configured checker; seed the shared connection
    // instead of walking the whole Settings screen.
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

    const now = Date.now();
    const project = {
      schemaVersion: 1,
      id: "e2e-batch-lecture",
      name: "Batch check lecture",
      sourcePath: null,
      sourceFileName: "batch-lecture.mp4",
      duration: 10,
      step: 3,
      transcriptId: "e2e-batch-transcript",
      transcript: {
        language: "th",
        segments: [
          { id: 0, start: 0, end: 2, text: "ประโยคแรก", language: "th" },
          { id: 1, start: 2, end: 4, text: "ประโยคที่สอง", language: "th" },
        ],
      },
      audioPath: null,
      basePrompt: "",
      promptPresetId: null,
      sessionGuide: "",
        clips: [
        {
          id: "batch-clip",
          title: "Three Arabic lines",
          rationale: "",
          start: 0,
          end: 10,
          speechStart: 0,
          speechEnd: 6,
          approved: true,
          createdAt: now,
        },
      ],
      selectedClipId: "batch-clip",
      subtitles: {
        "batch-clip": [
          { id: "cue-a", start: 0, end: 2, arabic: "بِسْمِ اللَّهِ", thai: "ด้วยพระนาม" },
          { id: "cue-b", start: 2, end: 4, arabic: "الْحَمْدُ لِلَّهِ", thai: "มวลการสรรเสริญ" },
          { id: "cue-c", start: 4, end: 6, arabic: "الرَّحْمَٰنِ", thai: "ผู้ทรงกรุณา" },
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
    };
    await seedProjectFile(page, project);

    const requests: Record<string, unknown>[] = [];
    await page.route("**/verify-arabic", async (route) => {
      requests.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          verified_text: "",
          correction_applied: false,
          notes: "",
          model: "",
          lines: [
            {
              cue_id: "cue-a",
              verified_text: "بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ",
              correction_applied: true,
              notes: "Matched the Qur'an corpus (1:1).",
              source: "quran",
              reference: "1:1",
              confidence: 1,
            },
            {
              cue_id: "cue-b",
              verified_text: "الْحَمْدُ لِلَّهِ",
              correction_applied: false,
              notes: "Matched the Qur'an corpus (1:2).",
              source: "quran",
              reference: "1:2",
              confidence: 1,
            },
            {
              cue_id: "cue-c",
              verified_text: "الرَّحْمَٰنِ",
              correction_applied: false,
              notes: "Matched the Qur'an corpus (1:3).",
              source: "quran",
              reference: "1:3",
              confidence: 1,
            },
          ],
        }),
      });
    });

    await page.goto("/");
    await page
      .getByRole("complementary", { name: "Sessions" })
      .getByRole("button", { name: /Batch check lecture/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Subtitles" })).toBeVisible();

    await page.getByRole("button", { name: "Check 3 Arabic" }).click();

    await expect(page.getByText("Arabic checked")).toBeVisible();
    await expect(page.getByText("3 Qur'an matches · 1 corrected.")).toBeVisible();

    // One offline round-trip for the whole clip; Step 3 never sends an LLM provider.
    expect(requests).toHaveLength(1);
    const body = requests[0] as {
      lines: { arabic_text: string; cue_id: string; context_thai: string }[];
      provider?: unknown;
      decision_provider?: unknown;
    };
    expect(body.lines.map((line) => line.cue_id)).toEqual(["cue-a", "cue-b", "cue-c"]);
    expect(body.lines[0]).toMatchObject({
      arabic_text: "بِسْمِ اللَّهِ",
      cue_id: "cue-a",
      context_thai: "ด้วยพระนาม",
    });
    expect(body.provider).toBeNull();
    expect(body.decision_provider).toBeNull();

    // The corrected line replaced only its own cue.
    await expect(page.locator("[data-cue-row]").first()).toContainText("الرَّحِيمِ");
    await expect(page.locator("[data-cue-row]").nth(1)).not.toContainText("الرَّحِيمِ");
  });

  test("offline check sends no provider and reports unmatched lines", async ({
    page,
  }) => {
    // Offline corpus gate handles Qur'an lines and marks non-corpus Arabic as unmatched.
    const now = Date.now();
    await seedProjectFile(page, {
      schemaVersion: 1,
      id: "e2e-offline-verify",
      name: "Offline check lecture",
      sourcePath: null,
      sourceFileName: "offline.mp4",
      duration: 10,
      step: 3,
      transcriptId: "e2e-offline-transcript",
      transcript: {
        language: "th",
        segments: [
          { id: 0, start: 0, end: 2, text: "ประโยคแรก", language: "th" },
          { id: 1, start: 4, end: 6, text: "ประโยคที่สอง", language: "th" },
        ],
      },
      audioPath: null,
      basePrompt: "",
      promptPresetId: null,
      sessionGuide: "",
        clips: [
        {
          id: "offline-clip",
          title: "Corpus and prose",
          rationale: "",
          start: 0,
          end: 10,
          speechStart: 0,
          speechEnd: 10,
          approved: true,
          createdAt: now,
        },
      ],
      selectedClipId: "offline-clip",
      subtitles: {
        "offline-clip": [
          // Arabic-only: a corpus line shows up in the review strip.
          { id: "cue-a", start: 0, end: 2, arabic: "بِسْمِ اللَّهِ", thai: "" },
          { id: "cue-b", start: 4, end: 6, arabic: "الْحَمْدُ لِلَّهِ", thai: "มวลการสรรเสริญ" },
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

    const requests: Record<string, unknown>[] = [];
    await page.route("**/verify-arabic", async (route) => {
      requests.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          verified_text: "",
          correction_applied: false,
          notes: "",
          model: "",
          lines: [
            {
              cue_id: "cue-a",
              verified_text: "بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ",
              correction_applied: false,
              notes: "Matches the Qur'an corpus (1:1).",
              source: "quran",
              reference: "1:1",
              confidence: 1,
            },
            {
              cue_id: "cue-b",
              verified_text: "الْحَمْدُ لِلَّهِ",
              correction_applied: false,
              notes: "Only Qur'an verses are verified offline; review non-Qur'anic Arabic manually.",
              source: "unmatched",
            },
          ],
        }),
      });
    });

    await page.goto("/");
    await page
      .getByRole("complementary", { name: "Sessions" })
      .getByRole("button", { name: /Offline check lecture/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Subtitles" })).toBeVisible();

    await page.getByRole("button", { name: "Check 2 Arabic" }).click();

    // One offline run: the corpus line counts, the non-corpus line is left unmatched.
    await expect(page.getByText("Matched 1 of 2 lines in the Qur'an corpus")).toBeVisible();
    expect(requests).toHaveLength(1);
    expect((requests[0] as { provider?: unknown }).provider).toBeNull();

    // The verified corpus line keeps its text and gains its citation.
    await expect(page.getByText(/1 Arabic passage/)).toBeVisible();
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await expect(page.getByRole("dialog").getByText("Qur'an 1:1")).toBeVisible();
  });

  test("skips grazed multi-minute segment slivers and builds non-zero cues <= 2 lines", async ({
    page,
  }) => {
    const now = Date.now();
    await seedProjectFile(page, {
      schemaVersion: 1,
      id: "e2e-straddle-lecture",
      name: "Straddle lecture",
      sourcePath: null,
      sourceFileName: "straddle-lecture.mp4",
      duration: 700,
      step: 3,
      transcriptId: "e2e-straddle-transcript",
      transcript: {
        language: "th",
        segments: [
          {
            id: 0,
            start: 0,
            end: 601.8,
            text: "การทำความเข้าใจอัลกุรอาน".repeat(140),
            language: "th",
          },
          {
            id: 1,
            start: 601.8,
            end: 620.0,
            text: THAI.repeat(2),
            language: "th",
          },
        ],
      },
      audioPath: null,
      basePrompt: "",
      promptPresetId: null,
      sessionGuide: "",
      clips: [
        {
          id: "straddle-clip",
          title: "Clip past 10m",
          rationale: "",
          start: 601.5,
          end: 620.0,
          speechStart: 601.8,
          speechEnd: 620.0,
          approved: true,
          createdAt: now,
        },
      ],
      selectedClipId: "straddle-clip",
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
      .getByRole("button", { name: /Straddle lecture/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Subtitles" })).toBeVisible();

    const rows = page.locator("[data-cue-row]");
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < count; i += 1) {
      await expect(rows.nth(i)).not.toContainText("0:00.00 → 0:00.00");
      const thaiText = (await rows.nth(i).locator('p[lang="th"]').textContent()) ?? "";
      expect(thaiText).not.toContain("การทำความเข้าใจอัลกุรอาน");
      expect(thaiText.split("\n").length).toBeLessThanOrEqual(2);
    }

    const blocks = page.locator('div[role="button"][aria-label^="Subtitle line "][aria-label*=" to "]');
    await expect(blocks).toHaveCount(count);
    for (let i = 0; i < count; i += 1) {
      const label = await blocks.nth(i).getAttribute("aria-label");
      const match = label ? /Subtitle line (\d+):(\d+)\.(\d+) to (\d+):(\d+)\.(\d+)/.exec(label) : null;
      if (!match) throw new Error(`Unexpected cue ribbon label: ${label}`);
      const start = Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 10;
      const end = Number(match[4]) * 60 + Number(match[5]) + Number(match[6]) / 10;
      expect(end).toBeGreaterThan(start);
      expect(start).toBeGreaterThanOrEqual(0.2);
    }
  });

  test("auto-heals unreviewed broken sliver tracks on open", async ({ page }) => {
    const now = Date.now();
    await seedProjectFile(page, {
      schemaVersion: 1,
      id: "e2e-sliver-heal",
      name: "Broken sliver lecture",
      sourcePath: null,
      sourceFileName: "sliver-lecture.mp4",
      duration: 12,
      step: 3,
      transcriptId: "e2e-sliver-transcript",
      transcript: {
        language: "th",
        segments: [
          { id: 0, start: 0, end: 4, text: THAI, language: "th" },
          {
            id: 1,
            start: 4,
            end: 8,
            text: "ความศรัทธาที่มั่นคงย่อมนำพาสู่ความสงบในจิตใจ",
            language: "th",
          },
        ],
      },
      audioPath: null,
      basePrompt: "",
      promptPresetId: null,
      sessionGuide: "",
      clips: [
        {
          id: "sliver-clip",
          title: "Healed clip",
          rationale: "",
          start: 0,
          end: 8,
          speechStart: 0,
          speechEnd: 8,
          approved: true,
          createdAt: now,
        },
      ],
      selectedClipId: "sliver-clip",
      subtitles: {
        "sliver-clip": Array.from({ length: 12 }, (_, index) => ({
          id: `sliver-${index}`,
          start: 0,
          end: 0.05,
          arabic: "",
          thai: `ข้อความสั้น ${index}`,
        })),
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
      .getByRole("button", { name: /Broken sliver lecture/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Subtitles" })).toBeVisible();

    const rows = page.locator("[data-cue-row]");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).not.toContainText("0:00.00 → 0:00.00");
    await expect(rows.nth(0)).toContainText(THAI);
  });

  test("preset dialog Cancel rolls back unsaved style changes", async ({ page }) => {
    const now = Date.now();
    await seedProjectFile(page, {
      schemaVersion: 1,
      id: "e2e-preset-cancel",
      name: "Preset cancel lecture",
      sourcePath: null,
      sourceFileName: "preset-cancel.mp4",
      duration: 10,
      step: 3,
      transcriptId: "e2e-preset-cancel-transcript",
      transcript: { language: "th", segments: [{ id: 0, start: 0, end: 4, text: THAI, language: "th" }] },
      audioPath: null,
      basePrompt: "",
      promptPresetId: null,
      sessionGuide: "",
      clips: [
        {
          id: "preset-clip",
          title: "Sample clip",
          rationale: "",
          start: 0,
          end: 4,
          speechStart: 0,
          speechEnd: 4,
          approved: true,
          createdAt: now,
        },
      ],
      selectedClipId: "preset-clip",
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
      .getByRole("button", { name: /Preset cancel lecture/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Subtitles" })).toBeVisible();

    await page
      .getByRole("navigation", { name: "Wizard steps" })
      .getByRole("button", { name: "Step 3 configuration" })
      .click();
    await expect(page.getByRole("heading", { name: "Subtitles configuration" })).toBeVisible();

    await page.getByRole("button", { name: "Edit Studio default" }).click();
    const dialog = page.locator('[data-slot="dialog-content"]');
    const slider = dialog.getByRole("slider", { name: "Arabic font size" });
    const beforeSize = Number(await slider.getAttribute("aria-valuenow"));
    expect(beforeSize).not.toBe(100);

    await dialog.getByRole("button", { name: "Type an exact value for Arabic font size" }).click();
    const input = page.getByRole("textbox", { name: "Arabic font size" });
    await input.fill("100");
    await input.press("Enter");
    await expect(slider).toHaveAttribute("aria-valuenow", "100");

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    const persisted = await page.evaluate(() =>
      JSON.parse(window.localStorage.getItem("tafseer.settings.v1") ?? "null"),
    );
    expect(persisted?.state?.arabic?.fontSize).toBe(beforeSize);

    await page.getByRole("button", { name: "Edit Studio default" }).click();
    await expect(
      page.locator('[data-slot="dialog-content"]').getByRole("slider", { name: "Arabic font size" }),
    ).toHaveAttribute("aria-valuenow", String(beforeSize));
  });
});

test.describe("Step 3 undo/redo, continuous play, and reset", () => {
  function makeStep3Project(id: string, name: string, withSubtitles = true) {
    const now = Date.now();
    return {
      schemaVersion: 1,
      id,
      name,
      sourcePath: withSubtitles ? "https://media.example/lecture.mp4" : null,
      sourceFileName: "step3-test.mp4",
      duration: 20,
      step: 3,
      transcriptId: `${id}-transcript`,
      transcript: {
        language: "th",
        segments: [
          { id: 0, start: 0, end: 3, text: "ประโยคแรกของบทเรียน", language: "th" },
          { id: 1, start: 4, end: 7, text: "ประโยคที่สองของบทเรียน", language: "th" },
        ],
      },
      audioPath: null,
      basePrompt: "",
      promptPresetId: null,
      sessionGuide: "",
      clips: [
        {
          id: `${id}-clip`,
          title: "Clip one",
          rationale: "",
          start: 0,
          end: 10,
          speechStart: 0,
          speechEnd: 10,
          approved: true,
          createdAt: now,
        },
      ],
      selectedClipId: `${id}-clip`,
      subtitles: withSubtitles
        ? {
            [`${id}-clip`]: [
              { id: "cue-1", start: 0, end: 2, arabic: "", thai: "บรรทัดที่หนึ่ง" },
              { id: "cue-2", start: 4, end: 6, arabic: "", thai: "บรรทัดที่สอง" },
            ],
          }
        : {},
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
    };
  }

  function cueTimesFromLabel(label: string | null): { start: number; end: number } {
    const match = label
      ? /Subtitle line (\d+):(\d+)\.(\d+) to (\d+):(\d+)\.(\d+)/.exec(label)
      : null;
    if (!match) throw new Error(`Unexpected cue label: ${label}`);
    return {
      start: Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 10,
      end: Number(match[4]) * 60 + Number(match[5]) + Number(match[6]) / 10,
    };
  }

  test("undoes and redoes subtitle block moves and duration resizes", async ({ page }) => {
    await seedProjectFile(page, makeStep3Project("e2e-undo-redo", "Undo redo lecture"));
    await page.goto("/");
    await page
      .getByRole("complementary", { name: "Sessions" })
      .getByRole("button", { name: /Undo redo lecture/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Subtitles" })).toBeVisible();

    const undoButton = page.getByRole("button", { name: "Undo", exact: true });
    const redoButton = page.getByRole("button", { name: "Redo", exact: true });
    await expect(undoButton).toBeDisabled();
    await expect(redoButton).toBeDisabled();

    const track = page.getByRole("group", { name: "Subtitle track" });
    const firstBlock = track.getByRole("button", { name: /^Subtitle line / }).first();
    const trackBox = await track.boundingBox();
    const blockBox = await firstBlock.boundingBox();
    if (!trackBox || !blockBox) throw new Error("Cue ribbon did not render");

    // 1. Move the first block right by ~1s (10% of the 10s track).
    const moveStartX = blockBox.x + blockBox.width / 2;
    const moveY = blockBox.y + blockBox.height / 2;
    await page.mouse.move(moveStartX, moveY);
    await page.mouse.down();
    await page.mouse.move(moveStartX + trackBox.width * 0.1, moveY, { steps: 6 });
    await page.mouse.up();

    const afterMove = cueTimesFromLabel(await firstBlock.getAttribute("aria-label"));
    expect(afterMove.start).toBeGreaterThan(0.5);
    expect(afterMove.end).toBeGreaterThan(2.5);
    await expect(undoButton).toBeEnabled();
    await expect(redoButton).toBeDisabled();

    // 2. Resize the first block's right edge wider by ~1s.
    const movedBox = await firstBlock.boundingBox();
    if (!movedBox) throw new Error("Moved cue block missing");
    const edgeX = movedBox.x + movedBox.width - 2;
    const edgeY = movedBox.y + movedBox.height / 2;
    await page.mouse.move(edgeX, edgeY);
    await page.mouse.down();
    await page.mouse.move(edgeX + trackBox.width * 0.1, edgeY, { steps: 6 });
    await page.mouse.up();

    const afterResize = cueTimesFromLabel(await firstBlock.getAttribute("aria-label"));
    expect(afterResize.end).toBeGreaterThan(afterMove.end + 0.5);

    // Undo resize -> back to afterMove.
    await undoButton.click();
    const afterUndoResize = cueTimesFromLabel(await firstBlock.getAttribute("aria-label"));
    expect(afterUndoResize).toEqual(afterMove);
    await expect(redoButton).toBeEnabled();

    // Undo move -> back to original 0:00.0 -> 0:02.0.
    await undoButton.click();
    const afterUndoMove = cueTimesFromLabel(await firstBlock.getAttribute("aria-label"));
    expect(afterUndoMove).toEqual({ start: 0, end: 2 });
    await expect(undoButton).toBeDisabled();

    // Redo move and resize with buttons.
    await redoButton.click();
    expect(cueTimesFromLabel(await firstBlock.getAttribute("aria-label"))).toEqual(afterMove);
    await redoButton.click();
    expect(cueTimesFromLabel(await firstBlock.getAttribute("aria-label"))).toEqual(afterResize);
    await expect(redoButton).toBeDisabled();

    // Keyboard Ctrl+Z / Ctrl+Y also work when a ribbon block has focus.
    await firstBlock.focus();
    await page.keyboard.press("Control+z");
    expect(cueTimesFromLabel(await firstBlock.getAttribute("aria-label"))).toEqual(afterMove);
    await page.keyboard.press("Control+y");
    expect(cueTimesFromLabel(await firstBlock.getAttribute("aria-label"))).toEqual(afterResize);
  });

  async function installFakeVideoDriver(page: Page) {
    await page.addInitScript(() => {
      type VideoState = {
        src: string;
        currentTime: number;
        paused: boolean;
        playbackRate: number;
        timer: number | null;
      };
      const states = new WeakMap<HTMLMediaElement, VideoState>();
      const getState = (el: HTMLMediaElement): VideoState => {
        let s = states.get(el);
        if (!s) {
          s = { src: "", currentTime: 0, paused: true, playbackRate: 1, timer: null };
          states.set(el, s);
        }
        return s;
      };

      const origSetAttr = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function (name: string, value: string) {
        if (this instanceof HTMLVideoElement && name === "src") {
          const s = getState(this);
          s.src = value;
          queueMicrotask(() => {
            this.dispatchEvent(new Event("loadedmetadata"));
            this.dispatchEvent(new Event("loadeddata"));
          });
          return;
        }
        return origSetAttr.call(this, name, value);
      };

      Object.defineProperties(HTMLMediaElement.prototype, {
        src: {
          configurable: true,
          get() {
            return getState(this).src;
          },
          set(val: string) {
            const s = getState(this);
            s.src = String(val);
            queueMicrotask(() => {
              this.dispatchEvent(new Event("loadedmetadata"));
              this.dispatchEvent(new Event("loadeddata"));
            });
          },
        },
        readyState: {
          configurable: true,
          get() {
            return 4;
          },
        },
        duration: {
          configurable: true,
          get() {
            return 20;
          },
        },
        paused: {
          configurable: true,
          get() {
            return getState(this).paused;
          },
        },
        currentTime: {
          configurable: true,
          get() {
            return getState(this).currentTime;
          },
          set(val: number) {
            const s = getState(this);
            s.currentTime = Number(val) || 0;
            queueMicrotask(() => {
              this.dispatchEvent(new Event("seeked"));
            });
          },
        },
        playbackRate: {
          configurable: true,
          get() {
            return getState(this).playbackRate;
          },
          set(val: number) {
            getState(this).playbackRate = Number(val) || 1;
          },
        },
        play: {
          configurable: true,
          value() {
            const s = getState(this);
            if (!s.paused) return Promise.resolve();
            s.paused = false;
            this.dispatchEvent(new Event("play"));
            if (s.timer !== null) window.clearInterval(s.timer);
            s.timer = window.setInterval(() => {
              if (s.paused) return;
              s.currentTime += 0.15;
              this.dispatchEvent(new Event("timeupdate"));
            }, 40);
            return Promise.resolve();
          },
        },
        pause: {
          configurable: true,
          value() {
            const s = getState(this);
            if (s.timer !== null) {
              window.clearInterval(s.timer);
              s.timer = null;
            }
            if (s.paused) return;
            s.paused = true;
            this.dispatchEvent(new Event("pause"));
          },
        },
      });
    });
  }

  test("Play clip highlights to play continuously and stops at block end when un-highlighted", async ({
    page,
  }) => {
    // Deterministic fake <video> driver so Chromium headless does not need a
    // codec file to test continuous vs stop-at-block-end transport logic.
    await installFakeVideoDriver(page);

    await page.route("https://media.example/**", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-length": "1024", "content-type": "video/mp4" },
        body: "",
      });
    });

    await seedProjectFile(page, makeStep3Project("e2e-play-clip", "Play clip lecture"));
    await page.goto("/");
    await page
      .getByRole("complementary", { name: "Sessions" })
      .getByRole("button", { name: /Play clip lecture/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Subtitles" })).toBeVisible();

    const playClipButton = page.getByRole("button", { name: "Play clip", exact: true });
    await expect(playClipButton).toHaveAttribute("aria-pressed", "false");
    await expect(playClipButton).toHaveAttribute("data-variant", "outline");

    // Without Play clip highlighted, playing cue 1 (0 -> 2s) stops at cue 1's end.
    await page.getByRole("button", { name: "Play line 1" }).click();
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeHidden({
      timeout: 5_000,
    });
    const stoppedTime = await page.evaluate(
      () => document.querySelector("video")?.currentTime ?? -1,
    );
    expect(stoppedTime).toBeGreaterThanOrEqual(1.9);
    expect(stoppedTime).toBeLessThan(2.5);

    // Clicking Play clip highlights it; playing now continues past block 1's end (2.0s).
    await playClipButton.click();
    await expect(playClipButton).toHaveAttribute("aria-pressed", "true");
    await expect(playClipButton).toHaveAttribute("data-variant", "default");

    await page.getByRole("button", { name: "Play line 1" }).click();
    await expect
      .poll(
        () => page.evaluate(() => document.querySelector("video")?.currentTime ?? 0),
        { timeout: 5_000 },
      )
      .toBeGreaterThan(3.0);
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();

    // Pause, pick line 2 (4 -> 6s), start playing continuously, then click Play clip
    // again (un-highlighted) so it stops at line 2's end (~6.0s).
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page.getByRole("button", { name: "Play line 2" }).click();
    await expect
      .poll(
        () => page.evaluate(() => document.querySelector("video")?.currentTime ?? 0),
        { timeout: 5_000 },
      )
      .toBeGreaterThan(4.2);

    await playClipButton.click();
    await expect(playClipButton).toHaveAttribute("aria-pressed", "false");
    await expect(playClipButton).toHaveAttribute("data-variant", "outline");

    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeHidden({
      timeout: 5_000,
    });
    const stoppedAtBlock2End = await page.evaluate(
      () => document.querySelector("video")?.currentTime ?? -1,
    );
    expect(stoppedAtBlock2End).toBeGreaterThanOrEqual(5.9);
    expect(stoppedAtBlock2End).toBeLessThan(6.5);
  });

  test("Reset subtitles restores default transcript lines and is undoable", async ({ page }) => {
    await seedProjectFile(
      page,
      makeStep3Project("e2e-reset-subtitles", "Reset subtitles lecture", false),
    );
    await page.goto("/");
    await page
      .getByRole("complementary", { name: "Sessions" })
      .getByRole("button", { name: /Reset subtitles lecture/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Subtitles" })).toBeVisible();

    const rows = page.locator("[data-cue-row]");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("ประโยคแรกของบทเรียน");
    await expect(rows.nth(1)).toContainText("ประโยคที่สองของบทเรียน");

    // Edit the first line and delete the second line.
    await rows.nth(0).getByRole("button", { name: "Subtitle line 1" }).click();
    await page.locator('textarea[lang="th"]').fill("ข้อความที่แก้ไขแล้ว");
    await rows.nth(1).getByRole("button", { name: "Subtitle line 2" }).click();
    await page.getByRole("button", { name: "Delete line 2" }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0)).toContainText("ข้อความที่แก้ไขแล้ว");

    // Reset subtitles back to default.
    await page.getByRole("button", { name: "Reset subtitles", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Reset subtitles to default?")).toBeVisible();
    await dialog.getByRole("button", { name: "Reset subtitles", exact: true }).click();

    await expect(page.getByText("Subtitles reset to default")).toBeVisible();
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("ประโยคแรกของบทเรียน");
    await expect(rows.nth(1)).toContainText("ประโยคที่สองของบทเรียน");

    // The reset can also be undone.
    await page.locator('button[aria-label="Undo"]').click();
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0)).toContainText("ข้อความที่แก้ไขแล้ว");
  });

  test("resizes the subtitle editor and clip preview split and persists the layout", async ({
    page,
  }) => {
    await seedProjectFile(page, {
      ...makeStep3Project("e2e-step3-split", "Resizable split lecture"),
      sourcePath: null,
    });
    await page.goto("/");
    await page
      .getByRole("complementary", { name: "Sessions" })
      .getByRole("button", { name: /Resizable split lecture/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Subtitles" })).toBeVisible();

    const linesPanel = page.locator("#step3-lines");
    const previewPanel = page.locator("#step3-preview");
    const separator = page.getByRole("separator", {
      name: "Resize subtitle editor and preview",
    });
    await expect(separator).toBeVisible();

    const initialPreviewBox = await previewPanel.boundingBox();
    const initialLinesBox = await linesPanel.boundingBox();
    const initialSepBox = await separator.boundingBox();
    if (!initialPreviewBox || !initialLinesBox || !initialSepBox) {
      throw new Error("Step 3 split panels did not render");
    }
    expect(initialPreviewBox.width).toBeGreaterThanOrEqual(345);
    expect(initialPreviewBox.width).toBeLessThanOrEqual(375);

    // Hovering inside the cue list's right scrollbar lane does not trigger the resize handle.
    const cueScroller = linesPanel.locator("section > div.overflow-y-auto").first();
    const scrollerBox = await cueScroller.boundingBox();
    if (!scrollerBox) throw new Error("Cue scroller missing");
    await page.mouse.move(
      scrollerBox.x + scrollerBox.width - 2,
      scrollerBox.y + scrollerBox.height / 2,
    );
    await expect(separator).toHaveAttribute("data-separator", "inactive");

    // 1. Drag separator 200px left -> preview widens, lines narrows, monitor scales (e.g. 16:9).
    const sepStartX = initialSepBox.x + initialSepBox.width / 2;
    const sepCenterY = initialSepBox.y + initialSepBox.height / 2;
    await page.mouse.move(sepStartX, sepCenterY);
    await page.mouse.down();
    await page.mouse.move(sepStartX - 200, sepCenterY, { steps: 10 });
    await page.mouse.up();

    const widenedPreviewBox = await previewPanel.boundingBox();
    const narrowedLinesBox = await linesPanel.boundingBox();
    if (!widenedPreviewBox || !narrowedLinesBox) {
      throw new Error("Step 3 panels missing after resize");
    }
    expect(widenedPreviewBox.width).toBeGreaterThan(500);
    expect(narrowedLinesBox.width).toBeLessThan(initialLinesBox.width - 150);

    // Switching to 16:9 fills the wider monitor container.
    await page.getByRole("button", { name: "16:9" }).click();
    const monitorFrame = previewPanel.locator("div.bg-black").first();
    await expect
      .poll(async () => (await monitorFrame.boundingBox())?.width ?? 0)
      .toBeGreaterThan(450);

    // 2. Drag far left and far right -> respects minimum widths (>= 340px left, >= 320px right),
    // and keeps Focus the preview inside the preview panel at minimum width.
    const widenedSepBox = await separator.boundingBox();
    if (!widenedSepBox) throw new Error("Separator missing after resize");
    await page.mouse.move(widenedSepBox.x + widenedSepBox.width / 2, sepCenterY);
    await page.mouse.down();
    await page.mouse.move(40, sepCenterY, { steps: 10 });
    await page.mouse.up();

    const clampedLeftBox = await linesPanel.boundingBox();
    expect(clampedLeftBox?.width ?? 0).toBeGreaterThanOrEqual(338);

    const minLeftSepBox = await separator.boundingBox();
    if (!minLeftSepBox) throw new Error("Separator missing after left clamp");
    await page.mouse.move(minLeftSepBox.x + minLeftSepBox.width / 2, sepCenterY);
    await page.mouse.down();
    await page.mouse.move(1260, sepCenterY, { steps: 10 });
    await page.mouse.up();

    const clampedRightBox = await previewPanel.boundingBox();
    expect(clampedRightBox?.width ?? 0).toBeGreaterThanOrEqual(318);
    const focusButton = page.getByRole("button", { name: "Focus the preview" });
    const focusBtnBox = await focusButton.boundingBox();
    if (!clampedRightBox || !focusBtnBox) {
      throw new Error("Focus button or preview panel missing at minimum width");
    }
    expect(focusBtnBox.x + focusBtnBox.width).toBeLessThanOrEqual(
      clampedRightBox.x + clampedRightBox.width + 1,
    );

    // 3. Drag wider (~520px) and verify persistence across reload, step navigation, and preview focus.
    const clampedSepBox = await separator.boundingBox();
    if (!clampedSepBox) throw new Error("Separator missing after right clamp");
    const clampedSepX = clampedSepBox.x + clampedSepBox.width / 2;
    await page.mouse.move(clampedSepX, sepCenterY);
    await page.mouse.down();
    await page.mouse.move(clampedSepX - 220, sepCenterY, { steps: 10 });
    await page.mouse.up();

    const persistedBoxBefore = await previewPanel.boundingBox();
    expect(persistedBoxBefore?.width ?? 0).toBeGreaterThan(480);

    await page.reload();
    await page
      .getByRole("complementary", { name: "Sessions" })
      .getByRole("button", { name: /Resizable split lecture/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Subtitles" })).toBeVisible();

    const afterReloadBox = await previewPanel.boundingBox();
    expect(Math.abs((afterReloadBox?.width ?? 0) - (persistedBoxBefore?.width ?? 0))).toBeLessThan(
      6,
    );

    await page.getByRole("button", { name: "Back to clip discovery" }).click();
    await expect(page.getByRole("heading", { name: "Find clips" })).toBeVisible();
    await page.getByRole("button", { name: "Continue to subtitles" }).click();
    await expect(page.getByRole("heading", { name: "Subtitles" })).toBeVisible();

    const afterStepNavBox = await previewPanel.boundingBox();
    expect(Math.abs((afterStepNavBox?.width ?? 0) - (persistedBoxBefore?.width ?? 0))).toBeLessThan(
      6,
    );

    await page.getByRole("button", { name: "Focus the preview" }).click();
    await expect(page.getByRole("button", { name: "Close preview" })).toBeVisible();
    await page.getByRole("button", { name: "Close preview" }).click();

    const afterFocusBox = await previewPanel.boundingBox();
    expect(Math.abs((afterFocusBox?.width ?? 0) - (persistedBoxBefore?.width ?? 0))).toBeLessThan(
      6,
    );

    // 4. Keyboard ArrowLeft on the focused separator widens the preview without changing the selected line.
    const cue2Trigger = page.getByRole("button", { name: "Subtitle line 2" });
    await cue2Trigger.click();
    await expect(cue2Trigger).toHaveAttribute("aria-expanded", "true");

    await separator.focus();
    await page.keyboard.press("ArrowLeft");
    const afterKeyBox = await previewPanel.boundingBox();
    expect(afterKeyBox?.width ?? 0).toBeGreaterThan(afterFocusBox?.width ?? 0);
    await expect(cue2Trigger).toHaveAttribute("aria-expanded", "true");

    // 5. Double-clicking the separator resets preview back to the ~360px default.
    await separator.dblclick();
    await expect
      .poll(async () => (await previewPanel.boundingBox())?.width ?? 0)
      .toBeGreaterThanOrEqual(345);
    const resetBox = await previewPanel.boundingBox();
    expect(resetBox?.width ?? 0).toBeLessThanOrEqual(375);
  });

  test("Scissors button splits without blur race and CueRibbon cuts cleanly with no overlap", async ({
    page,
  }) => {
    const longThai = "ความอดทนเป็นครึ่งหนึ่งของความศรัทธาและการอดกลั้นเป็นประตูสู่ความสำเร็จ";
    const splitPoint = "ความอดทนเป็นครึ่งหนึ่งของความศรัทธา".length;
    const base = makeStep3Project("e2e-scissors-split", "Scissors split lecture");
    await seedProjectFile(page, {
      ...base,
      sourcePath: null,
      subtitles: {
        "e2e-scissors-split-clip": [
          { id: "cue-single", start: 0, end: 10, arabic: "", thai: longThai },
        ],
      },
    });
    await page.goto("/");
    await page
      .getByRole("complementary", { name: "Sessions" })
      .getByRole("button", { name: /Scissors split lecture/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Subtitles" })).toBeVisible();

    const track = page.getByRole("group", { name: "Subtitle track" });
    await expect(track.getByRole("button", { name: /^Subtitle line / })).toHaveCount(1);

    const textarea = page.locator('textarea[lang="th"]');
    await textarea.evaluate((el, pos) => {
      const field = el as HTMLTextAreaElement;
      field.focus();
      field.setSelectionRange(pos, pos);
    }, splitPoint);

    // Clicking the Scissors button keeps the live caret offset instead of blurring first.
    await page.getByRole("button", { name: "Split line at the cursor" }).click();

    const rows = page.locator("[data-cue-row]");
    await expect(rows).toHaveCount(2);
    const blocks = track.getByRole("button", { name: /^Subtitle line / });
    await expect(blocks).toHaveCount(2);

    const box0 = await blocks.nth(0).boundingBox();
    const box1 = await blocks.nth(1).boundingBox();
    if (!box0 || !box1) throw new Error("Split ribbon blocks missing");
    expect(box0.x + box0.width).toBeLessThanOrEqual(box1.x);

    await rows.nth(0).getByRole("button", { name: "Subtitle line 1" }).click();
    expect(await page.locator('textarea[lang="th"]').inputValue()).toBe(
      longThai.slice(0, splitPoint),
    );
    await rows.nth(1).getByRole("button", { name: "Subtitle line 2" }).click();
    const secondText = (await page.locator('textarea[lang="th"]').inputValue()).replace(/\n/g, "");
    expect(secondText).toBe(longThai.slice(splitPoint));
  });

async function readRowClockRange(row: Locator): Promise<[string, string]> {
  const clocks = row.locator("span.font-mono > span[aria-label]");
  const start = await clocks.nth(0).getAttribute("aria-label");
  const end = await clocks.nth(1).getAttribute("aria-label");
  return [start ?? "", end ?? ""];
}

function parseClockLabel(label: string): number {
  const parts = label.split(":").map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return Number.NaN;
}

  test("rolling seam drag shifts both abutting blocks and undoes in one step", async ({
    page,
  }) => {
    const base = makeStep3Project("e2e-rolling-seam", "Rolling seam lecture");
    await seedProjectFile(page, {
      ...base,
      sourcePath: null,
      subtitles: {
        "e2e-rolling-seam-clip": [
          { id: "cue-left", start: 0, end: 4, arabic: "", thai: "ครึ่งแรกของบรรทัด" },
          { id: "cue-right", start: 4.02, end: 10, arabic: "", thai: "ครึ่งหลังของบรรทัด" },
        ],
      },
    });
    await page.goto("/");
    await page
      .getByRole("complementary", { name: "Sessions" })
      .getByRole("button", { name: /Rolling seam lecture/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Subtitles" })).toBeVisible();

    const track = page.getByRole("group", { name: "Subtitle track" });
    const seam = track.getByRole("separator", { name: "Adjust cut between line 1 and line 2" });
    await expect(seam).toBeVisible();
    const trackBox = await track.boundingBox();
    const seamBox = await seam.boundingBox();
    if (!trackBox || !seamBox) throw new Error("Seam handle missing");

    const startX = seamBox.x + seamBox.width / 2;
    const centerY = seamBox.y + seamBox.height / 2;
    await page.mouse.move(startX, centerY);
    await page.mouse.down();
    await page.mouse.move(startX + trackBox.width * 0.2, centerY, { steps: 6 });
    await page.mouse.up();

    const rows = page.locator("[data-cue-row]");
    await expect
      .poll(async () => {
        const [start0, end0] = await readRowClockRange(rows.nth(0));
        const [start1, end1] = await readRowClockRange(rows.nth(1));
        const end0Sec = parseClockLabel(end0);
        const start1Sec = parseClockLabel(start1);
        return (
          start0 === "0:00.00" &&
          end1 === "0:10.00" &&
          end0Sec >= 5.8 &&
          end0Sec <= 6.2 &&
          Math.abs(start1Sec - (end0Sec + 0.02)) < 0.005
        );
      })
      .toBe(true);

    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect.poll(() => readRowClockRange(rows.nth(0))).toEqual(["0:00.00", "0:04.00"]);
    await expect.poll(() => readRowClockRange(rows.nth(1))).toEqual(["0:04.02", "0:10.00"]);
  });

  test("speech-aligned split uses segment pauses, word timings, and silence peaks", async ({
    page,
  }) => {
    // 1. Segment pause boundary: 1.2s end -> 2.5s start (not linear ~0.83s).
    const now = Date.now();
    await seedProjectFile(page, {
      schemaVersion: 1,
      id: "e2e-seg-align",
      name: "Segment align lecture",
      sourcePath: null,
      sourceFileName: "seg-align.mp4",
      duration: 10,
      step: 3,
      transcriptId: "e2e-seg-align-t",
      transcript: {
        language: "th",
        segments: [
          { id: 0, start: 0.0, end: 1.2, text: "ประโยคแรก", language: "th" },
          { id: 1, start: 2.5, end: 4.5, text: "ประโยคที่สองยาวมาก", language: "th" },
        ],
      },
      audioPath: null,
      basePrompt: "",
      promptPresetId: null,
      sessionGuide: "",
      clips: [
        {
          id: "seg-clip",
          title: "Pause clip",
          rationale: "",
          start: 0,
          end: 6,
          speechStart: 0,
          speechEnd: 4.5,
          approved: true,
          createdAt: now,
        },
      ],
      selectedClipId: "seg-clip",
      subtitles: {
        "seg-clip": [
          { id: "cue-merged", start: 0, end: 4.5, arabic: "", thai: "ประโยคแรกประโยคที่สองยาวมาก" },
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
      .getByRole("button", { name: /Segment align lecture/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Subtitles" })).toBeVisible();

    const segTextarea = page.locator('textarea[lang="th"]');
    await segTextarea.evaluate((el, offset) => {
      const field = el as HTMLTextAreaElement;
      field.focus();
      field.setSelectionRange(offset, offset);
    }, "ประโยคแรก".length);
    await page.keyboard.press("Control+Enter");
    const segRows = page.locator("[data-cue-row]");
    await expect.poll(() => readRowClockRange(segRows.nth(0))).toEqual(["0:00.00", "0:01.20"]);
    await expect.poll(() => readRowClockRange(segRows.nth(1))).toEqual(["0:02.50", "0:04.50"]);

    // 2. Word-level timing inside a single segment: cuts at real word gap 0.90 -> 3.10.
    await seedProjectFile(page, {
      schemaVersion: 1,
      id: "e2e-word-align",
      name: "Word align lecture",
      sourcePath: null,
      sourceFileName: "word-align.mp4",
      duration: 10,
      step: 3,
      transcriptId: "e2e-word-align-t",
      transcript: {
        language: "th",
        segments: [
          {
            id: 0,
            start: 0.2,
            end: 4.2,
            text: "สวัสดีทุกคน",
            language: "th",
            words: [
              { text: "สวัสดี", start: 0.2, end: 0.9 },
              { text: "ทุกคน", start: 3.1, end: 4.2 },
            ],
          },
        ],
      },
      audioPath: null,
      basePrompt: "",
      promptPresetId: null,
      sessionGuide: "",
      clips: [
        {
          id: "word-clip",
          title: "Word clip",
          rationale: "",
          start: 0,
          end: 6,
          speechStart: 0.2,
          speechEnd: 4.2,
          approved: true,
          createdAt: now,
        },
      ],
      selectedClipId: "word-clip",
      subtitles: {
        "word-clip": [{ id: "cue-w", start: 0.2, end: 4.2, arabic: "", thai: "สวัสดีทุกคน" }],
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
    await page.reload();
    await page
      .getByRole("complementary", { name: "Sessions" })
      .getByRole("button", { name: /Word align lecture/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Subtitles" })).toBeVisible();
    await page.locator('textarea[lang="th"]').evaluate((el, offset) => {
      const field = el as HTMLTextAreaElement;
      field.focus();
      field.setSelectionRange(offset, offset);
    }, "สวัสดี".length);
    await page.keyboard.press("Control+Enter");
    const wordRows = page.locator("[data-cue-row]");
    await expect.poll(() => readRowClockRange(wordRows.nth(0))).toEqual(["0:00.20", "0:00.90"]);
    await expect.poll(() => readRowClockRange(wordRows.nth(1))).toEqual(["0:03.10", "0:04.20"]);

    // 3. Silence valley fallback via transcript.peaks snaps cut away from 5.00s into 4.62s dip.
    const peaks = Array.from({ length: 40 }, (_, i) => (i === 18 ? 0.02 : 0.8));
    await seedProjectFile(page, {
      schemaVersion: 1,
      id: "e2e-peak-align",
      name: "Peak align lecture",
      sourcePath: null,
      sourceFileName: "peak-align.mp4",
      duration: 10,
      step: 3,
      transcriptId: "e2e-peak-align-t",
      transcript: {
        language: "th",
        segments: [{ id: 0, start: 0, end: 10, text: "ท่อนแรกท่อนสอง", language: "th" }],
        peaks,
      },
      audioPath: null,
      basePrompt: "",
      promptPresetId: null,
      sessionGuide: "",
      clips: [
        {
          id: "peak-clip",
          title: "Peak clip",
          rationale: "",
          start: 0,
          end: 10,
          speechStart: 0,
          speechEnd: 10,
          approved: true,
          createdAt: now,
        },
      ],
      selectedClipId: "peak-clip",
      subtitles: {
        "peak-clip": [{ id: "cue-p", start: 0, end: 10, arabic: "", thai: "ท่อนแรกท่อนสอง" }],
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
    await page.reload();
    await page
      .getByRole("complementary", { name: "Sessions" })
      .getByRole("button", { name: /Peak align lecture/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Subtitles" })).toBeVisible();
    await page.locator('textarea[lang="th"]').evaluate((el, offset) => {
      const field = el as HTMLTextAreaElement;
      field.focus();
      field.setSelectionRange(offset, offset);
    }, "ท่อนแรก".length);
    await page.keyboard.press("Control+Enter");
    const peakRows = page.locator("[data-cue-row]");
    await expect
      .poll(async () => {
        const [start, end] = await readRowClockRange(peakRows.nth(0));
        return start === "0:00.00" && /^0:04\.6\d$/.test(end);
      })
      .toBe(true);
  });

  test("scrubbing inside a block enables Split at playhead, and splitting pauses playback", async ({
    page,
  }) => {
    await installFakeVideoDriver(page);
    await page.route("https://media.example/**", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-length": "1024", "content-type": "video/mp4" },
        body: "",
      });
    });

    const base = makeStep3Project("e2e-playhead-split", "Playhead split lecture");
    await seedProjectFile(page, {
      ...base,
      subtitles: {
        "e2e-playhead-split-clip": [
          {
            id: "cue-full",
            start: 0,
            end: 10,
            arabic: "",
            thai: "ประโยคแรกของการบรรยาย ประโยคถัดมาของการบรรยาย",
          },
        ],
      },
    });
    await page.goto("/");
    await page
      .getByRole("complementary", { name: "Sessions" })
      .getByRole("button", { name: /Playhead split lecture/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Subtitles" })).toBeVisible();

    // Scrub the top ruler inside the single 0..10s cue to ~3.0s and click Split at playhead.
    const ruler = page.getByLabel("Scrub timeline");
    const rulerBox = await ruler.boundingBox();
    if (!rulerBox) throw new Error("Scrub ruler missing");
    await page.mouse.click(rulerBox.x + rulerBox.width * 0.3, rulerBox.y + rulerBox.height / 2);

    await page.getByRole("button", { name: "Split line at playhead" }).click();
    const rows = page.locator("[data-cue-row]");
    await expect(rows).toHaveCount(2);
    await expect
      .poll(async () => {
        const [start0, end0] = await readRowClockRange(rows.nth(0));
        const [start1, end1] = await readRowClockRange(rows.nth(1));
        const end0Sec = parseClockLabel(end0);
        const start1Sec = parseClockLabel(start1);
        return (
          start0 === "0:00.00" &&
          end1 === "0:10.00" &&
          end0Sec >= 2.9 &&
          end0Sec <= 3.1 &&
          Math.abs(start1Sec - (end0Sec + 0.02)) < 0.005
        );
      })
      .toBe(true);

    // Start playing line 2 (which is active) and split it mid-playback: video must pause.
    await page.getByRole("button", { name: "Play line 2" }).click();
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.querySelector("video")?.currentTime ?? 0))
      .toBeGreaterThan(3.4);

    await page.locator('textarea[lang="th"]').evaluate((el) => {
      const field = el as HTMLTextAreaElement;
      field.focus();
      const mid = Math.floor(field.value.length / 2);
      field.setSelectionRange(mid, mid);
    });
    await page.keyboard.press("Control+Enter");

    await expect(rows).toHaveCount(3);
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeHidden();
    const pausedAfterSplit = await page.evaluate(
      () => document.querySelector("video")?.paused ?? false,
    );
    expect(pausedAfterSplit).toBe(true);
  });
});

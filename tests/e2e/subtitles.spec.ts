import { expect, test, type Page } from "@playwright/test";

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

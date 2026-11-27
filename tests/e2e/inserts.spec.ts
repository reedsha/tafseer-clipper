import { expect, test, type Page } from "@playwright/test";

import { seedProjectFile } from "./fixtures";

/** 1x1 solid PNG used for instant image insert tests without external assets. */
const SAMPLE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function buildInsertProject(id: string, name: string, duration = 30) {
  const now = Date.now();
  return {
    schemaVersion: 1,
    id,
    name,
    sourcePath: "https://media.example/lecture.mp4",
    sourceFileName: `${name}.mp4`,
    duration: 120,
    step: 3,
    transcriptId: `${id}-t`,
    transcript: {
      language: "th",
      segments: [
        { id: 0, start: 0.5, end: 6.0, text: "ประโยคแรกของการบรรยาย", language: "th" },
        { id: 1, start: 8.0, end: 15.0, text: "ประโยคที่สองของการบรรยาย", language: "th" },
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
        end: duration,
        speechStart: 0.5,
        speechEnd: Math.max(1, duration - 1),
        approved: true,
        createdAt: now,
      },
    ],
    selectedClipId: `${id}-clip`,
    subtitles: {
      [`${id}-clip`]: [
        { id: "cue-1", start: 0.5, end: 6.0, arabic: "", thai: "ประโยคแรกของการบรรยาย" },
        { id: "cue-2", start: 8.0, end: 15.0, arabic: "", thai: "ประโยคที่สองของการบรรยาย" },
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
  };
}

/**
 * Fake video driver mapping blob URLs created from Buffers of length N*100 bytes
 * to duration N seconds (e.g. 2000 bytes -> 20s, 4500 bytes -> 45s) while keeping
 * lecture URLs at 60s.
 */
async function installInsertMediaDriver(page: Page) {
  await page.addInitScript(() => {
    const blobDurations = new Map<string, number>();
    const origCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (obj: Blob | MediaSource) {
      const url = origCreateObjectURL(obj);
      if (obj instanceof Blob && obj.type.startsWith("video/")) {
        const inferred = Math.max(1, Math.round(obj.size / 100));
        blobDurations.set(url, inferred);
      }
      return url;
    };

    const states = new WeakMap<
      HTMLMediaElement,
      { src: string; currentTime: number; paused: boolean; duration: number }
    >();
    const getState = (el: HTMLMediaElement) => {
      let s = states.get(el);
      if (!s) {
        s = { src: "", currentTime: 0, paused: true, duration: 60 };
        states.set(el, s);
      }
      return s;
    };

    const resolveDuration = (src: string) => blobDurations.get(src) ?? 60;

    const origSetAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name: string, value: string) {
      if (this instanceof HTMLVideoElement && name === "src") {
        const s = getState(this);
        s.src = value;
        s.duration = resolveDuration(value);
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
          s.duration = resolveDuration(s.src);
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
          return getState(this).duration;
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
          queueMicrotask(() => this.dispatchEvent(new Event("seeked")));
        },
      },
      play: {
        configurable: true,
        value() {
          const s = getState(this);
          s.paused = false;
          this.dispatchEvent(new Event("play"));
          return Promise.resolve();
        },
      },
      pause: {
        configurable: true,
        value() {
          const s = getState(this);
          s.paused = true;
          this.dispatchEvent(new Event("pause"));
        },
      },
    });
  });

  await page.route("https://media.example/**", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-length": "1024", "content-type": "video/mp4" },
      body: "",
    });
  });
}

async function openProject(page: Page, id: string, name: string) {
  await seedProjectFile(page, buildInsertProject(id, name, 30));
  await page.goto("/");
  await page
    .getByRole("complementary", { name: "Sessions" })
    .getByRole("button", { name: new RegExp(name) })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Subtitles" })).toBeVisible();
}

test.describe("Step 3 insert footage layer, timeline UX & collapsible sidebar", () => {
  test("image insert defaults to 5s, stretches to full clip, supports PowerPoint move/resize beneath subtitles", async ({
    page,
  }) => {
    await installInsertMediaDriver(page);
    await openProject(page, "e2e-ins-img", "Insert image lecture");

    const insertTrack = page.getByRole("group", { name: "Insert footage track" });
    await expect(insertTrack).toBeVisible();

    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Add media" }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles({
      name: "slide.png",
      mimeType: "image/png",
      buffer: Buffer.from(SAMPLE_PNG_BASE64, "base64"),
    });

    const block = insertTrack.locator("[data-insert-block]").first();
    await expect(block).toBeVisible();
    await expect(block).toHaveAttribute("aria-label", /0:00\.\d+ to 0:05\.\d+/);

    // Drag right edge of image insert to the end of the 30s clip.
    const trackBox = await insertTrack.boundingBox();
    const endHandle = block.locator('[data-insert-handle="end"]');
    const endHandleBox = await endHandle.boundingBox();
    if (!trackBox || !endHandleBox) throw new Error("Insert end handle missing");
    await page.mouse.move(
      endHandleBox.x + endHandleBox.width / 2,
      endHandleBox.y + endHandleBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(trackBox.x + trackBox.width - 2, endHandleBox.y + endHandleBox.height / 2, {
      steps: 8,
    });
    await page.mouse.up();

    await expect(block).toHaveAttribute("aria-label", /to 0:30\.0/);

    // Move playhead onto Subtitle line 2 (0:08.0 -> inside 0:00.6..0:30.0) so both subtitle + insert render.
    await page.getByRole("button", { name: "Subtitle line 2" }).click();

    // Verify overlay appears inside SubtitleMonitor and subtitles stay above it in DOM order.
    const previewPanel = page.locator("#step3-preview");
    const overlay = previewPanel.locator("[data-insert-overlay]").first();
    await expect(overlay).toBeVisible();
    const monitorFrame = overlay.locator("..");
    const frameBox = await monitorFrame.boundingBox();
    const initialOverlayBox = await overlay.boundingBox();
    if (!frameBox || !initialOverlayBox) throw new Error("Overlay box missing");
    expect(Math.abs(initialOverlayBox.width - frameBox.width)).toBeLessThan(3);

    const zOrderOk = await previewPanel.evaluate((root) => {
      const ins = root.querySelector("[data-insert-overlay]");
      const subText = root.querySelector('p[lang="th"]');
      if (!ins || !subText) return false;
      return Boolean(ins.compareDocumentPosition(subText) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(zOrderOk).toBe(true);

    // PowerPoint corner resize shrinks the box; Reset full frame restores 100%.
    const seHandle = overlay.locator('[data-insert-rect-handle="se"]');
    const seBox = await seHandle.boundingBox();
    if (!seBox) throw new Error("SE transform handle missing");
    await page.mouse.move(seBox.x + seBox.width / 2, seBox.y + seBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(seBox.x - 60, seBox.y - 80, { steps: 6 });
    await page.mouse.up();

    const resizedBox = await overlay.boundingBox();
    if (!resizedBox) throw new Error("Resized overlay missing");
    expect(resizedBox.width).toBeLessThan(frameBox.width - 30);

    await page.getByRole("button", { name: "Edit selected insert" }).click();
    await page.getByRole("button", { name: "Reset full frame" }).click();
    await expect
      .poll(async () => Math.abs(((await overlay.boundingBox())?.width ?? 0) - frameBox.width))
      .toBeLessThan(3);
  });

  test("video insert rejects > clip duration, applies Strategy B, trims front/end, and undoes", async ({
    page,
  }) => {
    await installInsertMediaDriver(page);
    await openProject(page, "e2e-ins-vid", "Insert video lecture");

    const insertTrack = page.getByRole("group", { name: "Insert footage track" });
    const ruler = page.getByLabel("Scrub timeline");
    const rulerBox = await ruler.boundingBox();
    if (!rulerBox) throw new Error("Scrub ruler missing");

    // Scrub playhead to ~25s of the 30s clip.
    await page.mouse.click(rulerBox.x + rulerBox.width * (25 / 30), rulerBox.y + rulerBox.height / 2);

    // 1. 45s video (> 30s clip) must be declined with a clear message.
    const tooLongChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Add media" }).click();
    const tooLongChooser = await tooLongChooserPromise;
    await tooLongChooser.setFiles({
      name: "too-long.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.alloc(4500),
    });
    await expect(page.getByText("Video is too long for this clip")).toBeVisible();
    await expect(insertTrack.locator("[data-insert-block]")).toHaveCount(0);

    // 2. 20s video at playhead 25s shifts start earlier to 10s -> 30s (Strategy B).
    const vidChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Add media" }).click();
    const vidChooser = await vidChooserPromise;
    await vidChooser.setFiles({
      name: "broll-20s.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.alloc(2000),
    });

    const block = insertTrack.locator("[data-insert-block]").first();
    await expect(block).toBeVisible();
    await expect(block).toHaveAttribute("aria-label", /0:10\.0 to 0:30\.0/);

    // 3. Drag left edge inward (+5s) -> front-trims to ~15s -> 30s.
    const trackBox = await insertTrack.boundingBox();
    const startHandle = block.locator('[data-insert-handle="start"]');
    const startBox = await startHandle.boundingBox();
    if (!trackBox || !startBox) throw new Error("Insert start handle missing");
    const centerY = startBox.y + startBox.height / 2;
    await page.mouse.move(startBox.x + startBox.width / 2, centerY);
    await page.mouse.down();
    await page.mouse.move(trackBox.x + trackBox.width * (15 / 30), centerY, { steps: 6 });
    await page.mouse.up();
    await expect(block).toHaveAttribute("aria-label", /0:14\.\d to 0:30\.0|0:15\.\d to 0:30\.0/);

    // 4. Drag left edge past 0s (far left) -> stops at 10.0s (sourceStart=0, never > 20s!).
    const startBoxAfter = await startHandle.boundingBox();
    if (!startBoxAfter) throw new Error("Insert start handle missing after trim");
    await page.mouse.move(startBoxAfter.x + startBoxAfter.width / 2, centerY);
    await page.mouse.down();
    await page.mouse.move(trackBox.x + 2, centerY, { steps: 8 });
    await page.mouse.up();
    await expect(block).toHaveAttribute("aria-label", /0:10\.0 to 0:30\.0/);

    // 5. Undo reverts the front-trim cleanly.
    await page.locator('button[aria-label="Undo"]').click();
    await expect(block).toHaveAttribute("aria-label", /0:14\.\d to 0:30\.0|0:15\.\d to 0:30\.0/);

    // 6. Drag the front-trimmed block earlier, then try stretching tail past 30s:
    // remaining media (sourceDuration - sourceStart ~= 15s) caps the right edge below 30s.
    const bodyBox = await block.boundingBox();
    if (!bodyBox) throw new Error("Insert block bounding box missing");
    await page.mouse.move(bodyBox.x + bodyBox.width / 2, centerY);
    await page.mouse.down();
    await page.mouse.move(bodyBox.x + bodyBox.width / 2 - trackBox.width * (10 / 30), centerY, {
      steps: 6,
    });
    await page.mouse.up();
    const endHandle = block.locator('[data-insert-handle="end"]');
    const endBox = await endHandle.boundingBox();
    if (!endBox) throw new Error("Insert end handle missing");
    await page.mouse.move(endBox.x + endBox.width / 2, centerY);
    await page.mouse.down();
    await page.mouse.move(trackBox.x + trackBox.width - 4, centerY, { steps: 8 });
    await page.mouse.up();
    await expect(block).not.toHaveAttribute("aria-label", /to 0:30\.0/);
  });

  test("literal Ctrl+V pastes image onto insert track while ignoring textareas", async ({
    page,
  }) => {
    await installInsertMediaDriver(page);
    await openProject(page, "e2e-ins-paste", "Paste insert lecture");

    const insertTrack = page.getByRole("group", { name: "Insert footage track" });

    // Dispatching paste while focused in Thai textarea must NOT add an insert.
    const textarea = page.locator('textarea[lang="th"]');
    await textarea.focus();
    await page.evaluate((b64) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bin], "clip-shot.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const evt = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      document.activeElement?.dispatchEvent(evt);
    }, SAMPLE_PNG_BASE64);
    await expect(insertTrack.locator("[data-insert-block]")).toHaveCount(0);

    // Blurring the textarea and pasting on the workspace adds the image insert.
    await textarea.blur();
    await page.evaluate((b64) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bin], "pasted-slide.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const evt = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(evt);
    }, SAMPLE_PNG_BASE64);

    const block = insertTrack.locator("[data-insert-block]").first();
    await expect(block).toBeVisible();
    await expect(block).toContainText("pasted-slide.png");
    await expect(block).toHaveAttribute("aria-label", /0:00\.\d+ to 0:05\.\d+/);
  });

  test("wheel zoom is scoped to timeline tracks, timeline drags vertically, and Sessions sidebar collapses", async ({
    page,
  }) => {
    await installInsertMediaDriver(page);
    await openProject(page, "e2e-ins-ux", "Timeline UX lecture");

    const zoomResetBtn = page.getByRole("button", { name: "Reset subtitle track zoom" });
    await expect(zoomResetBtn).toHaveText("1×");

    // 1. Wheel over subtitle lines list must NOT zoom the timeline.
    const cueList = page.locator("#step3-lines");
    const cueListBox = await cueList.boundingBox();
    if (!cueListBox) throw new Error("Cue list missing");
    await page.mouse.move(cueListBox.x + cueListBox.width / 2, cueListBox.y + cueListBox.height / 2);
    await page.mouse.wheel(0, -240);
    await expect(zoomResetBtn).toHaveText("1×");

    // 2. Wheel over timeline tracks zooms both Subtitle track and Insert track together.
    const tracks = page.locator("[data-timeline-tracks]");
    const tracksBox = await tracks.boundingBox();
    if (!tracksBox) throw new Error("Timeline tracks missing");
    await page.mouse.move(tracksBox.x + tracksBox.width / 2, tracksBox.y + tracksBox.height / 2);
    await page.mouse.wheel(0, -240);
    await expect(zoomResetBtn).not.toHaveText("1×");

    const cueTrackWidth = (await page.getByRole("group", { name: "Subtitle track" }).boundingBox())?.width ?? 0;
    const insTrackWidth = (await page.getByRole("group", { name: "Insert footage track" }).boundingBox())?.width ?? 0;
    expect(cueTrackWidth).toBeGreaterThan(tracksBox.width + 20);
    expect(Math.abs(cueTrackWidth - insTrackWidth)).toBeLessThan(2);

    // 3. Drag vertical resize handle upward -> timeline & tracks grow taller.
    const initialTimelineHeight = (await page.locator("#step3-timeline-pane").boundingBox())?.height ?? 0;
    const vSep = page.getByRole("separator", { name: "Resize preview and timeline" });
    const vSepBox = await vSep.boundingBox();
    if (!vSepBox) throw new Error("Vertical timeline handle missing");
    await page.mouse.move(vSepBox.x + vSepBox.width / 2, vSepBox.y + vSepBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(vSepBox.x + vSepBox.width / 2, vSepBox.y - 100, { steps: 6 });
    await page.mouse.up();
    const grownTimelineHeight = (await page.locator("#step3-timeline-pane").boundingBox())?.height ?? 0;
    expect(grownTimelineHeight).toBeGreaterThan(initialTimelineHeight + 60);

    // 4. Collapsible Sessions sidebar via button + Ctrl+B + persistence across reload.
    const sidebar = page.getByRole("complementary", { name: "Sessions" });
    await expect(sidebar).toBeVisible();
    await page.getByRole("button", { name: "Collapse sessions" }).click();
    await expect(sidebar).toBeHidden();
    const showBtn = page.getByRole("button", { name: "Show sessions" });
    await expect(showBtn).toBeVisible();

    await page.reload();
    await expect(sidebar).toBeHidden();
    await page.keyboard.press("Control+b");
    await expect(sidebar).toBeVisible();
  });
});

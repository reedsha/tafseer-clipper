/**
 * Hardware-encoding E2E: the Step 4 switch must explain *why* it is off using
 * the additive `/health.acceleration.encoding_reason`, never send the user to
 * the GPU pack (which powers transcription only), and turn on after
 * "Check again" re-probes (`/health?refresh=1`) and the encoder now works.
 */

import { expect, test } from "@playwright/test";

import { CLIP1_ID, PROJECT, PROJECT_NAME, seedProjectFile } from "./fixtures";

function healthBody(encodingGpu: boolean): string {
  return JSON.stringify({
    status: "ok",
    version: "0.1.0-test",
    cuda_available: true,
    nvenc_available: encodingGpu,
    vram_mb: 8192,
    ffmpeg_available: true,
    ffmpeg_path: null,
    ffprobe_available: true,
    fonts_dir: "",
    work_dir: "",
    disk_cache_bytes: 0,
    whisper: { model: "", loaded: false, device: "cuda", compute_type: "int8" },
    acceleration: {
      transcription: "gpu",
      encoding: encodingGpu ? "gpu" : "cpu",
      gpu_detected: true,
      gpu_name: "Test Adapter",
      cuda_runtime: true,
      pack_installed: true,
      reason: null,
      encoding_reason: encodingGpu ? null : "driver-too-old",
      encoding_detail: encodingGpu
        ? null
        : "[h264_nvenc @ 0x0] Driver does not support the required nvenc API version. Required: 13.0 Found: 12.1",
    },
  });
}

test.describe("hardware encoding", () => {
  test("Step 4 explains an outdated driver and re-enables after Check again", async ({ page }) => {
    await seedProjectFile(page, {
      ...PROJECT,
      step: 4,
      clips: PROJECT.clips.map((clip) => (clip.id === CLIP1_ID ? { ...clip, approved: true } : clip)),
    });

    let encoderWorks = false;
    let refreshed = false;
    await page.route("**/health*", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("refresh") === "1") {
        refreshed = true;
        encoderWorks = true;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: healthBody(encoderWorks),
      });
    });

    await page.goto("/");
    const sidebar = page.getByRole("complementary", { name: "Sessions" });
    await sidebar.getByRole("button", { name: new RegExp(PROJECT_NAME) }).first().click();
    await expect(page.getByRole("heading", { name: "Export", exact: true })).toBeVisible();

    const toggle = page.getByRole("switch", { name: "Use hardware encoding when available" });
    await expect(toggle).toBeDisabled();
    await expect(page.getByText(/graphics driver is too old for hardware encoding/)).toBeVisible();
    // The GPU pack cannot fix encoding, so Step 4 must not point at it.
    await expect(page.getByText(/Turn on GPU acceleration in Settings/)).toHaveCount(0);

    await page.getByRole("button", { name: "Check again" }).click();
    await expect.poll(() => refreshed).toBe(true);
    await expect(toggle).toBeEnabled();
    await expect(toggle).toBeChecked();
    await expect(page.getByRole("button", { name: "Check again" })).toHaveCount(0);
  });
});

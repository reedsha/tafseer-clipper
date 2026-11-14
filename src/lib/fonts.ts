/**
 * Imported-font registration for the WebView preview.
 *
 * `POST /fonts/import` copies a `.ttf`/`.otf` into the sidecar's fonts
 * directory and returns its absolute path. FFmpeg's `ass` filter resolves that
 * file through `fontsdir`, but the WebView only sees *system* fonts — so the
 * Step 3 preview would render a different typeface than the burned video
 * (AUDIT_REPORT §B1a). Registering the file with the CSS Font Loading API
 * (`FontFace` + `document.fonts`) makes both sides resolve the same family.
 *
 * The file bytes are read through Tauri's asset protocol (`convertFileSrc`,
 * via `toMediaSrc`). In a plain browser that returns `null` and we silently
 * keep the system-font fallback, so the preview still works.
 */

import type { FontInfo } from "@/lib/api";
import { toMediaSrc } from "@/lib/media";

/** `family::style` keys already registered with `document.fonts`. */
const registered = new Set<string>();

export function fontFaceKey(font: FontInfo): string {
  return `${font.family}::${font.style}`;
}

function styleFromName(style: string): "normal" | "italic" | "oblique" {
  const normalized = style.toLowerCase();
  if (normalized.includes("italic")) return "italic";
  if (normalized.includes("oblique")) return "oblique";
  return "normal";
}

function weightFromName(style: string): string {
  const normalized = style.toLowerCase();
  if (normalized.includes("bold")) return "700";
  if (normalized.includes("light")) return "300";
  return "400";
}

/**
 * Register every imported font that is not yet available to the WebView.
 * Returns the number of faces actually added. Never throws: a failed face
 * keeps the CSS fallback chain and is retried on the next call.
 */
export async function loadImportedFonts(fonts: FontInfo[]): Promise<number> {
  if (typeof document === "undefined" || typeof FontFace === "undefined") return 0;

  let added = 0;
  for (const font of fonts) {
    if (!font.family.trim() || !font.path.trim()) continue;
    const key = fontFaceKey(font);
    if (registered.has(key)) continue;

    const src = toMediaSrc(font.path);
    if (!src) continue; // Plain browser: no asset protocol, use system fonts.

    try {
      const face = new FontFace(font.family, `url("${src}")`, {
        style: styleFromName(font.style),
        weight: weightFromName(font.style),
      });
      await face.load();
      document.fonts.add(face);
      registered.add(key);
      added += 1;
    } catch {
      /* Unreadable file or blocked asset URL — keep the system fallback. */
    }
  }
  return added;
}

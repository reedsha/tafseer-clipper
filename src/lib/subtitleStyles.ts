/**
 * The `.ass` style contract, mirrored from `backend/services/subtitle_gen.py`.
 *
 * Step 3 previews with these numbers and Step 4 sends them to the sidecar, so
 * the burned-in subtitles match the editor's preview. Keep the defaults below
 * in sync with `subtitle_gen.default_styles()`.
 */

import subtitleContract from "../../backend/data/subtitle_contract.json";
import type { StyleSpec } from "@/lib/api";
import type { Resolution } from "@/lib/projectTypes";

export interface AssStyle {
  name: string;
  font: string;
  size: number;
  primaryColor: string;
  outlineColor: string;
  backColor: string;
  /** 0 = outline only (BorderStyle 1); >0 = opaque box (BorderStyle 3). */
  boxOpacity: number;
  bold: boolean;
  outline: number;
  shadow: number;
  marginV: number;
  marginL: number;
  marginR: number;
  /** Extra leading that keeps Arabic diacritics (Harakat) from clipping. */
  lineHeightPad: number;
}

export const ASS_RESOLUTIONS: Record<Resolution, { width: number; height: number }> = {
  "1080x1920": { width: 1080, height: 1920 },
  "1920x1080": { width: 1920, height: 1080 },
};

/** A style override may also carry the editor's vertical nudge. */
export type StyleOverride = Partial<AssStyle> & { verticalOffset?: number };

export type SubtitleLine = "arabic" | "thai";

/**
 * `StyleSpec.margin_v` is capped at 1000 by the sidecar, and the Harakat
 * padding adds a few pixels on top, so leave headroom before that ceiling.
 */
const MAX_MARGIN_V = 900;

function clampMarginV(value: number): number {
  return Math.min(MAX_MARGIN_V, Math.max(0, Math.round(value)));
}

/**
 * Clamp a stored offset so the resolved line anchor stays inside the frame.
 * Export resolution governs the bound so a line placed in the editor can
 * never be pushed out of frame in the burned video.
 */
export function clampVerticalOffset(
  kind: SubtitleLine,
  resolution: Resolution,
  offset: number,
): number {
  const base = defaultAssStyles(resolution)[kind].marginV;
  return clampMarginV(base + offset) - base;
}

/** Increment a line's offset by `delta` export pixels, staying inside the frame. */
export function nudgeVerticalOffset(
  kind: SubtitleLine,
  resolution: Resolution,
  current: number,
  delta: number,
): number {
  if (!Number.isFinite(delta) || delta === 0) return current;
  return clampVerticalOffset(kind, resolution, current + delta);
}

function style(partial: AssStyle): AssStyle {
  return partial;
}

/**
 * Fallback styles when the editor has no override. These mirror the app's
 * `DEFAULT_ARABIC` / `DEFAULT_THAI` (`store/settingsStore.ts`) so the preview
 * and the burned `.ass` agree even before the first settings change. The
 * sidecar owns the final values via `StyleSpec`; `subtitle_gen.default_styles`
 * must stay numerically compatible with this table.
 */
export function defaultAssStyles(resolution: Resolution): {
  arabic: AssStyle;
  thai: AssStyle;
} {
  const entry = subtitleContract[resolution] ?? subtitleContract["1080x1920"];
  return {
    arabic: style({ ...entry.arabic }),
    thai: style({ ...entry.thai }),
  };
}

/**
 * Apply the editor's style overrides on top of the resolution defaults, the
 * same way the sidecar's `_style_from_spec` does.
 */
export function resolveAssStyles(
  resolution: Resolution,
  arabicOverride?: StyleOverride | null,
  thaiOverride?: StyleOverride | null,
): { arabic: AssStyle; thai: AssStyle } {
  const base = defaultAssStyles(resolution);
  const merge = (target: AssStyle, override?: StyleOverride | null): AssStyle => {
    const anchor = override?.marginV ?? target.marginV;
    const offset = override?.verticalOffset ?? 0;
    return {
      ...target,
      ...(override
        ? {
            font: override.font || target.font,
            size: override.size || target.size,
            primaryColor: override.primaryColor || target.primaryColor,
            outlineColor: override.outlineColor || target.outlineColor,
            backColor: override.backColor || target.backColor,
            boxOpacity: override.boxOpacity ?? target.boxOpacity,
            bold: override.bold ?? target.bold,
            outline: override.outline ?? target.outline,
            shadow: override.shadow ?? target.shadow,
            marginV: clampMarginV(anchor + offset),
            marginL: override.marginL ?? target.marginL,
            marginR: override.marginR ?? target.marginR,
            lineHeightPad: override.lineHeightPad ?? target.lineHeightPad,
          }
        : {}),
    };
  };

  return {
    arabic: merge(base.arabic, arabicOverride),
    thai: merge(base.thai, thaiOverride),
  };
}

/**
 * Convert a resolved style into the sidecar's `StyleSpec` payload.
 *
 * `line_height_pad` is not an ASS field: the sidecar maps the extra leading to
 * an upward shift of the line anchor (`margin_v + round((pad - 1) * size / 2)`)
 * so the Harakat control genuinely changes the burned output. `box_opacity`
 * 0 keeps BorderStyle 1 (outline only); >0 switches to BorderStyle 3.
 */
export function assStyleToSpec(style: AssStyle): StyleSpec {
  return {
    font: style.font,
    size: style.size,
    color: style.primaryColor,
    outline: style.outline,
    shadow: style.shadow,
    margin_v: style.marginV,
    margin_l: style.marginL,
    margin_r: style.marginR,
    bold: style.bold,
    outline_color: style.outlineColor,
    box_opacity: style.boxOpacity,
    line_height_pad: style.lineHeightPad,
  };
}

/**
 * Vertical collision check: ASS anchors each line's *bottom* at its own
 * `MarginV`, so a tall Thai line can push into the Arabic line above it.
 */
export function stylesOverlap(
  arabic: AssStyle,
  thai: AssStyle,
): { overlaps: boolean; gap: number } {
  const thaiTop = thai.marginV + thai.size * thai.lineHeightPad;
  const gap = arabic.marginV - thaiTop;
  return { overlaps: gap < 0, gap };
}

export interface PreviewLineMetrics {
  /** Distance of the line's baseline box from the bottom, in pixels. */
  bottomPx: number;
  /** Font size in pixels, scaled to the preview width. */
  fontPx: number;
  /** Line box height in pixels (font size x line-height). */
  lineHeightPx: number;
  leftPx: number;
  rightPx: number;
  outlinePx: number;
}

/**
 * Metrics for one `.ass` dialogue line inside a preview box of
 * `previewWidth` pixels wide. The preview scales the `PlayRes` canvas so the
 * type sits where the burned-in subtitle will sit.
 */
export function previewLineMetrics(
  style: AssStyle,
  resolution: Resolution,
  previewWidth: number,
): PreviewLineMetrics {
  const play = ASS_RESOLUTIONS[resolution];
  const scale = previewWidth / play.width;
  return {
    bottomPx: style.marginV * scale,
    fontPx: style.size * scale,
    lineHeightPx: style.size * style.lineHeightPad * scale,
    leftPx: style.marginL * scale,
    rightPx: style.marginR * scale,
    outlinePx: Math.max(0, style.outline * scale),
  };
}

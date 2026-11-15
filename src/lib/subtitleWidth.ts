/**
 * Thai line-width estimate for the Settings hint.
 *
 * `maxCharsPerLine` and the Thai font size are independent controls, but they
 * multiply into one physical quantity: how wide a full Thai line gets inside
 * the `.ass` text column (frame width minus `MarginL`/`MarginR`). Neither
 * control can know the other is out of range, so the drawer measures the pair
 * and warns before a render does.
 *
 * Measurement reuses the `font: <size>px <family>` string the Step 3 preview
 * uses, so a font the webview cannot resolve (an import that FFmpeg resolves
 * from `fonts/`) falls back exactly as the preview does.
 */
import type { Resolution } from "./projectTypes";
import { NUMERIC_LIMITS } from "./settingsLimits";
import { ASS_RESOLUTIONS, defaultAssStyles } from "./subtitleStyles";

/**
 * Thai prose with the vowel/tone-mark density of transcribed speech. Thai
 * combining marks have zero advance, so a character-count estimate needs a
 * representative sample rather than a single glyph.
 */
const SAMPLE =
  "การอ่านอัลกุรอานทุกวันช่วยให้ใจสงบและเข้าใจความหมายของอายะฮ์ได้ลึกซึ้งยิ่งขึ้น " +
  "วันนี้เราจะมาเรียนรู้คำศัพท์ใหม่ที่ปรากฏในซูเราะฮ์นี้ด้วยกัน";

/** Average advance per character as a fraction of the em, for no-canvas cases. */
const FALLBACK_ADVANCE_RATIO = 0.4;

let measureContext: CanvasRenderingContext2D | null | undefined;

function getMeasureContext(): CanvasRenderingContext2D | null {
  if (measureContext !== undefined) return measureContext;
  if (typeof document === "undefined") {
    measureContext = null;
    return measureContext;
  }
  try {
    measureContext = document.createElement("canvas").getContext("2d");
  } catch {
    measureContext = null;
  }
  return measureContext;
}

function cssFamily(fontFamily: string): string {
  return fontFamily.includes(" ") ? `"${fontFamily}"` : fontFamily;
}

/** Width of one average Thai character at `fontSizePx`, in `.ass` pixels. */
export function thaiAdvancePx(
  fontFamily: string,
  fontSizePx: number,
  bold = false,
): number {
  const fallback = Math.max(0, fontSizePx) * FALLBACK_ADVANCE_RATIO;
  const context = getMeasureContext();
  if (!context || !Number.isFinite(fontSizePx) || fontSizePx <= 0) return fallback;
  context.font = `${bold ? "bold " : ""}${fontSizePx}px ${cssFamily(fontFamily)}`;
  const width = context.measureText(SAMPLE).width;
  if (!Number.isFinite(width) || width <= 0) return fallback;
  return width / SAMPLE.length;
}

/** The `.ass` text column the Thai line is centred inside. */
export function thaiColumnWidthPx(resolution: Resolution): number {
  const { width } = ASS_RESOLUTIONS[resolution];
  const { thai } = defaultAssStyles(resolution);
  return width - thai.marginL - thai.marginR;
}

export interface ThaiLineFit {
  /** Widest line the column allows, in `.ass` pixels. */
  columnPx: number;
  /** Estimated width of a full line at the current font size / char count. */
  linePx: number;
  /** `linePx / columnPx`; above 1 the line overruns the column. */
  fill: number;
  fits: boolean;
  /** Largest `maxCharsPerLine` that still fits, clamped to the slider range. */
  suggestedMaxChars: number;
}

export function estimateThaiLineFit({
  fontFamily,
  fontSize,
  maxChars,
  resolution,
  bold = false,
}: {
  fontFamily: string;
  fontSize: number;
  maxChars: number;
  resolution: Resolution;
  bold?: boolean;
}): ThaiLineFit {
  const columnPx = thaiColumnWidthPx(resolution);
  const advance = thaiAdvancePx(fontFamily, fontSize, bold);
  const linePx = advance * maxChars;
  const fill = columnPx > 0 ? linePx / columnPx : 0;
  const room = advance > 0 ? Math.floor(columnPx / advance) : maxChars;
  const suggestedMaxChars = Math.min(
    NUMERIC_LIMITS.maxCharsPerLine.max,
    Math.max(NUMERIC_LIMITS.maxCharsPerLine.min, room),
  );
  return { columnPx, linePx, fill, fits: fill <= 1, suggestedMaxChars };
}

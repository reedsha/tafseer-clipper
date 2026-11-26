/**
 * Thai subtitle line wrapping, shared by the Step 3 editor (wrap on commit)
 * and the render payload builder (`renderStore`) so the burned-in `.ass` and
 * the preview can never drift.
 */

interface WordSegmenter {
  segment(text: string): Iterable<{ segment: string }>;
}

type WordSegmenterCtor = new (
  locales?: string,
  options?: { granularity: "word" | "grapheme" | "sentence" },
) => WordSegmenter;

const WordSegmenterClass = (Intl as unknown as { Segmenter?: WordSegmenterCtor }).Segmenter;

let thaiSegmenter: WordSegmenter | null | undefined;

/** Dictionary-backed Thai word segmenter, or `null` when unsupported. */
function getThaiSegmenter(): WordSegmenter | null {
  if (thaiSegmenter !== undefined) return thaiSegmenter;
  if (!WordSegmenterClass) {
    thaiSegmenter = null;
    return thaiSegmenter;
  }
  try {
    thaiSegmenter = new WordSegmenterClass("th", { granularity: "word" });
  } catch {
    thaiSegmenter = null;
  }
  return thaiSegmenter;
}

/**
 * Wrap one physical line at `maxChars`, breaking only between word chunks.
 * `Intl.Segmenter` returns the whitespace chunks too, so joining them back
 * verbatim preserves the original spacing (and never inserts spaces between
 * Thai words). The space-split fallback joins with a single space.
 */
function splitLine(line: string, maxChars: number): string[] {
  if (line.length <= maxChars) return line ? [line] : [];
  const segmenter = getThaiSegmenter();
  const chunks = segmenter
    ? [...segmenter.segment(line)].map((part) => part.segment)
    : line.split(" ");
  const glue = segmenter ? "" : " ";
  const out: string[] = [];
  let current = "";
  for (const chunk of chunks) {
    if (!current) {
      current = chunk;
      continue;
    }
    if (current.length + glue.length + chunk.length <= maxChars) {
      current += `${glue}${chunk}`;
    } else {
      out.push(current.trim());
      current = chunk;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out.filter(Boolean);
}

function wrapLine(line: string, maxChars: number): string {
  return splitLine(line, maxChars).join("\n");
}

/**
 * Wrap Thai text at `maxChars` per line using a hard break, which the `.ass`
 * generator turns into `\N` — exactly how the burned-in subtitle wraps.
 *
 * Thai has no inter-word spaces, so wrapping is driven by `Intl.Segmenter`
 * (`granularity: "word"`, dictionary-based in Chromium). Re-wrapping an
 * already-wrapped value is idempotent: existing breaks are handled per line.
 */
export function wrapSubtitleText(text: string, maxChars: number): string {
  if (maxChars <= 0 || !text.trim()) return text;
  return text
    .split("\n")
    .map((line) => wrapLine(line, maxChars))
    .join("\n");
}

/**
 * Every offset where a line-break is *safe* for `text`, excluding the two
 * ends. Thai boundaries come from the dictionary segmenter (Chrome segments
 * without spaces, so a raw index would land inside a word); Arabic splits on
 * whitespace, which can never land between a letter and its Harakat.
 */
export function wordBoundaries(text: string, kind: "thai" | "arabic"): number[] {
  const boundaries: number[] = [];
  if (!text) return boundaries;
  if (kind === "thai") {
    const segmenter = getThaiSegmenter();
    if (segmenter) {
      let offset = 0;
      for (const part of segmenter.segment(text)) {
        offset += part.segment.length;
        if (offset > 0 && offset < text.length) boundaries.push(offset);
      }
      return boundaries;
    }
    for (let index = 1; index < text.length; index += 1) {
      if (/\s/.test(text[index]) || /\s/.test(text[index - 1])) boundaries.push(index);
    }
    return boundaries;
  }
  for (let index = 1; index < text.length; index += 1) {
    if (/\s/.test(text[index - 1])) boundaries.push(index);
  }
  return boundaries;
}

/**
 * The nearest safe break offset to `ratio` of the text length.
 *
 * Returns `0` when the text offers no usable break (a single Arabic word, say):
 * callers treat that as "cannot split here" instead of severing a glyph cluster
 * or withdrawing a Harakat from its letter.
 */
export function splitAtWordBoundary(
  text: string,
  ratio: number,
  kind: "thai" | "arabic",
): number {
  if (!text) return 0;
  const target = Math.round(text.length * (Number.isFinite(ratio) ? ratio : 0.5));
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const boundary of wordBoundaries(text, kind)) {
    const distance = Math.abs(boundary - target);
    if (distance < bestDistance) {
      best = boundary;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Wrap Arabic at `maxChars` per line, joining words with `\N` hard breaks.
 *
 * Arabic has inter-word spaces but attached Harakat, so a whitespace split is
 * the only safe break: a character-count cut would separate a letter from its
 * vowel marks (or split a word in half) and corrupt the verse. A word longer
 * than the limit is left whole rather than mutilated.
 */
const ARABIC_COMBINING_REGEX = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g;

export function arabicVisualLength(text: string): number {
  return text.replace(ARABIC_COMBINING_REGEX, "").length;
}

export function wrapArabicText(text: string, maxChars: number): string {
  if (maxChars <= 0 || !text.trim()) return text;
  return text
    .split("\n")
    .map((line) => {
      const words = line.trim().split(/\s+/).filter(Boolean);
      if (words.length === 0) return "";
      const out: string[] = [];
      let current = "";
      let currentVisualLength = 0;
      for (const word of words) {
        const wordVisual = arabicVisualLength(word);
        if (!current) {
          current = word;
          currentVisualLength = wordVisual;
          continue;
        }
        if (currentVisualLength + 1 + wordVisual <= maxChars) {
          current += ` ${word}`;
          currentVisualLength += 1 + wordVisual;
        } else {
          out.push(current);
          current = word;
          currentVisualLength = wordVisual;
        }
      }
      if (current) out.push(current);
      return out.join("\n");
    })
    .join("\n");
}

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
function wrapLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line;
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
  return out.join("\n");
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

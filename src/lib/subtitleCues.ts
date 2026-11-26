/**
 * Build editor-ready subtitle lines from a transcript.
 *
 * Two independent tracks are produced from the Step-1 transcript:
 * - **Thai sentence cues** — whole words, one sentence per cue, max
 *   ``maxLines`` physical lines; a sentence longer than that is split only at
 *   word/clause boundaries.
 * - **Arabic-only cues** — the recovered Arabic recitation is its own cue
 *   (empty Thai line), never paired with the Thai explanation.
 *
 * The transcript carries the language and sentence group from Stage 1.  The
 * word stream is the safety net: a line never starts or ends inside a word, and
 * character-level STT still reconstructs whole Thai words with real timings.
 */

import type { SubtitleCue, TranscriptSegment } from "@/lib/projectTypes";
import { arabicVisualLength, wrapArabicText, wrapSubtitleText } from "@/lib/subtitleWrap";

type SegmenterLike<T> = { segment(input: string): Iterable<T> };
type SegmenterCtor = new (
  locales?: string,
  options?: { granularity: "grapheme" | "word" | "sentence" },
) => SegmenterLike<{ segment: string; index: number }>;

const _SegmenterClass = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;

const GRAPHEME_SEGMENTER: SegmenterLike<{ segment: string; index: number }> | null = (() => {
  if (!_SegmenterClass) return null;
  try {
    return new _SegmenterClass(undefined, { granularity: "grapheme" });
  } catch {
    return null;
  }
})();

const THAI_WORD_SEGMENTER: SegmenterLike<{ segment: string; index: number }> | null = (() => {
  if (!_SegmenterClass) return null;
  try {
    return new _SegmenterClass("th", { granularity: "word" });
  } catch {
    return null;
  }
})();

const ARABIC_RUN = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]+/g;
const THAI_CHAR = /[\u0E00-\u0E7F]/;
const SENTENCE_END = /[.!?…。！？ฯ]["')\]]*\s*$/;

const MIN_CUE_SECONDS = 0.9;
const MAX_CUE_SECONDS = 7;
const MAX_GAP_SECONDS = 0.9;
const MIN_CUE_GAP = 0.03;
const MIN_FRAGMENT_SECONDS = 0.05;
const CHARS_PER_SECOND = 14;
const TAIL_CHARS = 8;

export interface BuildCuesOptions {
  /** Absolute start of the selected clip in the source lecture (seconds). */
  clipStart: number;
  /** Absolute end of the selected clip in the source lecture (seconds). */
  clipEnd: number;
  /** Thai/translation characters per physical line. */
  maxCharsPerLine: number;
  /** Physical lines per subtitle cue (1 or 2; default 2). */
  maxLines?: number;
  /** Arabic characters per physical line; derived from the font ratio if absent. */
  arabicMaxCharsPerLine?: number;
}

interface Letter {
  char: string;
  start: number;
  end: number;
  sentenceId: number | null;
  segmentId: number;
}

interface Word {
  text: string;
  start: number;
  end: number;
  sentenceId: number | null;
  segmentId: number;
}

/** Split a transcript segment into its Arabic and Thai halves (legacy helper). */
export function splitBilingual(text: string): { arabic: string; thai: string } {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return { arabic: "", thai: "" };
  const arabicRuns = clean.match(ARABIC_RUN) ?? [];
  const arabic = arabicRuns.join(" ").trim();
  const thai = clean.replace(ARABIC_RUN, " ").replace(/\s+/g, " ").trim();
  return { arabic, thai };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isThai(char: string): boolean {
  return THAI_CHAR.test(char);
}

function estimateSeconds(text: string): number {
  return clamp(text.length / CHARS_PER_SECOND, MIN_FRAGMENT_SECONDS, 2);
}

function arabicRatio(text: string): number {
  const letters = text.replace(/\s+/g, "");
  if (!letters) return 0;
  const arabic = (letters.match(ARABIC_RUN) ?? []).join("").length;
  return arabic / letters.length;
}

/** New Stage-1 transcripts carry `language`; legacy ones fall back to script. */
function isArabicSegment(segment: TranscriptSegment): boolean {
  if (segment.language === "ar") return true;
  if (segment.language) return false;
  return arabicRatio(segment.text) >= 0.6;
}

function thaiSource(text: string): string {
  return text.replace(ARABIC_RUN, " ").replace(/[\r\n\t]+/g, " ");
}

function arabicSource(text: string): string {
  return (text.match(ARABIC_RUN) ?? []).join(" ");
}

function buildLetters(
  segments: TranscriptSegment[],
  options: BuildCuesOptions,
  pick: "thai" | "arabic",
): Letter[] {
  const clipDuration = Math.max(0, options.clipEnd - options.clipStart);
  if (clipDuration <= 0) return [];

  const letters: Letter[] = [];
  let cursor = 0;

  for (const segment of [...segments].sort((a, b) => a.start - b.start)) {
    if (segment.end <= options.clipStart || segment.start >= options.clipEnd) continue;
    const source =
      pick === "thai"
        ? thaiSource(segment.text)
        : isArabicSegment(segment)
          ? segment.text
          : arabicSource(segment.text);
    if (!source.trim()) continue;

    let start = clamp(segment.start - options.clipStart, 0, clipDuration);
    let end = clamp(segment.end - options.clipStart, 0, clipDuration);
    if (!(end > start)) {
      start = Math.max(start, cursor);
      end = start + estimateSeconds(source);
    }
    start = Math.max(start, cursor);
    if (end <= start) end = start + MIN_FRAGMENT_SECONDS;
    end = clamp(end, 0, clipDuration);
    if (end <= start) continue;

    const last = letters[letters.length - 1];
    const first = source.charAt(0);
    const needsSpace =
      pick === "arabic" || (last && !isThai(last.char) && !isThai(first));
    if (last && needsSpace && last.char !== " " && first !== " ") {
      letters.push({
        char: " ",
        start,
        end: start + 0.001,
        sentenceId: segment.sentence_id ?? null,
        segmentId: segment.id,
      });
    }

    // Segment into grapheme clusters so combining marks share their base
    // character's timestamp window instead of receiving acoustic duration, while
    // keeping one Letter entry per UTF-16 code unit so Intl.Segmenter indices
    // align even when astral code points are present.
    let graphemes: string[] = [];
    if (GRAPHEME_SEGMENTER) {
      try {
        graphemes = [...GRAPHEME_SEGMENTER.segment(source)].map((part) => part.segment);
      } catch {
        graphemes = [];
      }
    }
    if (graphemes.length === 0) {
      graphemes = Array.from(source);
    }
    const graphemeCount = graphemes.length;
    for (let g = 0; g < graphemeCount; g += 1) {
      const cluster = graphemes[g];
      const clusterStart = start + ((end - start) * g) / graphemeCount;
      const clusterEnd = start + ((end - start) * (g + 1)) / graphemeCount;
      for (let c = 0; c < cluster.length; c += 1) {
        letters.push({
          char: cluster[c],
          start: clusterStart,
          end: clusterEnd,
          sentenceId: segment.sentence_id ?? null,
          segmentId: segment.id,
        });
      }
    }
    cursor = end;
  }

  return letters;
}

function wordsFromLetters(letters: Letter[], pick: "thai" | "arabic"): Word[] {
  if (letters.length === 0) return [];
  const text = letters.map((letter) => letter.char).join("");
  const words: Word[] = [];

  const push = (index: number, length: number, value: string) => {
    const first = letters[index];
    const last = letters[index + length - 1];
    const trimmed = value.trim();
    if (!trimmed || !first || !last) return;
    words.push({
      text: trimmed,
      start: first.start,
      end: last.end,
      sentenceId: first.sentenceId,
      segmentId: first.segmentId,
    });
  };

  if (pick === "thai" && THAI_WORD_SEGMENTER) {
    try {
      for (const part of THAI_WORD_SEGMENTER.segment(text)) {
        if (!part.segment.trim()) continue;
        push(part.index, part.segment.length, part.segment);
      }
      return words;
    } catch {
      /* Fall through. */
    }
  }

  const regex = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) push(match.index, match[0].length, match[0]);
  return words;
}

function joinWords(words: Word[]): string {
  let out = "";
  let previous = "";
  for (const word of words) {
    const text = word.text.trim();
    if (!text) continue;
    if (!out) {
      out = text;
    } else {
      const space = !(isThai(previous.slice(-1)) && isThai(text.charAt(0)));
      out += space ? ` ${text}` : text;
    }
    previous = text;
  }
  return out.trim();
}

/** Deterministic grouping when the LLM sentence map is absent. */
function groupWords(words: Word[], maxChars: number): Word[][] {
  const groups: Word[][] = [];
  let current: Word[] = [];
  const flush = () => {
    if (current.length) groups.push(current);
    current = [];
  };
  for (const word of words) {
    if (current.length === 0) {
      current = [word];
      continue;
    }
    const previous = current[current.length - 1];
    const candidate = joinWords([...current, word]);
    const gap = word.start - previous.end;
    const span = word.end - current[0].start;
    const breakHere =
      candidate.length > maxChars ||
      gap > MAX_GAP_SECONDS ||
      SENTENCE_END.test(previous.text) ||
      span > MAX_CUE_SECONDS;
    if (breakHere) {
      flush();
      current = [word];
    } else {
      current.push(word);
    }
  }
  flush();
  return groups;
}

/** Group words by the LLM sentence id, preserving order. */
function groupBySentence(words: Word[]): Word[][] {
  const groups: Word[][] = [];
  let current: Word[] = [];
  let currentId: number | null | undefined;
  for (const word of words) {
    if (current.length && word.sentenceId !== currentId) {
      groups.push(current);
      current = [];
    }
    current.push(word);
    currentId = word.sentenceId;
  }
  if (current.length) groups.push(current);
  return groups;
}

/** Cut a sentence into word-safe chunks that fit `maxChars` and `MAX_CUE_SECONDS`. */
function splitByCaps(
  words: Word[],
  maxChars: number,
  maxDuration: number,
  measureLength: (text: string) => number = (text) => text.length,
): Word[][] {
  const chunks: Word[][] = [];
  let current: Word[] = [];
  for (const word of words) {
    if (!current.length) {
      current = [word];
      continue;
    }
    const candidate = joinWords([...current, word]);
    const span = word.end - current[0].start;
    if (measureLength(candidate) > maxChars || span > maxDuration) {
      chunks.push(current);
      current = [word];
    } else {
      current.push(word);
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function pushCue(
  cues: SubtitleCue[],
  start: number,
  end: number,
  arabic: string,
  thai: string,
  metadata: Partial<
    Pick<SubtitleCue, "source" | "reference" | "confidence" | "originalText" | "translation">
  > = {},
): void {
  const arabicText = arabic.trim();
  const thaiText = thai.trim();
  if (!arabicText && !thaiText) return;
  cues.push({
    id: crypto.randomUUID(),
    start: round(start),
    end: round(end),
    arabic: arabicText,
    thai: thaiText,
    ...metadata,
  });
}

function emitThaiCues(
  words: Word[],
  maxCharsPerLine: number,
  maxCharsPerCue: number,
  cues: SubtitleCue[],
): void {
  if (!words.length) return;
  const hasSentences = words.some((word) => word.sentenceId != null);
  const groups = hasSentences ? groupBySentence(words) : groupWords(words, maxCharsPerCue);
  for (const group of groups) {
    const chunks = hasSentences
      ? splitByCaps(group, maxCharsPerCue, MAX_CUE_SECONDS)
      : [group];
    for (const chunk of chunks) {
      const start = chunk[0].start;
      const end = chunk[chunk.length - 1].end;
      const thai = wrapSubtitleText(joinWords(chunk), maxCharsPerLine);
      pushCue(cues, start, end, "", thai);
    }
  }
}

function emitArabicCues(
  segments: TranscriptSegment[],
  words: Word[],
  arabicMaxChars: number,
  maxLines: number,
  cues: SubtitleCue[],
): void {
  if (!words.length) return;
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  const groups: Word[][] = [];
  let current: Word[] = [];
  let currentId: number | null = null;
  for (const word of words) {
    if (current.length && word.segmentId !== currentId) {
      groups.push(current);
      current = [];
    }
    current.push(word);
    currentId = word.segmentId;
  }
  if (current.length) groups.push(current);

  const maxCharsPerCue = arabicMaxChars * maxLines;
  for (const group of groups) {
    const segment = byId.get(group[0].segmentId);
    const metadata = segment
      ? {
          source: segment.source ?? undefined,
          reference: segment.reference ?? undefined,
          confidence: segment.confidence ?? undefined,
          originalText: segment.original_text ?? undefined,
          translation: segment.translation ?? undefined,
        }
      : {};
    const chunks = splitByCaps(group, maxCharsPerCue, MAX_CUE_SECONDS, arabicVisualLength);
    for (const chunk of chunks) {
      const start = chunk[0].start;
      const end = chunk[chunk.length - 1].end;
      const arabic = wrapArabicText(joinWords(chunk), arabicMaxChars);
      pushCue(cues, start, end, arabic, "", metadata);
    }
  }
}

/** Clamp, bump unreadably short lines, and guarantee a monotonic track. */
function finalise(
  cues: SubtitleCue[],
  clipDuration: number,
  maxCharsPerLine: number,
  maxLines: number,
): SubtitleCue[] {
  cues.sort((a, b) => a.start - b.start);
  const out: SubtitleCue[] = [];
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    const next = cues[index + 1];
    const start = clamp(round(cue.start), 0, Math.max(0, clipDuration - MIN_FRAGMENT_SECONDS));
    let end = clamp(round(cue.end), start + MIN_FRAGMENT_SECONDS, clipDuration);
    const hardEnd = next
      ? Math.max(start + MIN_FRAGMENT_SECONDS, next.start - MIN_CUE_GAP)
      : clipDuration;
    if (end - start < MIN_CUE_SECONDS) {
      end = Math.min(start + MIN_CUE_SECONDS, hardEnd);
    }
    end = Math.min(end, hardEnd, clipDuration);
    if (end <= start) end = Math.min(clipDuration, start + MIN_FRAGMENT_SECONDS);
    out.push({ ...cue, start: round(start), end: round(end) });
  }

  // Fold a tiny final Thai fragment into the previous Thai cue, but only when
  // the merged text still fits the configured number of physical lines.
  if (out.length >= 2) {
    const last = out[out.length - 1];
    const previous = out[out.length - 2];
    const lastText = last.thai.replace(/\s/g, "");
    if (
      lastText.length > 0 &&
      lastText.length <= TAIL_CHARS &&
      !last.arabic &&
      !previous.arabic
    ) {
      const merged = wrapSubtitleText(
        `${previous.thai.replace(/\n/g, "")}${last.thai.replace(/\n/g, "")}`,
        maxCharsPerLine,
      );
      if (merged.split("\n").length <= maxLines) {
        previous.thai = merged;
        previous.end = last.end;
        out.pop();
      }
    }
  }

  return out.filter((cue) => cue.end > cue.start && (cue.arabic || cue.thai));
}

/**
 * Turn transcript segments into readable, non-overlapping subtitle lines for
 * one clip. Cue times are clip-relative, matching the render payload.
 */
export function buildCuesFromTranscript(
  segments: TranscriptSegment[],
  options: BuildCuesOptions,
): SubtitleCue[] {
  const clipDuration = Math.max(0, options.clipEnd - options.clipStart);
  if (clipDuration <= 0 || segments.length === 0) return [];
  const maxCharsPerLine = Math.max(8, Math.round(options.maxCharsPerLine));
  const maxLines = options.maxLines === 1 ? 1 : 2;
  const maxCharsPerCue = maxCharsPerLine * maxLines;
  const arabicMaxChars = Math.max(
    16,
    Math.round(options.arabicMaxCharsPerLine ?? maxCharsPerLine * 0.7),
  );

  // Language runs guarantee that a Thai cue never covers an Arabic cue's time.
  const ordered = [...segments]
    .filter((segment) => segment.end > options.clipStart && segment.start < options.clipEnd)
    .sort((a, b) => a.start - b.start);
  const runs: { arabic: boolean; segments: TranscriptSegment[] }[] = [];
  for (const segment of ordered) {
    const arabic = isArabicSegment(segment);
    if (!runs.length || runs[runs.length - 1].arabic !== arabic) {
      runs.push({ arabic, segments: [] });
    }
    runs[runs.length - 1].segments.push(segment);
  }

  const cues: SubtitleCue[] = [];
  for (const run of runs) {
    if (run.arabic) {
      const letters = buildLetters(run.segments, options, "arabic");
      const words = wordsFromLetters(letters, "arabic");
      emitArabicCues(run.segments, words, arabicMaxChars, maxLines, cues);
    } else {
      const letters = buildLetters(run.segments, options, "thai");
      const words = wordsFromLetters(letters, "thai");
      emitThaiCues(words, maxCharsPerLine, maxCharsPerCue, cues);
    }
  }

  return finalise(cues, clipDuration, maxCharsPerLine, maxLines);
}

/**
 * `true` when a saved track is clearly a raw transcript seed rather than an
 * edited subtitle track: many unreviewed, sub-second, one-or-two-character
 * lines. Step 3 auto-rebuilds such a track instead of showing a wall of slivers.
 */
export function looksLikeFragmentSeed(cues: SubtitleCue[]): boolean {
  if (cues.length < 20) return false;
  if (cues.some((cue) => cue.reviewed)) return false;
  const sample = cues.slice(0, 200);
  const short = sample.filter((cue) => cue.end - cue.start < 0.35).length / sample.length;
  const tiny =
    sample.filter((cue) => cue.thai.trim().length + cue.arabic.trim().length <= 3).length /
    sample.length;
  return short >= 0.6 && tiny >= 0.6;
}

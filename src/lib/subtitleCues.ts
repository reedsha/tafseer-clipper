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

import type { SubtitleCue, TranscriptSegment, TranscriptWord } from "@/lib/projectTypes";
import {
  arabicVisualLength,
  wordBoundaries,
  wrapArabicText,
  wrapSubtitleText,
} from "@/lib/subtitleWrap";

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
const ARABIC_CHAR_TEST = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const THAI_CHAR = /[\u0E00-\u0E7F]/;
const SENTENCE_END = /[.!?…。！？ฯ]["')\]]*\s*$/;

const MIN_CUE_SECONDS = 0.9;
const MAX_CUE_SECONDS = 7;
const MAX_GAP_SECONDS = 0.9;
const MIN_CUE_GAP = 0.03;
const MIN_FRAGMENT_SECONDS = 0.05;
const CHARS_PER_SECOND = 14;
const TAIL_CHARS = 8;

/** Arabic sequence possibly spanning words + trailing neutral punctuation. */
const MIXED_ARABIC_SPAN =
  /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]+(?:[\s\u200c\u200d،؛؟.,:!?()[\]"'-]+[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]+)*[.,!?؟،؛:)"'\]\s]*/g;

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

/**
 * Snap a proportional text slice onto word boundaries (falling back to
 * grapheme clusters so combining marks / Harakat are never severed) when a
 * transcript segment straddles a clip edge.
 */
function snapOffsetToWordBoundary(
  text: string,
  target: number,
  kind: "thai" | "arabic",
  direction: "ceil" | "floor",
): number {
  if (target <= 0) return 0;
  if (target >= text.length) return text.length;
  const bounds = wordBoundaries(text, kind);
  if (bounds.length > 0) {
    if (direction === "ceil") {
      const hit = bounds.find((b) => b >= target);
      return hit ?? text.length;
    }
    for (let i = bounds.length - 1; i >= 0; i -= 1) {
      if (bounds[i] <= target) return bounds[i];
    }
    return 0;
  }
  return target;
}

function joinRawWords(words: readonly { text: string }[]): string {
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

function trimSegmentToClip(
  segment: TranscriptSegment,
  clipStart: number,
  clipEnd: number,
): TranscriptSegment | null {
  if (segment.end <= clipStart || segment.start >= clipEnd) return null;
  if (segment.start >= clipStart && segment.end <= clipEnd) return segment;

  const segDur = segment.end - segment.start;
  const overlapStart = Math.max(segment.start, clipStart);
  const overlapEnd = Math.min(segment.end, clipEnd);
  const overlapDur = overlapEnd - overlapStart;
  if (overlapDur <= 0) return null;

  // Auto-pad buffers (e.g. 0.3 s) frequently graze the last or first fraction
  // of an adjacent multi-second / multi-minute segment. Skipping a tiny sliver
  // prevents dumping hundreds of out-of-clip characters at t=0 or t=clipEnd.
  if (segDur > 2 && overlapDur < 0.5 && overlapDur / segDur < 0.15) {
    return null;
  }

  if (segment.words && segment.words.length > 0) {
    const kept: TranscriptWord[] = [];
    for (const word of segment.words) {
      if (word.end <= overlapStart + 0.01 || word.start >= overlapEnd - 0.01) continue;
      const wStart = Math.max(overlapStart, word.start);
      const wEnd = Math.min(overlapEnd, Math.max(wStart, word.end));
      kept.push({ text: word.text, start: wStart, end: wEnd });
    }
    if (kept.length > 0) {
      const slicedByWords = joinRawWords(kept);
      if (slicedByWords) {
        return {
          ...segment,
          start: overlapStart,
          end: overlapEnd,
          text: slicedByWords,
          words: kept,
        };
      }
    }
  }

  const rawText = segment.text;
  if (!rawText.trim() || segDur <= 0) {
    return { ...segment, start: overlapStart, end: overlapEnd, words: undefined };
  }

  const isAr = segment.language === "ar" || arabicRatio(rawText) >= 0.6;
  const kind: "thai" | "arabic" = isAr ? "arabic" : "thai";
  const loRatio = clamp((overlapStart - segment.start) / segDur, 0, 1);
  const hiRatio = clamp((overlapEnd - segment.start) / segDur, 0, 1);
  const loIdx =
    loRatio > 0
      ? snapOffsetToWordBoundary(rawText, Math.round(rawText.length * loRatio), kind, "ceil")
      : 0;
  const hiIdx =
    hiRatio < 1
      ? snapOffsetToWordBoundary(rawText, Math.round(rawText.length * hiRatio), kind, "floor")
      : rawText.length;

  const sliced = rawText.slice(loIdx, hiIdx).trim();
  if (!sliced) return null;
  return {
    ...segment,
    start: overlapStart,
    end: overlapEnd,
    text: sliced,
    words: undefined,
  };
}

/**
 * Split mixed-script segments (Thai + Arabic inside one STT segment) into
 * ordered, non-overlapping sub-segments so Arabic never sits inside Thai text
 * and Thai words never leak into an RTL Arabic cue.
 */
function normalizeSegmentsByScript(
  segments: TranscriptSegment[],
): { segment: TranscriptSegment; arabic: boolean }[] {
  const out: { segment: TranscriptSegment; arabic: boolean }[] = [];
  for (const segment of segments) {
    const text = segment.text;
    const hasAr = ARABIC_CHAR_TEST.test(text);
    const hasTh = THAI_CHAR.test(text);
    if (!hasAr) {
      out.push({ segment, arabic: false });
      continue;
    }
    if (!hasTh && (segment.language === "ar" || arabicRatio(text) >= 0.6)) {
      out.push({ segment, arabic: true });
      continue;
    }
    // Split alternating Arabic spans vs non-Arabic (Thai) spans in order.
    const pieces: { text: string; arabic: boolean }[] = [];
    let lastIndex = 0;
    MIXED_ARABIC_SPAN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MIXED_ARABIC_SPAN.exec(text))) {
      if (match.index > lastIndex) {
        const before = text.slice(lastIndex, match.index).trim();
        if (before) pieces.push({ text: before, arabic: false });
      }
      const arChunk = match[0].trim();
      if (arChunk) pieces.push({ text: arChunk, arabic: true });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      const after = text.slice(lastIndex).trim();
      if (after) pieces.push({ text: after, arabic: false });
    }
    if (pieces.length === 0) continue;
    if (pieces.length === 1) {
      out.push({ segment, arabic: pieces[0].arabic });
      continue;
    }
    const totalWeight = pieces.reduce((acc, p) => acc + Math.max(1, p.text.length), 0);
    const dur = Math.max(MIN_FRAGMENT_SECONDS, segment.end - segment.start);
    let cursor = segment.start;
    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i];
      const nextTime =
        i === pieces.length - 1
          ? Math.max(cursor + 0.01, segment.end)
          : cursor + dur * (Math.max(1, piece.text.length) / totalWeight);
      out.push({
        arabic: piece.arabic,
        segment: {
          ...segment,
          start: cursor,
          end: nextTime,
          text: piece.text,
          language: piece.arabic ? "ar" : segment.language === "ar" ? "th" : segment.language,
          words: undefined,
          ...(piece.arabic
            ? {}
            : {
                source: undefined,
                reference: undefined,
                confidence: undefined,
                original_text: undefined,
                translation: undefined,
              }),
        },
      });
      cursor = nextTime;
    }
  }
  return out;
}

function thaiSource(text: string): string {
  return text.replace(ARABIC_RUN, " ").replace(/[\r\n\t]+/g, " ");
}

function arabicSource(text: string): string {
  return (text.match(ARABIC_RUN) ?? []).join(" ");
}

function pushSpanLetters(
  letters: Letter[],
  source: string,
  start: number,
  end: number,
  sentenceId: number | null,
  segmentId: number,
  pick: "thai" | "arabic",
): void {
  const last = letters[letters.length - 1];
  const first = source.charAt(0);
  const needsSpace =
    pick === "arabic" || (last && !isThai(last.char) && !isThai(first));
  if (last && needsSpace && last.char !== " " && first !== " ") {
    letters.push({
      char: " ",
      start,
      end: start + 0.001,
      sentenceId,
      segmentId,
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
        sentenceId,
        segmentId,
      });
    }
  }
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
        : !THAI_CHAR.test(segment.text) && (segment.language === "ar" || arabicRatio(segment.text) >= 0.6)
          ? segment.text
          : arabicSource(segment.text);
    if (!source.trim()) continue;

    // Use real word-level timestamps when available and aligned with `source`.
    const segWords = segment.words?.filter((word) => word.text.trim().length > 0) ?? [];
    if (
      segWords.length > 0 &&
      segWords.map((word) => word.text.trim()).join("").replace(/\s+/g, "") ===
        source.replace(/\s+/g, "")
    ) {
      for (const word of segWords) {
        const wText = word.text.trim();
        let wStart = clamp(word.start - options.clipStart, 0, clipDuration);
        let wEnd = clamp(word.end - options.clipStart, 0, clipDuration);
        if (!(wEnd > wStart)) {
          wStart = Math.max(wStart, cursor);
          wEnd = wStart + estimateSeconds(wText);
        }
        wStart = Math.max(wStart, cursor);
        if (wEnd <= wStart) wEnd = wStart + MIN_FRAGMENT_SECONDS;
        wEnd = clamp(wEnd, 0, clipDuration);
        if (wEnd <= wStart) continue;
        pushSpanLetters(
          letters,
          wText,
          wStart,
          wEnd,
          segment.sentence_id ?? null,
          segment.id,
          pick,
        );
        cursor = wEnd;
      }
      continue;
    }

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

    pushSpanLetters(
      letters,
      source,
      start,
      end,
      segment.sentence_id ?? null,
      segment.id,
      pick,
    );
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
function groupWords(
  words: Word[],
  maxChars: number,
  maxCharsPerLine: number,
  maxLines: number,
): Word[][] {
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
      wrapSubtitleText(candidate, maxCharsPerLine).split("\n").length > maxLines ||
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

/** Cut a sentence into word-safe chunks that fit `maxChars`, `maxLines`, and `MAX_CUE_SECONDS`. */
function splitByCaps(
  words: Word[],
  maxChars: number,
  maxDuration: number,
  measureLength: (text: string) => number = (text) => text.length,
  fitsCue?: (text: string) => boolean,
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
    if (
      measureLength(candidate) > maxChars ||
      span > maxDuration ||
      (fitsCue && !fitsCue(candidate))
    ) {
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
  maxLines: number,
  cues: SubtitleCue[],
): void {
  if (!words.length) return;
  const hasSentences = words.some((word) => word.sentenceId != null);
  const groups = hasSentences
    ? groupBySentence(words)
    : groupWords(words, maxCharsPerCue, maxCharsPerLine, maxLines);
  const fitsThaiLines = (candidate: string) =>
    wrapSubtitleText(candidate, maxCharsPerLine).split("\n").length <= maxLines;
  for (const group of groups) {
    const chunks = hasSentences
      ? splitByCaps(group, maxCharsPerCue, MAX_CUE_SECONDS, (t) => t.length, fitsThaiLines)
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
  const fitsArabicLines = (candidate: string) =>
    wrapArabicText(candidate, arabicMaxChars).split("\n").length <= maxLines;
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
    const chunks = splitByCaps(
      group,
      maxCharsPerCue,
      MAX_CUE_SECONDS,
      arabicVisualLength,
      fitsArabicLines,
    );
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
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  const out: SubtitleCue[] = [];
  let prevEnd = -MIN_CUE_GAP;
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    const next = cues[index + 1];
    const start = Math.max(
      prevEnd + MIN_CUE_GAP,
      clamp(round(cue.start), 0, Math.max(0, clipDuration - MIN_FRAGMENT_SECONDS)),
    );
    if (start >= clipDuration - 0.01) continue;
    let end = clamp(round(cue.end), start + MIN_FRAGMENT_SECONDS, clipDuration);
    const hardEnd = next
      ? Math.min(clipDuration, Math.max(start + MIN_FRAGMENT_SECONDS, round(next.start) - MIN_CUE_GAP))
      : clipDuration;
    if (end - start < MIN_CUE_SECONDS) {
      end = Math.min(start + MIN_CUE_SECONDS, hardEnd);
    }
    end = Math.min(end, hardEnd, clipDuration);
    if (end <= start) continue;
    const roundedStart = round(start);
    const roundedEnd = round(end);
    if (roundedEnd <= roundedStart) continue;
    out.push({ ...cue, start: roundedStart, end: roundedEnd });
    prevEnd = roundedEnd;
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
      const prevFlat = previous.thai.replace(/\n+/g, "").trim();
      const lastFlat = last.thai.replace(/\n+/g, "").trim();
      const sep = isThai(prevFlat.slice(-1)) && isThai(lastFlat.charAt(0)) ? "" : " ";
      const merged = wrapSubtitleText(`${prevFlat}${sep}${lastFlat}`, maxCharsPerLine);
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

  // Trim straddling edge segments and separate mixed-script segments before grouping.
  const ordered = [...segments]
    .sort((a, b) => a.start - b.start)
    .map((segment) => trimSegmentToClip(segment, options.clipStart, options.clipEnd))
    .filter((segment): segment is TranscriptSegment => segment !== null);
  const items = normalizeSegmentsByScript(ordered);

  const runs: { arabic: boolean; segments: TranscriptSegment[] }[] = [];
  for (const item of items) {
    if (!runs.length || runs[runs.length - 1].arabic !== item.arabic) {
      runs.push({ arabic: item.arabic, segments: [] });
    }
    runs[runs.length - 1].segments.push(item.segment);
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
      emitThaiCues(words, maxCharsPerLine, maxCharsPerCue, maxLines, cues);
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

/**
 * `true` when an unreviewed track has a pile-up of overlapping <=0.06 s boundary
 * slivers (caused by straddling giant segments or forward rebasing) that should
 * be rebuilt cleanly from the transcript.
 */
export function looksLikeBrokenBoundaryTrack(cues: SubtitleCue[]): boolean {
  if (cues.length < 5) return false;
  if (cues.some((cue) => cue.reviewed)) return false;
  let sliverCount = 0;
  let overlapCount = 0;
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i];
    if (cue.end - cue.start <= 0.065) sliverCount += 1;
    if (i > 0 && cue.start < cues[i - 1].end - 0.001) overlapCount += 1;
  }
  return sliverCount >= 5 && overlapCount >= 3;
}

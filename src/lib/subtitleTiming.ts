/**
 * Shared subtitle track timing constants and speech-aligned split resolution.
 *
 * Step 3 (`Step3Subtitles.tsx`) and `CueRibbon.tsx` share these bounds so
 * splitting a cue always yields two non-overlapping, immediately draggable
 * blocks, and cut timestamps follow real speech boundaries (playhead, word
 * timings, transcript segment pauses, or waveform silence valleys).
 */

import type { TranscriptSegment } from "@/lib/projectTypes";
import { splitAtWordBoundary } from "@/lib/subtitleWrap";

export const MIN_CUE_SECONDS = 0.2;
/** Keeps two neighbouring subtitle blocks visibly and temporally separated. */
export const NEIGHBOUR_GAP = 0.02;
/** Minimum cue length that can split into two MIN_CUE_SECONDS blocks + gap. */
export const MIN_SPLITTABLE_DURATION = 0.42;

export type SplitMethod = "playhead" | "words" | "segments" | "peaks" | "grapheme";

export interface SplitBounds {
  firstEnd: number;
  secondStart: number;
  mid: number;
}

export interface SplitTimingParams {
  cueStart: number;
  cueEnd: number;
  clipStart: number;
  lectureDuration?: number | null;
  field: "thai" | "arabic";
  firstText: string;
  secondText: string;
  segments?: TranscriptSegment[] | null;
  peaks?: number[] | null;
  explicitTime?: number | null;
}

export interface SplitTimingResult extends SplitBounds {
  method: SplitMethod;
}

interface TimedUnit {
  norm: string;
  start: number;
  end: number;
}

const PUNCTUATION_OR_SPACE = /[\s\u200c\u200d.,!?…。！？ฯ،؛؟()[\]"'-]+/g;
const ARABIC_COMBINING = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g;
const THAI_COMBINING = /[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/g;
const ARABIC_CHAR = /[\u0600-\u06FF]/;
const THAI_CHAR = /[\u0E00-\u0E7F]/;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function roundTime(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Count spoken base characters (ignoring newlines, spaces, punctuation, and
 * combining diacritics/vowels) so split proportions match spoken duration.
 */
export function spokenWeight(text: string, kind: "thai" | "arabic"): number {
  let stripped = text.replace(PUNCTUATION_OR_SPACE, "");
  if (kind === "arabic") {
    stripped = stripped.replace(ARABIC_COMBINING, "");
  } else {
    stripped = stripped.replace(THAI_COMBINING, "");
  }
  return stripped.length > 0 ? stripped.length : text.trim().length;
}

function normalizeForAlign(text: string, kind: "thai" | "arabic"): string {
  const cleaned = text.replace(PUNCTUATION_OR_SPACE, "").toLowerCase();
  return kind === "arabic" ? cleaned.replace(ARABIC_COMBINING, "") : cleaned;
}

/**
 * Enforce shared split invariants (`first.dur >= 0.2s`, `second.dur >= 0.2s`,
 * `second.start - first.end >= 0.02s`).
 */
export function computeSplitBounds(
  cueStart: number,
  cueEnd: number,
  targetMid: number,
  preferredGap?: { firstEnd: number; secondStart: number } | null,
): SplitBounds | null {
  if (!Number.isFinite(cueStart) || !Number.isFinite(cueEnd)) return null;
  if (cueEnd - cueStart < MIN_SPLITTABLE_DURATION - 0.001) return null;

  const minFirstEnd = Math.ceil((cueStart + MIN_CUE_SECONDS) * 100 - 1e-6) / 100;
  const maxSecondStart = Math.floor((cueEnd - MIN_CUE_SECONDS) * 100 + 1e-6) / 100;
  const maxFirstEnd = roundTime(maxSecondStart - NEIGHBOUR_GAP);
  if (maxFirstEnd < minFirstEnd - 0.001) return null;
  const safeMaxFirst = Math.max(minFirstEnd, maxFirstEnd);

  if (
    preferredGap &&
    Number.isFinite(preferredGap.firstEnd) &&
    Number.isFinite(preferredGap.secondStart) &&
    preferredGap.secondStart - preferredGap.firstEnd >= NEIGHBOUR_GAP - 0.001
  ) {
    const firstEnd = clamp(roundTime(preferredGap.firstEnd), minFirstEnd, safeMaxFirst);
    const minSecond = roundTime(firstEnd + NEIGHBOUR_GAP);
    const secondStart = clamp(
      roundTime(preferredGap.secondStart),
      minSecond,
      Math.max(minSecond, maxSecondStart),
    );
    return {
      firstEnd,
      secondStart,
      mid: roundTime((firstEnd + secondStart) * 0.5),
    };
  }

  const safeTarget = Number.isFinite(targetMid) ? targetMid : (cueStart + cueEnd) * 0.5;
  const firstEnd = clamp(
    roundTime(safeTarget - NEIGHBOUR_GAP * 0.5),
    minFirstEnd,
    safeMaxFirst,
  );
  const secondStart = roundTime(firstEnd + NEIGHBOUR_GAP);
  return {
    firstEnd,
    secondStart,
    mid: roundTime((firstEnd + secondStart) * 0.5),
  };
}

function collectAlignedUnits(
  segments: readonly TranscriptSegment[] | null | undefined,
  clipStart: number,
  cueStart: number,
  cueEnd: number,
  field: "thai" | "arabic",
): { kind: "words" | "segments"; units: TimedUnit[] } | null {
  if (!segments || segments.length === 0) return null;
  const absStart = clipStart + cueStart;
  const absEnd = clipStart + cueEnd;
  const relevant = segments
    .filter((segment) => {
      if (segment.end < absStart - 0.15 || segment.start > absEnd + 0.15) return false;
      if (!segment.text.trim()) return false;
      const hasArabic = ARABIC_CHAR.test(segment.text) || segment.language === "ar";
      if (field === "arabic") return hasArabic;
      return segment.language !== "ar" || THAI_CHAR.test(segment.text);
    })
    .sort((a, b) => a.start - b.start);

  if (relevant.length === 0) return null;

  // Prefer word-level timings when every overlapping segment provides them.
  const allHaveWords = relevant.every((segment) => (segment.words?.length ?? 0) > 0);
  if (allHaveWords) {
    const wordUnits: TimedUnit[] = [];
    for (const segment of relevant) {
      for (const word of segment.words ?? []) {
        if (word.end < absStart - 0.15 || word.start > absEnd + 0.15) continue;
        const norm = normalizeForAlign(word.text, field);
        if (!norm) continue;
        const start = clamp(word.start - clipStart, cueStart, cueEnd);
        const end = clamp(word.end - clipStart, start, cueEnd);
        wordUnits.push({ norm, start, end });
      }
    }
    if (wordUnits.length > 0) return { kind: "words", units: wordUnits };
  }

  const segUnits: TimedUnit[] = [];
  for (const segment of relevant) {
    const norm = normalizeForAlign(segment.text, field);
    if (!norm) continue;
    const start = clamp(segment.start - clipStart, cueStart, cueEnd);
    const end = clamp(segment.end - clipStart, start, cueEnd);
    segUnits.push({ norm, start, end });
  }
  return segUnits.length > 0 ? { kind: "segments", units: segUnits } : null;
}

function findCutIndexInUnits(
  allUnitsNorm: string,
  firstNorm: string,
  secondNorm: string,
  approxRatio: number,
): number | null {
  if (!allUnitsNorm || !firstNorm || !secondNorm) return null;
  const combined = firstNorm + secondNorm;
  const exactIdx = allUnitsNorm.indexOf(combined);
  if (exactIdx >= 0) {
    return exactIdx + firstNorm.length;
  }

  // Fallback for edited cues: anchor on the seam tail+head near approxRatio.
  const maxTail = Math.min(12, firstNorm.length);
  const maxHead = Math.min(12, secondNorm.length);
  const expectedCut = approxRatio * allUnitsNorm.length;
  for (let len = Math.min(maxTail, maxHead); len >= 4; len -= 2) {
    const tail = firstNorm.slice(-len);
    const head = secondNorm.slice(0, len);
    const anchor = tail + head;
    const matches: number[] = [];
    let searchFrom = 0;
    while (searchFrom < allUnitsNorm.length) {
      const hit = allUnitsNorm.indexOf(anchor, searchFrom);
      if (hit < 0) break;
      matches.push(hit + tail.length);
      searchFrom = hit + 1;
    }
    if (matches.length > 0) {
      return matches.reduce((best, candidate) =>
        Math.abs(candidate - expectedCut) < Math.abs(best - expectedCut) ? candidate : best,
      );
    }
  }
  return null;
}

function snapToSilenceValley(params: {
  cueStart: number;
  cueEnd: number;
  clipStart: number;
  targetTime: number;
  peaks?: number[] | null;
  lectureDuration?: number | null;
  searchRadius?: number;
  windowMin?: number;
  windowMax?: number;
}): number | null {
  const {
    cueStart,
    cueEnd,
    clipStart,
    targetTime,
    peaks,
    lectureDuration,
    searchRadius = 0.6,
    windowMin = cueStart,
    windowMax = cueEnd,
  } = params;
  if (!peaks || peaks.length === 0 || !lectureDuration || lectureDuration <= 0) return null;

  const bucketSeconds = lectureDuration / peaks.length;
  if (!Number.isFinite(bucketSeconds) || bucketSeconds <= 0) return null;

  const cueBucketLo = clamp(
    Math.floor((clipStart + cueStart) / bucketSeconds),
    0,
    peaks.length - 1,
  );
  const cueBucketHi = clamp(
    Math.floor((clipStart + cueEnd) / bucketSeconds),
    cueBucketLo,
    peaks.length - 1,
  );
  const cueSample: number[] = [];
  for (let i = cueBucketLo; i <= cueBucketHi; i += 1) {
    const val = peaks[i];
    if (typeof val === "number" && Number.isFinite(val)) cueSample.push(val);
  }
  if (cueSample.length === 0) return null;
  const sortedSample = [...cueSample].sort((a, b) => a - b);
  const cueEnergy = sortedSample[Math.floor(sortedSample.length * 0.7)];
  if (!(cueEnergy > 0.02)) return null;

  const lo = Math.max(cueStart + MIN_CUE_SECONDS, windowMin, targetTime - searchRadius);
  const hi = Math.min(cueEnd - MIN_CUE_SECONDS, windowMax, targetTime + searchRadius);
  if (hi <= lo) return null;

  const searchLo = clamp(Math.floor((clipStart + lo) / bucketSeconds), 0, peaks.length - 1);
  const searchHi = clamp(Math.floor((clipStart + hi) / bucketSeconds), searchLo, peaks.length - 1);

  let minPeak = Number.POSITIVE_INFINITY;
  for (let i = searchLo; i <= searchHi; i += 1) {
    const val = peaks[i];
    if (typeof val === "number" && Number.isFinite(val) && val < minPeak) {
      minPeak = val;
    }
  }
  if (!Number.isFinite(minPeak)) return null;
  if (!(minPeak <= cueEnergy * 0.35 && minPeak < 0.15)) return null;

  let bestTime = targetTime;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = searchLo; i <= searchHi; i += 1) {
    const val = peaks[i];
    if (typeof val !== "number" || val > minPeak + 0.01) continue;
    const center = clamp((i + 0.5) * bucketSeconds - clipStart, lo, hi);
    const dist = Math.abs(center - targetTime);
    if (dist < bestDist) {
      bestDist = dist;
      bestTime = center;
    }
  }
  return bestTime;
}

/**
 * Resolve the cut timing for a cue split via a 5-tier cascade:
 * 1. Explicit playhead time (`method: "playhead"`).
 * 2. Word-level transcript alignment (`method: "words"`).
 * 3. Segment-level transcript boundaries/windows (`method: "segments"`).
 * 4. Audio silence-valley snapping via `transcript.peaks` (`method: "peaks"`).
 * 5. Spoken-grapheme proportion (`method: "grapheme"`).
 */
export function resolveSplitTiming(params: SplitTimingParams): SplitTimingResult | null {
  const {
    cueStart,
    cueEnd,
    clipStart,
    lectureDuration,
    field,
    firstText,
    secondText,
    segments,
    peaks,
    explicitTime,
  } = params;

  if (explicitTime !== undefined && explicitTime !== null && Number.isFinite(explicitTime)) {
    const bounds = computeSplitBounds(cueStart, cueEnd, explicitTime);
    return bounds ? { ...bounds, method: "playhead" } : null;
  }

  const firstWeight = spokenWeight(firstText, field);
  const secondWeight = spokenWeight(secondText, field);
  const ratio = firstWeight / Math.max(1, firstWeight + secondWeight);
  const fallbackEst = cueStart + (cueEnd - cueStart) * ratio;

  const aligned = collectAlignedUnits(segments, clipStart, cueStart, cueEnd, field);
  if (aligned) {
    const allUnitsNorm = aligned.units.map((unit) => unit.norm).join("");
    const firstNorm = normalizeForAlign(firstText, field);
    const secondNorm = normalizeForAlign(secondText, field);
    const cutCharIndex = findCutIndexInUnits(allUnitsNorm, firstNorm, secondNorm, ratio);

    if (cutCharIndex !== null) {
      let charCursor = 0;
      for (let i = 0; i < aligned.units.length; i += 1) {
        const unit = aligned.units[i];
        const unitEndChar = charCursor + unit.norm.length;

        if (cutCharIndex === charCursor && i > 0) {
          const prev = aligned.units[i - 1];
          const gap = unit.start - prev.end;
          const bounds =
            gap >= NEIGHBOUR_GAP
              ? computeSplitBounds(cueStart, cueEnd, (prev.end + unit.start) * 0.5, {
                  firstEnd: prev.end,
                  secondStart: unit.start,
                })
              : computeSplitBounds(cueStart, cueEnd, (prev.end + unit.start) * 0.5);
          if (bounds) return { ...bounds, method: aligned.kind };
          break;
        }

        if (cutCharIndex === unitEndChar && i + 1 < aligned.units.length) {
          const next = aligned.units[i + 1];
          const gap = next.start - unit.end;
          const bounds =
            gap >= NEIGHBOUR_GAP
              ? computeSplitBounds(cueStart, cueEnd, (unit.end + next.start) * 0.5, {
                  firstEnd: unit.end,
                  secondStart: next.start,
                })
              : computeSplitBounds(cueStart, cueEnd, (unit.end + next.start) * 0.5);
          if (bounds) return { ...bounds, method: aligned.kind };
          break;
        }

        if (cutCharIndex > charCursor && cutCharIndex < unitEndChar) {
          const localRatio = (cutCharIndex - charCursor) / Math.max(1, unit.norm.length);
          let target = unit.start + (unit.end - unit.start) * localRatio;
          let method: SplitMethod = aligned.kind;
          if (aligned.kind === "segments") {
            const snapped = snapToSilenceValley({
              cueStart,
              cueEnd,
              clipStart,
              targetTime: target,
              peaks,
              lectureDuration,
              searchRadius: 0.5,
              windowMin: unit.start,
              windowMax: unit.end,
            });
            if (snapped !== null) {
              target = snapped;
              method = "peaks";
            }
          }
          const bounds = computeSplitBounds(cueStart, cueEnd, target);
          if (bounds) return { ...bounds, method };
          break;
        }

        charCursor = unitEndChar;
      }
    }
  }

  const snapped = snapToSilenceValley({
    cueStart,
    cueEnd,
    clipStart,
    targetTime: fallbackEst,
    peaks,
    lectureDuration,
    searchRadius: 0.6,
  });
  if (snapped !== null) {
    const bounds = computeSplitBounds(cueStart, cueEnd, snapped);
    if (bounds) return { ...bounds, method: "peaks" };
  }

  const bounds = computeSplitBounds(cueStart, cueEnd, fallbackEst);
  return bounds ? { ...bounds, method: "grapheme" } : null;
}

/**
 * Find the safest text cursor offset corresponding to `playhead` when the
 * user triggers "Split at playhead" without placing a text caret.
 */
export function resolveTextSplitOffsetForTime(params: {
  cueStart: number;
  cueEnd: number;
  clipStart: number;
  playhead: number;
  field: "thai" | "arabic";
  text: string;
  segments?: TranscriptSegment[] | null;
}): number {
  const { cueStart, cueEnd, clipStart, playhead, field, text, segments } = params;
  if (!text.trim()) return 0;

  let ratio = clamp(
    (playhead - cueStart) / Math.max(0.01, cueEnd - cueStart),
    0.05,
    0.95,
  );

  const aligned = collectAlignedUnits(segments, clipStart, cueStart, cueEnd, field);
  if (aligned) {
    const totalChars = aligned.units.reduce((sum, u) => sum + u.norm.length, 0);
    if (totalChars > 0) {
      let charCursor = 0;
      let targetChar: number | null = null;
      for (let i = 0; i < aligned.units.length; i += 1) {
        const unit = aligned.units[i];
        if (playhead <= unit.start) {
          targetChar = charCursor;
          break;
        }
        if (playhead <= unit.end) {
          const span = unit.end - unit.start;
          const localRatio = span > 0.01 ? (playhead - unit.start) / span : 0.5;
          targetChar = charCursor + unit.norm.length * localRatio;
          break;
        }
        charCursor += unit.norm.length;
        if (i + 1 < aligned.units.length && playhead < aligned.units[i + 1].start) {
          targetChar = charCursor;
          break;
        }
      }
      if (targetChar !== null) {
        ratio = clamp(targetChar / totalChars, 0.05, 0.95);
      }
    }
  }

  const offset = splitAtWordBoundary(text, ratio, field);
  if (offset > 0 && offset < text.length) return offset;
  return clamp(Math.round(text.length * ratio), 1, Math.max(1, text.length - 1));
}

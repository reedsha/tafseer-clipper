/**
 * Pure clip-boundary math shared by Step 2 (and later by the export queue).
 *
 * A clip keeps two ranges:
 *  - `speechStart`/`speechEnd`: the AI proposal, clamped to the lecture.
 *  - `start`/`end`: the final cut, i.e. the speech bounds widened by the
 *    configurable auto-pad buffer.
 */

import { clamp } from "./format";

export const MIN_CLIP_SECONDS = 1;

export interface CutContext {
  /** Lecture duration, or `null` while it is still unknown. */
  duration: number | null;
  /** Auto-pad buffer in seconds. */
  buffer: number;
  autoPad: boolean;
}

export interface CutRange {
  start: number;
  end: number;
}

export function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function clampToDuration(value: number, duration: number | null): number {
  const upper = duration && duration > 0 ? duration : Number.POSITIVE_INFINITY;
  return clamp(value, 0, upper);
}

/**
 * Clamp a speech range to the lecture and enforce the 1 s minimum. Returns
 * `null` when the proposal is unusable (NaN, inverted, too short) or lies
 * entirely outside the lecture — an out-of-range proposal must be dropped, never
 * widened into a fabricated clip at the tail of the video.
 */
export function normalizeSpeechRange(
  start: number,
  end: number,
  duration: number | null,
): CutRange | null {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const upper = duration && duration > 0 ? duration : Number.POSITIVE_INFINITY;
  let nextStart = clamp(start, 0, upper);
  let nextEnd = clamp(end, 0, upper);
  if (nextEnd < nextStart) [nextStart, nextEnd] = [nextEnd, nextStart];
  if (nextEnd - nextStart < MIN_CLIP_SECONDS) return null;
  return { start: roundSeconds(nextStart), end: roundSeconds(nextEnd) };
}

/** Apply the auto-pad buffer to a speech range, clamped to the lecture. */
export function applyCutBuffer(
  speechStart: number,
  speechEnd: number,
  context: CutContext,
): CutRange {
  const buffer =
    context.autoPad && Number.isFinite(context.buffer) ? Math.max(0, context.buffer) : 0;
  const safeStart = Number.isFinite(speechStart) ? speechStart : 0;
  const safeEnd = Number.isFinite(speechEnd) ? speechEnd : safeStart;
  const start = clampToDuration(safeStart - buffer, context.duration);
  const end = clampToDuration(safeEnd + buffer, context.duration);
  return {
    start: roundSeconds(Math.min(start, end)),
    end: roundSeconds(Math.max(start, end)),
  };
}

/** Inverse of {@link applyCutBuffer}: turn a dragged cut range back into speech. */
export function speechFromCut(
  cutStart: number,
  cutEnd: number,
  context: CutContext,
): CutRange {
  const buffer =
    context.autoPad && Number.isFinite(context.buffer) ? Math.max(0, context.buffer) : 0;
  const start = Number.isFinite(cutStart) ? Math.max(0, cutStart + buffer) : 0;
  const end = Number.isFinite(cutEnd) ? Math.max(0, cutEnd - buffer) : start;
  return {
    start: roundSeconds(Math.min(start, end)),
    end: roundSeconds(Math.max(start, end)),
  };
}

export function rangesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && aEnd > bStart;
}

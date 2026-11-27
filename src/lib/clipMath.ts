/**
 * Pure clip-boundary math shared by Step 2 (and later by the export queue).
 *
 * A clip keeps two ranges:
 *  - `speechStart`/`speechEnd`: the AI proposal, clamped to the lecture.
 *  - `start`/`end`: the final cut, i.e. the speech bounds widened by the
 *    configurable auto-pad buffer.
 */

import { clamp, stripExtension } from "./format";
import type { ProjectClip, Resolution } from "./projectTypes";

export const MIN_CLIP_SECONDS = 1;

/**
 * The real render floor: the sidecar's `RenderClip` validator rejects clips
 * shorter than 0.5 s with a 422 that fails the whole batch. User-driven trims
 * and nudges use this floor; AI proposals keep the stricter 1 s minimum above.
 */
export const MIN_RENDERABLE_CLIP_SECONDS = 0.5;

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
 * Clamp a speech range to the lecture and enforce the given minimum (the 1 s
 * AI-proposal default; user-driven trims pass
 * {@link MIN_RENDERABLE_CLIP_SECONDS}). Returns `null` when the proposal is
 * unusable (NaN, inverted, too short) or lies entirely outside the lecture — an
 * out-of-range proposal must be dropped, never widened into a fabricated clip
 * at the tail of the video.
 */
export function normalizeSpeechRange(
  start: number,
  end: number,
  duration: number | null,
  minSeconds: number = MIN_CLIP_SECONDS,
): CutRange | null {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const upper = duration && duration > 0 ? duration : Number.POSITIVE_INFINITY;
  let nextStart = clamp(start, 0, upper);
  let nextEnd = clamp(end, 0, upper);
  if (nextEnd < nextStart) [nextStart, nextEnd] = [nextEnd, nextStart];
  if (nextEnd - nextStart < minSeconds) return null;
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

/** Resolve duration from an explicit value or fall back to the last transcript segment end. */
export function effectiveTranscriptDuration(
  duration: number | null | undefined,
  segments?: ReadonlyArray<{ end: number }>,
): number | null {
  if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
    return duration;
  }
  if (!segments?.length) return null;
  let maxEnd = 0;
  for (const segment of segments) {
    if (Number.isFinite(segment.end) && segment.end > maxEnd) {
      maxEnd = segment.end;
    }
  }
  return maxEnd > 0 ? maxEnd : null;
}

/** Synthesize one approved full-duration clip for a pre-clipped video, or `null` if too short. */
export function buildFullVideoClip(input: {
  name: string;
  sourceFileName: string | null;
  duration: number | null;
  existingId?: string;
}): ProjectClip | null {
  if (
    typeof input.duration !== "number" ||
    !Number.isFinite(input.duration) ||
    input.duration < MIN_RENDERABLE_CLIP_SECONDS
  ) {
    return null;
  }
  const end = roundSeconds(input.duration);
  const title =
    input.name.trim() ||
    (input.sourceFileName ? stripExtension(input.sourceFileName).trim() : "") ||
    "Clip";
  const id =
    input.existingId ??
    (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `clip-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return {
    id,
    title,
    rationale: "",
    start: 0,
    end,
    speechStart: 0,
    speechEnd: end,
    approved: true,
    createdAt: Date.now(),
  };
}

/** True when a clip already spans the whole video from 0 to `duration`. */
export function isFullVideoClip(clip: ProjectClip, duration: number | null): boolean {
  if (clip.start > 0.25) return false;
  if (duration === null || !Number.isFinite(duration) || duration <= 0) return true;
  return Math.abs(clip.end - duration) <= 0.25;
}

/** Pick 16:9 or 9:16 from natural video dimensions, or `null` when unknown. */
export function resolutionForDimensions(
  width: number | null | undefined,
  height: number | null | undefined,
): Resolution | null {
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return width > height ? "1920x1080" : "1080x1920";
}

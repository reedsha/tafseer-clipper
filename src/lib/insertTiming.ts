/**
 * Pure placement, trimming, snapping, and PowerPoint-style bounding-box math
 * for Step 3 visual insert footage (images and videos).
 */

import type { InsertKind, InsertRect, MediaInsert } from "@/lib/projectTypes";
import { clamp, roundTime } from "@/lib/subtitleTiming";

export const MIN_INSERT_SECONDS = 0.2;
/** Keeps adjacent insert blocks visibly and temporally separated on the track. */
export const INSERT_NEIGHBOUR_GAP = 0.02;
/** Default duration (seconds) when adding an image insert. */
export const DEFAULT_IMAGE_DURATION = 5;
export const DEFAULT_INSERT_RECT: InsertRect = { x: 0, y: 0, width: 1, height: 1 };
export const MIN_INSERT_RECT_DIM = 0.08;

export function cloneInsertRect(rect: InsertRect): InsertRect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

export function cloneInserts(list: MediaInsert[]): MediaInsert[] {
  return list.map((item) => ({ ...item, rect: cloneInsertRect(item.rect) }));
}

export function isFullFrameRect(rect: InsertRect): boolean {
  return (
    Math.abs(rect.x) < 0.002 &&
    Math.abs(rect.y) < 0.002 &&
    Math.abs(rect.width - 1) < 0.002 &&
    Math.abs(rect.height - 1) < 0.002
  );
}

export interface FreeGap {
  start: number;
  end: number;
}

export function findInsertGaps(existing: readonly MediaInsert[], clipDuration: number): FreeGap[] {
  const limit = Math.max(0, clipDuration);
  if (limit < MIN_INSERT_SECONDS) return [];
  const sorted = [...existing].sort((a, b) => a.start - b.start || a.end - b.end);
  const gaps: FreeGap[] = [];
  let cursor = 0;

  for (const item of sorted) {
    const gapEnd = Math.min(limit, item.start - INSERT_NEIGHBOUR_GAP);
    if (gapEnd - cursor >= MIN_INSERT_SECONDS - 0.001) {
      gaps.push({ start: roundTime(cursor), end: roundTime(gapEnd) });
    }
    cursor = Math.max(cursor, item.end + INSERT_NEIGHBOUR_GAP);
  }
  if (limit - cursor >= MIN_INSERT_SECONDS - 0.001) {
    gaps.push({ start: roundTime(cursor), end: roundTime(limit) });
  }
  return gaps;
}

export type PlacementResult =
  | { ok: true; start: number; end: number; sourceStart: number; trimmedToFit: boolean }
  | {
      ok: false;
      reason: "too-long" | "invalid-duration" | "no-room";
      sourceDuration?: number;
      clipDuration?: number;
    };

/**
 * Resolve `[start, end]` for a newly added image or video insert.
 *
 * - Videos longer than the entire approved clip are declined (`"too-long"`).
 * - Videos shorter than the clip prefer placing intact starting at `playhead`,
 *   or shifting earlier inside the current gap (Strategy B) so the whole clip
 *   lands without cutting off its tail when dropped near the end.
 * - Images default to 5s (clamped to clip / gap room).
 */
export function resolveInsertPlacement(params: {
  existing: readonly MediaInsert[];
  clipDuration: number;
  playhead: number;
  kind: InsertKind;
  sourceDuration: number | null;
}): PlacementResult {
  const { existing, clipDuration, playhead, kind, sourceDuration } = params;
  const limit = Math.max(0, clipDuration);

  if (kind === "video") {
    if (sourceDuration === null || !Number.isFinite(sourceDuration) || sourceDuration <= 0) {
      return { ok: false, reason: "invalid-duration" };
    }
    if (sourceDuration > limit + 0.001) {
      return {
        ok: false,
        reason: "too-long",
        sourceDuration,
        clipDuration: limit,
      };
    }
  }

  const gaps = findInsertGaps(existing, limit);
  if (gaps.length === 0) return { ok: false, reason: "no-room" };

  const safePlayhead = clamp(playhead, 0, limit);
  const containing = gaps.find(
    (gap) => safePlayhead >= gap.start - 0.001 && safePlayhead <= gap.end + 0.001,
  );

  if (kind === "video") {
    const vidDur = roundTime(sourceDuration as number);

    if (containing && containing.end - containing.start >= vidDur - 0.001) {
      if (containing.end - safePlayhead >= vidDur - 0.001) {
        const start = roundTime(Math.max(containing.start, safePlayhead));
        return {
          ok: true,
          start,
          end: roundTime(Math.min(containing.end, start + vidDur)),
          sourceStart: 0,
          trimmedToFit: false,
        };
      }
      // Strategy B: shift start earlier inside the containing gap so full video fits.
      const end = roundTime(containing.end);
      const start = roundTime(Math.max(containing.start, end - vidDur));
      return {
        ok: true,
        start,
        end,
        sourceStart: 0,
        trimmedToFit: false,
      };
    }

    const fittingGaps = gaps.filter((gap) => gap.end - gap.start >= vidDur - 0.001);
    if (fittingGaps.length > 0) {
      const closest = fittingGaps.reduce((best, gap) => {
        const dist = (g: FreeGap) =>
          safePlayhead < g.start
            ? g.start - safePlayhead
            : safePlayhead > g.end
              ? safePlayhead - g.end
              : 0;
        return dist(gap) < dist(best) ? gap : best;
      });
      if (safePlayhead >= closest.end) {
        const end = roundTime(closest.end);
        return {
          ok: true,
          start: roundTime(Math.max(closest.start, end - vidDur)),
          end,
          sourceStart: 0,
          trimmedToFit: false,
        };
      }
      const start = roundTime(closest.start);
      return {
        ok: true,
        start,
        end: roundTime(Math.min(closest.end, start + vidDur)),
        sourceStart: 0,
        trimmedToFit: false,
      };
    }

    // No single gap fits the full video: fit inside the largest available gap.
    const largest = containing ?? gaps.reduce((best, gap) => (gap.end - gap.start > best.end - best.start ? gap : best));
    const start =
      containing && containing.end - safePlayhead >= MIN_INSERT_SECONDS
        ? roundTime(Math.max(containing.start, safePlayhead))
        : roundTime(largest.start);
    const end = roundTime(largest.end);
    if (end - start < MIN_INSERT_SECONDS) return { ok: false, reason: "no-room" };
    return {
      ok: true,
      start,
      end,
      sourceStart: 0,
      trimmedToFit: end - start < vidDur - 0.01,
    };
  }

  // Image placement: default 5s, clamped to gap.
  const desired = Math.min(DEFAULT_IMAGE_DURATION, limit);
  if (containing) {
    if (containing.end - safePlayhead >= MIN_INSERT_SECONDS) {
      const start = roundTime(Math.max(containing.start, safePlayhead));
      return {
        ok: true,
        start,
        end: roundTime(Math.min(containing.end, start + desired)),
        sourceStart: 0,
        trimmedToFit: false,
      };
    }
    const end = roundTime(containing.end);
    const start = roundTime(Math.max(containing.start, end - desired));
    return { ok: true, start, end, sourceStart: 0, trimmedToFit: false };
  }

  const nextGap = gaps.find((gap) => gap.start >= safePlayhead) ?? gaps[0];
  const start = roundTime(nextGap.start);
  return {
    ok: true,
    start,
    end: roundTime(Math.min(nextGap.end, start + desired)),
    sourceStart: 0,
    trimmedToFit: false,
  };
}

export type InsertDragMode = "move" | "start" | "end";

export interface InsertDragResult {
  start: number;
  end: number;
  sourceStart: number;
  hitLimit: "source-start" | "source-end" | null;
}

function snapValue(
  raw: number,
  targets: readonly number[],
  threshold: number,
): number {
  if (!(threshold > 0) || targets.length === 0) return raw;
  let best = raw;
  let bestDist = threshold;
  for (const target of targets) {
    const dist = Math.abs(target - raw);
    if (dist <= bestDist) {
      bestDist = dist;
      best = target;
    }
  }
  return best;
}

/**
 * Compute new `[start, end, sourceStart]` during a track drag.
 *
 * - For videos, dragging the left edge right advances `sourceStart` (trims from
 *   the front); dragging back left recovers down to `sourceStart = 0`.
 * - Dragging the right edge cannot extend past `sourceDuration - sourceStart`.
 */
export function computeInsertDrag(params: {
  insert: Pick<MediaInsert, "kind" | "start" | "end" | "sourceStart" | "sourceDuration">;
  mode: InsertDragMode;
  deltaSeconds: number;
  lowerBound: number;
  upperBound: number;
  clipDuration: number;
  snapTargets?: readonly number[];
  snapThresholdSeconds?: number;
}): InsertDragResult {
  const {
    insert,
    mode,
    deltaSeconds,
    lowerBound,
    upperBound,
    clipDuration,
    snapTargets = [],
    snapThresholdSeconds = 0,
  } = params;

  const limit = Math.max(0, clipDuration);
  const safeLower = clamp(lowerBound, 0, limit);
  const safeUpper = clamp(upperBound, safeLower, limit);

  if (mode === "move") {
    const span = insert.end - insert.start;
    const minShift = safeLower - insert.start;
    const maxShift = safeUpper - insert.end;
    if (minShift > maxShift) {
      return {
        start: insert.start,
        end: insert.end,
        sourceStart: insert.sourceStart,
        hitLimit: null,
      };
    }
    let shift = clamp(deltaSeconds, minShift, maxShift);
    if (snapThresholdSeconds > 0 && snapTargets.length > 0) {
      const candStart = insert.start + shift;
      const candEnd = insert.end + shift;
      const snappedStart = snapValue(candStart, snapTargets, snapThresholdSeconds);
      const snappedEnd = snapValue(candEnd, snapTargets, snapThresholdSeconds);
      const startDist = Math.abs(snappedStart - candStart);
      const endDist = Math.abs(snappedEnd - candEnd);
      if (snappedStart !== candStart && startDist <= endDist) {
        shift = clamp(snappedStart - insert.start, minShift, maxShift);
      } else if (snappedEnd !== candEnd) {
        shift = clamp(snappedEnd - insert.end, minShift, maxShift);
      }
    }
    const start = clamp(insert.start + shift, 0, limit);
    const end = clamp(start + span, 0, limit);
    return {
      start,
      end,
      sourceStart: insert.sourceStart,
      hitLimit: null,
    };
  }

  if (mode === "start") {
    const isVideo = insert.kind === "video";
    const originSourceStart = Math.max(0, insert.sourceStart);
    const sourceZeroBoundary = isVideo ? insert.start - originSourceStart : 0;
    const minStart = isVideo ? Math.max(safeLower, sourceZeroBoundary) : safeLower;
    const maxStart = Math.max(minStart, insert.end - MIN_INSERT_SECONDS);

    const rawStart = insert.start + deltaSeconds;
    const hitStartLimit = isVideo && rawStart < sourceZeroBoundary - 0.005;
    const snapped = snapValue(rawStart, snapTargets, snapThresholdSeconds);
    const start =
      minStart <= maxStart ? clamp(snapped, minStart, maxStart) : insert.start;
    const nextSourceStart = isVideo
      ? Math.max(0, originSourceStart + (start - insert.start))
      : 0;

    return {
      start: clamp(start, 0, limit),
      end: insert.end,
      sourceStart: nextSourceStart,
      hitLimit: hitStartLimit ? "source-start" : null,
    };
  }

  // mode === "end"
  const isVideo = insert.kind === "video";
  const maxDurationLeft =
    isVideo && insert.sourceDuration !== null && Number.isFinite(insert.sourceDuration)
      ? Math.max(0, insert.sourceDuration - Math.max(0, insert.sourceStart))
      : limit;
  const maxEndFromSource = isVideo ? insert.start + maxDurationLeft : safeUpper;
  const minEnd = insert.start + MIN_INSERT_SECONDS;
  const maxEnd = Math.min(safeUpper, maxEndFromSource);

  const rawEnd = insert.end + deltaSeconds;
  const hitEndLimit = isVideo && rawEnd > maxEndFromSource + 0.005;
  const snapped = snapValue(rawEnd, snapTargets, snapThresholdSeconds);
  const end = minEnd <= maxEnd ? clamp(snapped, minEnd, maxEnd) : insert.end;

  return {
    start: insert.start,
    end: clamp(end, 0, limit),
    sourceStart: Math.max(0, insert.sourceStart),
    hitLimit: hitEndLimit ? "source-end" : null,
  };
}

export type RectHandle = "move" | "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w";

export interface RectDragResult {
  rect: InsertRect;
  guides: { verticalCenter: boolean; horizontalCenter: boolean };
}

function roundRectVal(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * Compute PowerPoint-style move/resize rect inside normalized `[0, 1]` monitor space.
 */
export function computeRectDrag(params: {
  originRect: InsertRect;
  handle: RectHandle;
  dxNorm: number;
  dyNorm: number;
  lockAspect: boolean;
  /** Monitor width / height (e.g. 9/16 = 0.5625 or 16/9 = 1.7778). */
  frameAspect: number;
}): RectDragResult {
  const { originRect, handle, dxNorm, dyNorm, lockAspect, frameAspect } = params;
  const SNAP = 0.015;
  let verticalCenter = false;
  let horizontalCenter = false;

  if (handle === "move") {
    let x = clamp(originRect.x + dxNorm, 0, Math.max(0, 1 - originRect.width));
    let y = clamp(originRect.y + dyNorm, 0, Math.max(0, 1 - originRect.height));

    const centerX = x + originRect.width * 0.5;
    const centerY = y + originRect.height * 0.5;
    if (Math.abs(centerX - 0.5) <= SNAP) {
      x = 0.5 - originRect.width * 0.5;
      verticalCenter = true;
    } else if (Math.abs(x) <= SNAP) {
      x = 0;
    } else if (Math.abs(x + originRect.width - 1) <= SNAP) {
      x = 1 - originRect.width;
    }

    if (Math.abs(centerY - 0.5) <= SNAP) {
      y = 0.5 - originRect.height * 0.5;
      horizontalCenter = true;
    } else if (Math.abs(y) <= SNAP) {
      y = 0;
    } else if (Math.abs(y + originRect.height - 1) <= SNAP) {
      y = 1 - originRect.height;
    }

    return {
      rect: {
        x: roundRectVal(x),
        y: roundRectVal(y),
        width: roundRectVal(originRect.width),
        height: roundRectVal(originRect.height),
      },
      guides: { verticalCenter, horizontalCenter },
    };
  }

  const left0 = originRect.x;
  const top0 = originRect.y;
  const right0 = originRect.x + originRect.width;
  const bottom0 = originRect.y + originRect.height;

  const isCorner = handle === "nw" || handle === "ne" || handle === "sw" || handle === "se";
  if (isCorner && lockAspect) {
    // Preserve visual pixel aspect ratio: pixelW / pixelH = (normW * frameAspect) / normH
    // => normH = normW / k where k = originRect.width / originRect.height
    const ratioNorm = Math.max(0.05, originRect.width / Math.max(0.01, originRect.height));
    const minW = Math.max(MIN_INSERT_RECT_DIM, MIN_INSERT_RECT_DIM * ratioNorm);
    const minH = minW / ratioNorm;

    const anchorX = handle === "nw" || handle === "sw" ? right0 : left0;
    const anchorY = handle === "nw" || handle === "ne" ? bottom0 : top0;
    const signX = handle === "nw" || handle === "sw" ? -1 : 1;
    const signY = handle === "nw" || handle === "ne" ? -1 : 1;

    const maxW = signX > 0 ? 1 - anchorX : anchorX;
    const maxH = signY > 0 ? 1 - anchorY : anchorY;
    const boundW = Math.min(maxW, maxH * ratioNorm);

    const candW = originRect.width + signX * dxNorm;
    const candH = originRect.height + signY * dyNorm;
    const wFromX = candW;
    const wFromY = candH * ratioNorm;
    const rawW =
      Math.abs(dxNorm) * frameAspect >= Math.abs(dyNorm) ? wFromX : wFromY;
    const w = clamp(rawW, Math.min(minW, boundW), Math.max(minW, boundW));
    const h = clamp(w / ratioNorm, Math.min(minH, maxH), maxH);
    const finalW = Math.min(w, h * ratioNorm);
    const finalH = finalW / ratioNorm;

    const x = signX > 0 ? anchorX : anchorX - finalW;
    const y = signY > 0 ? anchorY : anchorY - finalH;
    return {
      rect: {
        x: roundRectVal(clamp(x, 0, 1 - finalW)),
        y: roundRectVal(clamp(y, 0, 1 - finalH)),
        width: roundRectVal(finalW),
        height: roundRectVal(finalH),
      },
      guides: { verticalCenter: false, horizontalCenter: false },
    };
  }

  let left = left0;
  let right = right0;
  let top = top0;
  let bottom = bottom0;

  if (handle.includes("w")) {
    left = clamp(left0 + dxNorm, 0, right0 - MIN_INSERT_RECT_DIM);
    if (Math.abs(left) <= SNAP) left = 0;
  }
  if (handle.includes("e")) {
    right = clamp(right0 + dxNorm, left0 + MIN_INSERT_RECT_DIM, 1);
    if (Math.abs(right - 1) <= SNAP) right = 1;
  }
  if (handle.includes("n")) {
    top = clamp(top0 + dyNorm, 0, bottom0 - MIN_INSERT_RECT_DIM);
    if (Math.abs(top) <= SNAP) top = 0;
  }
  if (handle.includes("s")) {
    bottom = clamp(bottom0 + dyNorm, top0 + MIN_INSERT_RECT_DIM, 1);
    if (Math.abs(bottom - 1) <= SNAP) bottom = 1;
  }

  return {
    rect: {
      x: roundRectVal(left),
      y: roundRectVal(top),
      width: roundRectVal(right - left),
      height: roundRectVal(bottom - top),
    },
    guides: { verticalCenter: false, horizontalCenter: false },
  };
}

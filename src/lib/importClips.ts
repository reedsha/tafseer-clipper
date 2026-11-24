/**
 * Paste-JSON clip import for Step 2 ("Import from chat").
 *
 * Lenient by design: a browser chat AI's reply is never guaranteed to be clean
 * JSON, so the parser strips code fences, salvages individual clip objects out
 * of prose, and mirrors the sidecar's deterministic safety guards
 * (`backend/services/analyzer.py::sanitize_clips`): structural checks only, a
 * 15-second floor, no maximum length, and the lecture-scaled flood ceiling
 * from `clipGuards`. Every dropped or clamped entry is reported back so the
 * dialog can show it — nothing is silently discarded.
 */

import type { ClipProposal, TimeRange } from "./api";
import {
  applyCutBuffer,
  normalizeSpeechRange,
  rangesOverlap,
} from "./clipMath";
import { floodCeiling, SAFETY_MIN_CLIP_SECONDS } from "./clipGuards";
import type { ProjectClip } from "./projectTypes";

/** One clip-shaped entry that survived validation, before the cut buffer. */
export interface ImportRow {
  /** Speech bounds as the chat AI reported them, clamped to the lecture. */
  start: number;
  end: number;
  title: string;
  rationale: string;
  /** True when a bound was clamped into the lecture's range. */
  clamped: boolean;
  /** True when the cut overlaps an already-approved clip (kept, just flagged). */
  overlapsApproved: boolean;
}

/** An entry that could not be imported, with the reason it was dropped. */
export interface DroppedClip {
  reason: string;
  title?: string;
  start?: number;
  end?: number;
}

export interface ImportPreview {
  /** Valid clips, sorted by start time, after flood-ceiling thinning. */
  rows: ImportRow[];
  dropped: DroppedClip[];
  /** Rows that survived the flood ceiling — what Import will commit. */
  keptCount: number;
  /** Valid clips before flood-ceiling thinning. */
  totalCount: number;
  thinned: boolean;
}

export interface ImportParseOptions {
  /** Lecture duration in seconds; non-positive means "unknown". */
  duration: number;
  /** Cut ranges of already-approved clips, for overlap flags. */
  approvedRanges: TimeRange[];
}

const SALVAGE_OBJECT_RE = /\{[^{}]*\}/g;

function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return Number.NaN;
}

/**
 * Pull a clip list out of a chat reply: a bare array, a `{"clips": [...]}`
 * wrapper (the shape the brief requests), any other array-of-objects wrapper,
 * or — when the reply is prose-wrapped or broken — every salvageable `{...}`
 * object in the text (mirrors the sidecar's `_salvage_clip_objects`).
 */
function extractClipList(raw: string): unknown[] | null {
  const text = stripFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (Array.isArray(parsed)) return parsed;
  if (isRecord(parsed)) {
    if (Array.isArray(parsed.clips)) return parsed.clips;
    for (const value of Object.values(parsed)) {
      if (Array.isArray(value) && value.some(isRecord)) return value;
    }
  }
  const salvaged = (text.match(SALVAGE_OBJECT_RE) ?? [])
    .map((chunk) => {
      try {
        return JSON.parse(chunk) as unknown;
      } catch {
        return undefined;
      }
    })
    .filter(isRecord);
  return salvaged.length > 0 ? salvaged : null;
}

/** Evenly spread subset, so the ceiling never chops off the lecture tail. */
function thinEvenly<T>(items: T[], limit: number): T[] {
  if (limit <= 0 || items.length === 0) return [];
  if (items.length <= limit) return [...items];
  const step = items.length / limit;
  return Array.from(
    { length: limit },
    (_slot, position) => items[Math.min(items.length - 1, Math.floor(position * step))],
  );
}

/**
 * Validate pasted chat output into import rows. Structural checks only —
 * `end <= start`, non-finite bounds and fully-outside clips are dropped with a
 * reason; partial overruns are clamped and flagged; anything under the
 * 15-second floor is dropped; there is no maximum length; above the
 * lecture-scaled flood ceiling the rows are evenly thinned (flagged).
 */
export function parseImportedClips(
  raw: string,
  options: ImportParseOptions,
): ImportPreview {
  const { duration, approvedRanges } = options;
  const hasDuration = Number.isFinite(duration) && duration > 0;
  const upper = hasDuration ? duration : Number.POSITIVE_INFINITY;

  const valid: ImportRow[] = [];
  const dropped: DroppedClip[] = [];

  const list = extractClipList(raw);
  if (!list) {
    return { rows: [], dropped, keptCount: 0, totalCount: 0, thinned: false };
  }
  // Everything the reply contained, so the summary can say "2/3" next to
  // "1 dropped" instead of hiding the losses behind the denominator.
  const totalCount = list.length;

  for (const item of list) {
    if (!isRecord(item)) {
      dropped.push({ reason: "missing times" });
      continue;
    }
    const title =
      typeof item.title === "string" ? item.title.trim().slice(0, 120) : "";
    const rationale =
      typeof item.rationale === "string" ? item.rationale.trim().slice(0, 400) : "";
    const start = toFiniteNumber(item.start);
    const end = toFiniteNumber(item.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      dropped.push({ reason: "missing times", title: title || undefined });
      continue;
    }
    if (end <= start) {
      dropped.push({
        reason: "empty range",
        title: title || undefined,
        start,
        end,
      });
      continue;
    }
    if (start >= upper || end <= 0) {
      dropped.push({
        reason: "outside the lecture",
        title: title || undefined,
        start,
        end,
      });
      continue;
    }
    const clampedStart = Math.max(0, start);
    const clampedEnd = Math.min(upper, end);
    if (clampedEnd - clampedStart < SAFETY_MIN_CLIP_SECONDS) {
      dropped.push({
        reason: `under ${SAFETY_MIN_CLIP_SECONDS} seconds`,
        title: title || undefined,
        start,
        end,
      });
      continue;
    }
    valid.push({
      start: clampedStart,
      end: clampedEnd,
      title: title || "Untitled clip",
      rationale,
      clamped: clampedStart !== start || clampedEnd !== end,
      overlapsApproved: false,
    });
  }

  valid.sort((a, b) => a.start - b.start);

  let thinned = false;
  let rows = valid;
  if (hasDuration && totalCount > floodCeiling(duration)) {
    rows = thinEvenly(valid, floodCeiling(duration));
    thinned = true;
  }

  for (const row of rows) {
    row.overlapsApproved = approvedRanges.some((range) =>
      rangesOverlap(row.start, row.end, range.start, range.end),
    );
  }

  return {
    rows,
    dropped,
    keptCount: rows.length,
    totalCount,
    thinned,
  };
}

/**
 * Turn one validated proposal into a deck clip: speech bounds clamped to the
 * lecture, final cut widened by the auto-pad buffer. Unapproved on arrival.
 * (Relocated verbatim from Step2Discovery so the import dialog shares the
 * exact same conversion path as in-app discovery results.)
 */
export function proposalToClip(
  proposal: ClipProposal,
  index: number,
  duration: number | null,
  buffer: number,
  autoPad: boolean,
): ProjectClip | null {
  const speech = normalizeSpeechRange(proposal.start, proposal.end, duration);
  if (!speech) return null;
  const cut = applyCutBuffer(speech.start, speech.end, { duration, buffer, autoPad });
  return {
    id: crypto.randomUUID(),
    title: proposal.title.trim() || `Clip ${index + 1}`,
    rationale: proposal.rationale.trim(),
    start: cut.start,
    end: cut.end,
    speechStart: speech.start,
    speechEnd: speech.end,
    approved: false,
    createdAt: Date.now(),
  };
}

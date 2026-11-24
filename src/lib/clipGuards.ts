/**
 * Deterministic safety guards shared by the chat-brief importer (Step 2) and
 * the sidecar's `sanitize_clips`. These are not editorial limits: they only
 * drop nonsense (a blink) and stop a pathological reply from flooding Step 2.
 * The discovery model decides the real count and length of clips.
 */

/** Minimum usable clip length, in seconds. Mirrors the sidecar's floor. */
export const SAFETY_MIN_CLIP_SECONDS = 15;

/** One clip slot per this many seconds of lecture. */
const FLOOD_CEILING_DIVISOR = 120;

/** Flood-ceiling bounds: short lectures stay usable, long ones never truncate. */
const FLOOD_CEILING_MIN = 6;
const FLOOD_CEILING_MAX = 120;

/**
 * Maximum number of clips one reply may deliver, scaled by lecture length:
 * `clamp(ceil(duration / 120 s), 6, 120)`.
 *
 * Pathological-reply tripwire, not an editorial limit. The model decides clip
 * count and length; this only bounds how many clips one reply may deliver.
 */
export function floodCeiling(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return FLOOD_CEILING_MIN;
  }
  const scaled = Math.ceil(durationSeconds / FLOOD_CEILING_DIVISOR);
  return Math.max(FLOOD_CEILING_MIN, Math.min(FLOOD_CEILING_MAX, scaled));
}

/**
 * Shared sample vectors: `[[duration, expected ceiling], ...]`. The backend
 * parity check (`backend/test_phase1_e2e.py`) reads this table and asserts its
 * Python `flood_ceiling` agrees, so the two implementations cannot drift.
 */
export const FLOOD_CEILING_SAMPLES: readonly (readonly [number, number])[] = [
  [300, 6],
  [600, 6],
  [1800, 15],
  [3600, 30],
  [7200, 60],
  [10800, 90],
  [14400, 120],
  [18000, 120],
];

/**
 * Single source of truth for the numeric ranges of persisted settings.
 *
 * The Settings drawer renders these as slider bounds and the store re-applies
 * them when a snapshot is rehydrated or a `.json` backup is imported. Sharing
 * one table keeps a stored value representable by the control that edits it:
 * an out-of-range number can never reach the UI only to fight its slider.
 */

export interface NumericRange {
  min: number;
  max: number;
  step: number;
}

export const NUMERIC_LIMITS = {
  arabicFontSize: { min: 24, max: 120, step: 1 },
  arabicLineHeightPad: { min: 1, max: 1.8, step: 0.05 },
  arabicOutlineWidth: { min: 0, max: 8, step: 0.5 },
  thaiFontSize: { min: 20, max: 96, step: 1 },
  thaiOutlineWidth: { min: 0, max: 8, step: 0.5 },
  /** Stored as a 0–1 fraction; the drawer edits it as 0–100 %. */
  boxOpacity: { min: 0, max: 1, step: 0.01 },
  /** Per-line vertical move in export-frame pixels, on top of the default anchor. */
  verticalOffset: { min: -900, max: 900, step: 1 },
  cutBufferSeconds: { min: 0, max: 1.5, step: 0.05 },
  /** Step 2 edge buttons / keyboard shortcuts for growing or trimming a clip. */
  edgeButtonStepSeconds: { min: 0.1, max: 60, step: 0.1 },
  edgeKeyStepSeconds: { min: 0.1, max: 60, step: 0.1 },
  /** Floor matches the wrap engine's own minimum (`subtitleCues.ts`). */
  maxCharsPerLine: { min: 8, max: 80, step: 1 },
  /** Upper bound is a sanity guard; the interval list stays open-ended. */
  autosaveIntervalMs: { min: 0, max: 60 * 60_000, step: 1_000 },
} as const satisfies Record<string, NumericRange>;

export type NumericLimitKey = keyof typeof NUMERIC_LIMITS;

/**
 * Snap to the slider step, then clamp to its range. Snapping first means an
 * imported `0.37 s` buffer lands on `0.35 s` (a position the slider can show)
 * instead of a value the thumb can never reach.
 */
export function coerceToRange(value: number, fallback: number, range: NumericRange): number {
  if (!Number.isFinite(value)) return fallback;
  const stepped = Math.round(value / range.step) * range.step;
  const clamped = Math.min(range.max, Math.max(range.min, stepped));
  // Strip float noise from the step math (0.15000000000000002 → 0.15).
  return Number(clamped.toFixed(4));
}

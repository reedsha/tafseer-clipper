/**
 * Clip-local waveform slicing.
 *
 * The sidecar returns one envelope for the whole lecture. Step 2 renders a
 * viewport that is exactly the selected clip, so the envelope is sliced to the
 * clip before it reaches wavesurfer. The slice is bucket-aligned (floor/ceil),
 * which can shift a feature by at most one bucket; the bar itself always maps
 * x = 0 to `clipStart` and x = width to `clipEnd`.
 */

export interface ClipPeakSlice {
  /** Envelope points covering the clip, in lecture order. */
  points: number[];
  /** First envelope bucket included (0-based). */
  startIndex: number;
  /** One past the last envelope bucket included. */
  endIndex: number;
}

export function clipPeakSlice(
  peaks: readonly number[] | null | undefined,
  duration: number,
  clipStart: number,
  clipEnd: number,
): ClipPeakSlice {
  if (
    !peaks ||
    peaks.length === 0 ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isFinite(clipStart) ||
    !Number.isFinite(clipEnd)
  ) {
    return { points: [], startIndex: 0, endIndex: 0 };
  }

  const safeStart = Math.max(0, Math.min(clipStart, duration));
  const safeEnd = Math.max(safeStart, Math.min(clipEnd, duration));
  const startIndex = Math.min(
    peaks.length - 1,
    Math.max(0, Math.floor((safeStart / duration) * peaks.length)),
  );
  // Keep at least one bucket: a clip shorter than one envelope bucket still
  // needs a mark to draw, and `Array#slice` with an empty range would make the
  // waveform look unavailable.
  const endIndex = Math.min(
    peaks.length,
    Math.max(startIndex + 1, Math.ceil((safeEnd / duration) * peaks.length)),
  );

  return { points: peaks.slice(startIndex, endIndex), startIndex, endIndex };
}

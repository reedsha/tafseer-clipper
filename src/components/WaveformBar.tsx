import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { AlertTriangle, AudioLines, Minus, Plus } from "lucide-react";

import { TimeFlow } from "@/components/TimeFlow";
import { Button } from "@/components/ui/button";
import { MIN_RENDERABLE_CLIP_SECONDS } from "@/lib/clipMath";
import { clamp } from "@/lib/format";
import { clipPeakSlice } from "@/lib/waveform";

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export interface WaveformBarProps {
  /**
   * Precomputed waveform envelope from the sidecar (0..1). The envelope is
   * sliced to the selected clip; without it the clip waveform cannot be drawn
   * (the old full-lecture media fallback is deliberately gone).
   */
  peaks?: number[] | null;
  /** Full lecture length in seconds. */
  duration: number;
  clipStart: number;
  clipEnd: number;
  /** Video playhead in seconds (absolute lecture time). */
  playhead: number;
  onSeek: (seconds: number) => void;
  /** Grow the clip at this edge by the button step (outward). */
  onExpand: (edge: "start" | "end") => void;
  /** Trim the clip at this edge by the button step (inward). */
  onCollapse: (edge: "start" | "end") => void;
}

/**
 * wavesurfer.js waveform scrubber whose viewport is exactly the selected clip.
 * The AI proposes the boundaries; the editor only grows or trims them at the
 * two edges. The clip fills the bar (no margin, no shaded region, no
 * full-lecture view), so every pixel maps to a real time inside the cut.
 *
 * The waveform renders from precomputed peaks only. Handing wavesurfer the
 * lecture media URL would make its duration the full lecture and let the
 * cursor/seek clock disagree with the drawn window; the video element is the
 * single playback source.
 */
export function WaveformBar({
  peaks,
  duration,
  clipStart,
  clipEnd,
  playhead,
  onSeek,
  onExpand,
  onCollapse,
}: WaveformBarProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const loadTokenRef = useRef(0);
  const onSeekRef = useRef(onSeek);
  const playheadRef = useRef(playhead);

  const [ready, setReady] = useState(false);
  // The duration wavesurfer actually loaded (the clip window, not the lecture).
  // Exposed as `data-window` so the E2E can prove the viewport rescales.
  const [windowSeconds, setWindowSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onSeekRef.current = onSeek;
  }, [onSeek]);

  useEffect(() => {
    playheadRef.current = playhead;
  }, [playhead]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Deliberately no peaks/duration here: the effect below is the only loader,
    // so there is no internal load racing the explicit load() call.
    const wavesurfer = WaveSurfer.create({
      container,
      height: 72,
      waveColor: cssVar("--border", "#262b2f"),
      progressColor: cssVar("--ring", "#707a82"),
      cursorColor: cssVar("--foreground", "#e7e9ea"),
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1,
      barRadius: 1,
      normalize: true,
      interact: true,
      dragToSeek: true,
      hideScrollbar: true,
      fillParent: true,
      autoScroll: false,
      minPxPerSec: 0,
      sampleRate: 4000,
    });

    wavesurferRef.current = wavesurfer;

    const disposers = [
      wavesurfer.on("ready", (durationSeconds) => {
        setReady(true);
        setWindowSeconds(durationSeconds);
        setError(null);
        wavesurfer.setMuted(true);
        wavesurfer.setTime(clamp(playheadRef.current - windowStartRef.current, 0, durationSeconds));
      }),
      wavesurfer.on("error", (loadError) => {
        // Ignore errors from detached/destroyed instances (handles the dev
        // StrictMode double-mount while so the stale instance never reports).
        if (wavesurferRef.current !== wavesurfer) return;
        setReady(false);
        setError(loadError.message || "The waveform could not be prepared.");
      }),
      wavesurfer.on("interaction", (seconds) => {
        // Map the window-local seconds back to absolute lecture time.
        onSeekRef.current(seconds + windowStartRef.current);
      }),
    ];

    return () => {
      disposers.forEach((dispose) => dispose());
      if (wavesurferRef.current !== wavesurfer) return;
      wavesurferRef.current = null;
      wavesurfer.destroy();
      setReady(false);
    };
  }, []);

  // Exact clip viewport: the waveform window starts and ends on the cut, and
  // the envelope is sliced to it. This is the only loader; edge changes re-run
  // it so the bar always represents the current clip.
  const windowStartRef = useRef(0);
  const peakCount = peaks?.length ?? 0;
  useEffect(() => {
    const wavesurfer = wavesurferRef.current;
    if (!wavesurfer) return;
    if (peakCount === 0 || duration <= 0 || clipEnd <= clipStart) {
      setReady(false);
      setWindowSeconds(0);
      setError(null);
      loadTokenRef.current += 1;
      windowStartRef.current = 0;
      wavesurfer.empty();
      return;
    }
    setReady(false);
    setWindowSeconds(0);
    setError(null);
    const windowStart = Math.max(0, clipStart);
    const windowEnd = Math.min(duration, clipEnd);
    if (windowEnd <= windowStart) {
      loadTokenRef.current += 1;
      windowStartRef.current = 0;
      wavesurfer.empty();
      return;
    }
    const windowDuration = windowEnd - windowStart;
    windowStartRef.current = windowStart;

    const slice = clipPeakSlice(peaks, duration, windowStart, windowEnd);
    if (slice.points.length === 0) {
      loadTokenRef.current += 1;
      windowStartRef.current = 0;
      wavesurfer.empty();
      return;
    }

    const token = ++loadTokenRef.current;
    // Peaks-only load: no media URL, so wavesurfer's duration is the clip
    // window (not the full lecture) and no WAV is fetched or decoded. The
    // waveform only scrubs; the <video> element owns playback.
    void wavesurfer.load("", [slice.points], windowDuration).catch((loadError: unknown) => {
      if (loadTokenRef.current !== token || wavesurferRef.current !== wavesurfer) return;
      setReady(false);
      setError(loadError instanceof Error ? loadError.message : "The waveform could not be loaded.");
    });
  }, [peaks, peakCount, duration, clipStart, clipEnd]);

  useEffect(() => {
    const wavesurfer = wavesurferRef.current;
    if (!wavesurfer || !ready) return;
    const windowDuration = wavesurfer.getDuration();
    if (!windowDuration) return;
    wavesurfer.setTime(clamp(playhead - windowStartRef.current, 0, windowDuration));
  }, [playhead, ready, clipStart, clipEnd]);

  const hasPeaks = peakCount > 0;
  const waveformUnavailable = !hasPeaks || duration <= 0;
  const hasClip = clipEnd > clipStart && clipStart >= 0 && duration > 0;
  const clipLength = clipEnd - clipStart;
  const canCollapse = clipLength > MIN_RENDERABLE_CLIP_SECONDS + 0.001;
  const canExpandStart = clipStart > 0.001;
  const canExpandEnd = duration > 0 && clipEnd < duration - 0.001;
  const unavailableMessage = !hasPeaks
    ? "Waveform unavailable — this session has no stored waveform. Re-run transcription to rebuild it."
    : "Waveform unavailable — the lecture duration is unknown.";

  return (
    <div
      className="space-y-1.5"
      data-playhead={Number.isFinite(playhead) ? playhead.toFixed(3) : "0.000"}
      data-window={windowSeconds.toFixed(3)}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <AudioLines className="size-3.5 text-muted-foreground" />
          <span className="text-[11px] font-medium text-foreground/90">Waveform</span>
          <span className="hidden text-[10px] text-muted-foreground sm:inline">
            the clip fills the waveform · + grows · − trims
          </span>
        </div>
      </div>

      <div className="relative overflow-hidden rounded-md border border-border bg-background/60">
        <div ref={containerRef} className="h-[72px] w-full" />
        {hasClip && waveformUnavailable ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-background/50 px-3 text-center">
            <AudioLines className="size-4 text-muted-foreground" />
            <p className="line-clamp-2 max-w-md text-[11px] text-muted-foreground">
              {unavailableMessage}
            </p>
          </div>
        ) : error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-background/60 px-3 text-center">
            <AlertTriangle className="size-4 text-muted-foreground" />
            <p className="line-clamp-2 max-w-md text-[11px] text-muted-foreground">
              Could not load the waveform: {error}
            </p>
          </div>
        ) : hasClip && !ready ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/40">
            <p className="text-[11px] text-muted-foreground">Loading waveform…</p>
          </div>
        ) : null}
      </div>

      {hasClip ? (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[10px] tabular-nums text-muted-foreground">
          <div className="flex items-center gap-1">
            <span className="mr-0.5 uppercase tracking-[0.14em]">In</span>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              aria-label="Grow clip at the start"
              disabled={!canExpandStart}
              onClick={() => onExpand("start")}
            >
              <Plus className="size-3" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              aria-label="Trim clip at the start"
              disabled={!canCollapse}
              onClick={() => onCollapse("start")}
            >
              <Minus className="size-3" />
            </Button>
            <TimeFlow value={clipStart} tenths className="ml-0.5 text-[11px] text-foreground/80" />
          </div>
          <div className="flex items-center gap-1">
            <TimeFlow value={clipEnd} tenths className="mr-0.5 text-[11px] text-foreground/80" />
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              aria-label="Trim clip at the end"
              disabled={!canCollapse}
              onClick={() => onCollapse("end")}
            >
              <Minus className="size-3" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              aria-label="Grow clip at the end"
              disabled={!canExpandEnd}
              onClick={() => onExpand("end")}
            >
              <Plus className="size-3" />
            </Button>
            <span className="ml-0.5 uppercase tracking-[0.14em]">Out</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

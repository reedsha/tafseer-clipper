import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { AlertTriangle, AudioLines, Minus, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MIN_RENDERABLE_CLIP_SECONDS } from "@/lib/clipMath";
import { clamp, formatClock } from "@/lib/format";

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export interface WaveformBarProps {
  /** Asset URL for the sidecar's 16 kHz WAV extract. */
  audioUrl: string | null;
  /**
   * Precomputed waveform envelope from the sidecar (0..1). When present the
   * waveform renders from these peaks and never decodes the full PCM WAV into
   * WebView2 memory; when absent it falls back to URL decoding.
   */
  peaks?: number[] | null;
  /** Full lecture length in seconds; the waveform viewport is clipped to the selected clip. */
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
 * two edges. There is no shaded region or full-lecture view — clip widths for
 * a 1–3 hour lecture stay readable because the waveform is zoomed to the clip.
 */
export function WaveformBar({
  audioUrl,
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
        setError(null);
        wavesurfer.setMuted(true);
        wavesurfer.setTime(clamp(playheadRef.current, 0, durationSeconds));
      }),
      wavesurfer.on("error", (loadError) => {
        // Ignore errors from detached/destroyed instances (handles the dev
        // StrictMode double-mount while so the stale instance never reports).
        if (wavesurferRef.current !== wavesurfer) return;
        setReady(false);
        setError(loadError.message || "The audio extract could not be decoded.");
      }),
      wavesurfer.on("interaction", (seconds) => {
        // wavesurfer reports absolute lecture time even when zoomed/scrolled,
        // so the parent receives the same clock the rest of Step 2 uses.
        onSeekRef.current(seconds);
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

  useEffect(() => {
    const wavesurfer = wavesurferRef.current;
    if (!wavesurfer) return;
    if (!audioUrl) {
      setReady(false);
      setError(null);
      loadTokenRef.current += 1;
      wavesurfer.empty();
      return;
    }
    setReady(false);
    setError(null);
    const channelData = peaks && peaks.length > 0 && duration > 0 ? [peaks] : undefined;
    const knownDuration = channelData ? duration : undefined;
    const token = ++loadTokenRef.current;
    void wavesurfer.load(audioUrl, channelData, knownDuration).catch((loadError: unknown) => {
      // A newer load()/empty() or a detached instance supersedes this attempt,
      // so "suspended by a newer load call" and similar races are ignored.
      if (loadTokenRef.current !== token || wavesurferRef.current !== wavesurfer) return;
      setReady(false);
      setError(
        loadError instanceof Error ? loadError.message : "The audio extract could not be loaded.",
      );
    });
  }, [audioUrl, peaks, duration]);

  // Keep the viewport locked to [clipStart, clipEnd]. Re-running on every edge
  // change makes the waveform redraw longer as the clip grows and shorter as
  // it is trimmed — there is no separate zoom control in this editor.
  useEffect(() => {
    const wavesurfer = wavesurferRef.current;
    if (!wavesurfer || !ready) return;
    if (!wavesurfer.getDuration()) return;

    const width = wavesurfer.getWidth() || containerRef.current?.clientWidth || 640;
    const visibleSpan = Math.max(0.1, clipEnd - clipStart);
    wavesurfer.zoom(Math.max(1, width / visibleSpan));

    const frame = window.requestAnimationFrame(() => {
      wavesurfer.setScrollTime(Math.max(0, clipStart));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [ready, clipStart, clipEnd]);

  useEffect(() => {
    const wavesurfer = wavesurferRef.current;
    if (!wavesurfer || !ready) return;
    if (!wavesurfer.getDuration()) return;
    wavesurfer.setTime(clamp(playhead, 0, duration));
  }, [playhead, ready, duration]);

  const unavailable = !audioUrl;
  const clipLength = clipEnd - clipStart;
  const hasClip = ready && clipLength > 0 && clipStart >= 0 && duration > 0;
  const canCollapse = clipLength > MIN_RENDERABLE_CLIP_SECONDS + 0.001;
  const canExpandStart = clipStart > 0.001;
  const canExpandEnd = clipEnd < duration - 0.001;

  return (
    <div className="space-y-1.5">
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
        {hasClip ? (
          <>
            <div className="absolute left-0 top-1/2 z-10 flex -translate-y-1/2 gap-1">
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                className="bg-background"
                aria-label="Grow clip at the start"
                disabled={!canExpandStart}
                onClick={(event) => {
                  event.stopPropagation();
                  onExpand("start");
                }}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
              >
                <Plus className="size-3" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                className="bg-background"
                aria-label="Trim clip at the start"
                disabled={!canCollapse}
                onClick={(event) => {
                  event.stopPropagation();
                  onCollapse("start");
                }}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
              >
                <Minus className="size-3" />
              </Button>
            </div>
            <div className="absolute right-0 top-1/2 z-10 flex -translate-y-1/2 gap-1">
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                className="bg-background"
                aria-label="Trim clip at the end"
                disabled={!canCollapse}
                onClick={(event) => {
                  event.stopPropagation();
                  onCollapse("end");
                }}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
              >
                <Minus className="size-3" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                className="bg-background"
                aria-label="Grow clip at the end"
                disabled={!canExpandEnd}
                onClick={(event) => {
                  event.stopPropagation();
                  onExpand("end");
                }}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
              >
                <Plus className="size-3" />
              </Button>
            </div>
          </>
        ) : null}
        {unavailable ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-background/50 px-3 text-center">
            <AudioLines className="size-4 text-muted-foreground" />
            <p className="text-[11px] text-muted-foreground">
              Waveform unavailable — the 16 kHz audio extract is not on disk.
            </p>
          </div>
        ) : error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-background/60 px-3 text-center">
            <AlertTriangle className="size-4 text-muted-foreground" />
            <p className="line-clamp-2 max-w-md text-[11px] text-muted-foreground">
              Could not load the waveform: {error}
            </p>
          </div>
        ) : !ready ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/40">
            <p className="text-[11px] text-muted-foreground">Loading waveform…</p>
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between text-[10px] tabular-nums text-muted-foreground">
        <span>{formatClock(clipStart)}</span>
        <span>{formatClock(clipEnd)}</span>
      </div>
    </div>
  );
}

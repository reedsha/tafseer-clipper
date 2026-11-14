import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, { type Region } from "wavesurfer.js/plugins/regions";
import { AlertTriangle, AudioLines, Maximize2, ScanSearch } from "lucide-react";

import { Button } from "@/components/ui/button";
import { clamp, formatClock } from "@/lib/format";

const REGION_ID = "step2-cut";

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
  duration: number;
  clipStart: number;
  clipEnd: number;
  /** Video playhead in seconds; moves the waveform cursor. */
  playhead: number;
  onSeek: (seconds: number) => void;
  onTrimCommit: (range: { start: number; end: number }) => void;
}

/**
 * wavesurfer.js waveform scrubber with a draggable trim region. Focus mode
 * zooms to the selected clip so 1–3 hour lectures remain editable; fit mode
 * shows the whole lecture.
 */
export function WaveformBar({
  audioUrl,
  peaks,
  duration,
  clipStart,
  clipEnd,
  playhead,
  onSeek,
  onTrimCommit,
}: WaveformBarProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null);
  const regionRef = useRef<Region | null>(null);
  const onSeekRef = useRef(onSeek);
  const onTrimRef = useRef(onTrimCommit);
  const playheadRef = useRef(playhead);
  const peaksRef = useRef(peaks);
  const durationRef = useRef(duration);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState(true);

  useEffect(() => {
    onSeekRef.current = onSeek;
  }, [onSeek]);

  useEffect(() => {
    onTrimRef.current = onTrimCommit;
  }, [onTrimCommit]);

  useEffect(() => {
    playheadRef.current = playhead;
  }, [playhead]);

  useEffect(() => {
    peaksRef.current = peaks;
  }, [peaks]);

  useEffect(() => {
    durationRef.current = duration;
  }, [duration]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const regions = RegionsPlugin.create();
    const initialPeaks = peaksRef.current;
    const knownDuration = durationRef.current;
    // Rendering from precomputed peaks avoids decoding the whole WAV extract
    // (a multi-hour 16 kHz PCM file can be hundreds of MB) in WebView2.
    const precomputedPeaks: number[][] | null =
      Array.isArray(initialPeaks) && initialPeaks.length > 0 && knownDuration > 0
        ? [initialPeaks]
        : null;
    const wavesurfer = WaveSurfer.create({
      container,
      height: 72,
      waveColor: cssVar("--border", "#262b2f"),
      progressColor: cssVar("--ring", "#707a82"),
      cursorColor: cssVar("--foreground", "#e7e9ea"),
      cursorWidth: 1,
      barWidth: 2,
      barGap: 1,
      barRadius: 1,
      normalize: true,
      interact: true,
      dragToSeek: false,
      hideScrollbar: true,
      fillParent: true,
      minPxPerSec: 0,
      sampleRate: 4000,
      plugins: [regions],
      ...(precomputedPeaks ? { peaks: precomputedPeaks, duration: knownDuration } : {}),
    });

    wavesurferRef.current = wavesurfer;
    regionsRef.current = regions;

    const disposers = [
      wavesurfer.on("ready", (durationSeconds) => {
        setReady(true);
        setError(null);
        wavesurfer.setMuted(true);
        wavesurfer.setTime(clamp(playheadRef.current, 0, durationSeconds));
      }),
      wavesurfer.on("error", (loadError) => {
        setReady(false);
        setError(loadError.message || "The audio extract could not be decoded.");
      }),
      wavesurfer.on("interaction", (seconds) => {
        onSeekRef.current(clamp(seconds, 0, wavesurfer.getDuration() || seconds));
      }),
      regions.on("region-updated", (region) => {
        if (region.id !== REGION_ID) return;
        onTrimRef.current({ start: region.start, end: region.end });
      }),
    ];

    return () => {
      disposers.forEach((dispose) => dispose());
      regionRef.current = null;
      regionsRef.current = null;
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
      wavesurfer.empty();
      return;
    }
    setReady(false);
    setError(null);
    const channelData =
      peaks && peaks.length > 0 && duration > 0 ? [peaks] : undefined;
    const knownDuration = channelData ? duration : undefined;
    void wavesurfer.load(audioUrl, channelData, knownDuration).catch((loadError: unknown) => {
      setReady(false);
      setError(
        loadError instanceof Error
          ? loadError.message
          : "The audio extract could not be loaded.",
      );
    });
  }, [audioUrl, peaks, duration]);

  useEffect(() => {
    const regions = regionsRef.current;
    if (!regions || !ready) return;

    if (duration <= 0 || clipEnd <= clipStart) {
      regionRef.current?.remove();
      regionRef.current = null;
      return;
    }

    const start = clamp(clipStart, 0, duration);
    const end = clamp(clipEnd, start, duration);
    const region = regionRef.current;

    if (region) {
      if (Math.abs(region.start - start) > 0.001 || Math.abs(region.end - end) > 0.001) {
        region.setOptions({ start, end });
      }
      return;
    }

    regionRef.current = regions.addRegion({
      id: REGION_ID,
      start,
      end,
      drag: true,
      resize: true,
      resizeStart: true,
      resizeEnd: true,
      minLength: 1,
      maxLength: duration,
      color: "color-mix(in oklab, var(--ring) 20%, transparent)",
      avoidOverlapping: false,
    });
  }, [ready, clipStart, clipEnd, duration]);

  useEffect(() => {
    const wavesurfer = wavesurferRef.current;
    if (!wavesurfer || !ready) return;
    if (!wavesurfer.getDuration()) return;

    if (!focus) {
      wavesurfer.zoom(0);
      return;
    }

    const width = wavesurfer.getWidth() || containerRef.current?.clientWidth || 640;
    const clipLength = Math.max(1, clipEnd - clipStart);
    const span = Math.max(30, clipLength * 2.5);
    const pxPerSec = Math.max(1, width / span);
    wavesurfer.zoom(pxPerSec);

    const frame = window.requestAnimationFrame(() => {
      wavesurfer.setScrollTime(Math.max(0, clipStart - clipLength * 0.35));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focus, ready, clipStart, clipEnd]);

  useEffect(() => {
    const wavesurfer = wavesurferRef.current;
    if (!wavesurfer || !ready) return;
    if (regionRef.current?.isDragging) return;
    wavesurfer.setTime(clamp(playhead, 0, duration));
  }, [playhead, ready, duration]);

  const unavailable = !audioUrl;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <AudioLines className="size-3.5 text-muted-foreground" />
          <span className="text-[11px] font-medium text-foreground/90">Waveform</span>
          <span className="hidden text-[10px] text-muted-foreground sm:inline">
            drag the shaded region to trim
          </span>
        </div>
        <Button
          variant="ghost"
          size="xs"
          className="gap-1 text-[10px] text-muted-foreground"
          onClick={() => setFocus((value) => !value)}
          aria-label={focus ? "Switch to fit lecture view" : "Switch to clip focus view"}
          aria-pressed={focus}
        >
          {focus ? <Maximize2 className="size-3" /> : <ScanSearch className="size-3" />}
          {focus ? "Fit lecture" : "Focus clip"}
        </Button>
      </div>

      <div className="relative overflow-hidden rounded-md border border-border bg-background/60">
        <div ref={containerRef} className="h-[72px] w-full" />
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
        <span>0:00</span>
        <span>{formatClock(duration)}</span>
      </div>
    </div>
  );
}

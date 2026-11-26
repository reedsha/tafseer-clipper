import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { ScanText } from "lucide-react";
import { cn } from "cn";

import { SubtitleOverlay } from "@/components/subtitles/SubtitleOverlay";
import { toMediaSrc } from "@/lib/media";
import type { FramingMode, Resolution, SubtitleCue } from "@/lib/projectTypes";
import { ASS_RESOLUTIONS, type AssStyle, type SubtitleLine } from "@/lib/subtitleStyles";

export interface SubtitleMonitorHandle {
  /** Play from `start` to `end` (absolute source seconds) and stop there. */
  playRange: (start: number, end: number) => void;
  pause: () => void;
  seekTo: (seconds: number) => void;
  seekBy: (delta: number) => void;
  getCurrentTime: () => number;
  getPlaybackRate: () => number;
  setPlaybackRate: (rate: number) => void;
}

export interface SubtitleMonitorProps {
  resolution: Resolution;
  framing: FramingMode;
  sourcePath: string | null;
  /** Absolute start of the selected clip in the source video (seconds). */
  clipStart: number;
  cues: SubtitleCue[];
  selectedCueId: string | null;
  styles: { arabic: AssStyle; thai: AssStyle };
  safeZone: boolean;
  muted?: boolean;
  onTimeUpdate?: (seconds: number) => void;
  onPlayingChange?: (playing: boolean) => void;
  onTogglePlay?: () => void;
  className?: string;
  /** Let the editor drag the caption lines, as in the style editor. */
  interactive?: boolean;
  offsets?: { arabic: number; thai: number };
  /** Delta is in export-frame pixels; positive moves the line up. */
  onNudgeLine?: (kind: SubtitleLine, deltaExportPx: number) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The subtitle line visible at `time` (clip-relative seconds), if any. */
function cueAt(cues: SubtitleCue[], time: number): SubtitleCue | null {
  return cues.find((cue) => time >= cue.start - 0.001 && time < cue.end) ?? null;
}

/**
 * The Step 3 output monitor: a real, playable video shown in the exact export
 * frame (portrait or widescreen) with the bilingual subtitle overlay on top.
 * The overlay reuses the `.ass` geometry from `subtitleStyles`, so what the
 * editor sees is what `/render-batch` burns in.
 */
export const SubtitleMonitor = forwardRef<SubtitleMonitorHandle, SubtitleMonitorProps>(
  function SubtitleMonitor(
    {
      resolution,
      framing,
      sourcePath,
      clipStart,
      cues,
      selectedCueId,
      styles,
      safeZone,
      muted = false,
      onTimeUpdate,
      onPlayingChange,
      onTogglePlay,
      className,
      interactive = false,
      offsets,
      onNudgeLine,
    },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement>(null);
    const foregroundRef = useRef<HTMLVideoElement>(null);
    const backdropCanvasRef = useRef<HTMLCanvasElement>(null);
    const lastBackdropDrawRef = useRef(0);
    const rangeEndRef = useRef<number | null>(null);
    const pendingRef = useRef<{ start: number; end: number } | null>(null);
    const rateRef = useRef(1);
    const onTimeUpdateRef = useRef(onTimeUpdate);
    const [box, setBox] = useState({ width: 280, height: 498 });
    const [playing, setPlaying] = useState(false);
    /** Video clock while playing, so the overlay follows the frame (rAF). */
    const [now, setNow] = useState(0);

    const play = ASS_RESOLUTIONS[resolution];
    const portrait = play.height > play.width;
    // Framing only changes the 9:16 canvas; a 16:9 export never letterboxes.
    const effectiveFraming: FramingMode = portrait ? framing : "center-crop";
    const mediaSrc = useMemo(() => toMediaSrc(sourcePath), [sourcePath]);

    const drawBackdrop = useCallback(() => {
      if (effectiveFraming !== "blur-fill") return;
      const video = foregroundRef.current;
      const canvas = backdropCanvasRef.current;
      if (!video || !canvas || video.readyState < 2) return;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (vw <= 0 || vh <= 0) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const cw = canvas.width;
      const ch = canvas.height;
      const scale = Math.max(cw / vw, ch / vh);
      const dw = vw * scale;
      const dh = vh * scale;
      ctx.drawImage(video, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
      lastBackdropDrawRef.current = performance.now();
    }, [effectiveFraming]);

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      const measure = () => {
        const availableWidth = host.clientWidth;
        const availableHeight = host.clientHeight;
        if (availableWidth <= 0 || availableHeight <= 0) return;
        const ratio = play.width / play.height;
        const width = Math.max(1, Math.min(availableWidth, availableHeight * ratio));
        setBox({ width, height: width / ratio });
      };
      const observer = new ResizeObserver(measure);
      observer.observe(host);
      measure();
      return () => observer.disconnect();
    }, [play.width, play.height]);

    const applyMediaState = useCallback(() => {
      const foreground = foregroundRef.current;
      if (foreground) {
        foreground.muted = muted;
        foreground.playbackRate = rateRef.current;
      }
    }, [muted]);

    useEffect(() => {
      applyMediaState();
    }, [applyMediaState]);

    useEffect(() => {
      drawBackdrop();
    }, [drawBackdrop]);

    useEffect(() => {
      onTimeUpdateRef.current = onTimeUpdate;
    }, [onTimeUpdate]);

    const seekTo = useCallback((seconds: number) => {
      const video = foregroundRef.current;
      if (!video || !Number.isFinite(seconds)) return;
      rangeEndRef.current = null;
      if (video.readyState < 1) {
        pendingRef.current = { start: seconds, end: seconds };
        return;
      }
      const upper = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : seconds;
      video.currentTime = clamp(seconds, 0, upper);
      onTimeUpdateRef.current?.(video.currentTime);
      setNow(video.currentTime);
    }, []);

    const pause = useCallback(() => {
      foregroundRef.current?.pause();
    }, []);

    const playRange = useCallback((start: number, end: number) => {
      const video = foregroundRef.current;
      if (!video || end - start <= 0) return;
      if (video.readyState < 2) {
        pendingRef.current = { start, end };
        return;
      }
      const outside = video.currentTime < start - 0.05 || video.currentTime >= end - 0.05;
      if (outside) {
        video.currentTime = start + 0.01;
      }
      rangeEndRef.current = end;
      void video.play().catch(() => {
        /* Autoplay may be blocked until the user interacts with the window. */
      });
    }, []);

    const seekBy = useCallback(
      (delta: number) => {
        const video = foregroundRef.current;
        if (!video) return;
        seekTo((Number.isFinite(video.currentTime) ? video.currentTime : 0) + delta);
      },
      [seekTo],
    );

    const getPlaybackRate = useCallback(() => rateRef.current, []);

    const setPlaybackRate = useCallback((rate: number) => {
      if (!Number.isFinite(rate)) return;
      const next = clamp(rate, 0.25, 4);
      rateRef.current = next;
      if (foregroundRef.current) {
        foregroundRef.current.playbackRate = next;
      }
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        playRange,
        pause,
        seekTo,
        seekBy,
        getCurrentTime: () => foregroundRef.current?.currentTime ?? 0,
        getPlaybackRate,
        setPlaybackRate,
      }),
      [getPlaybackRate, pause, playRange, seekBy, seekTo, setPlaybackRate],
    );

    /* Park a freshly opened clip on its first frame. */
    useEffect(() => {
      if (!mediaSrc) return;
      seekTo(clipStart + 0.05);
    }, [mediaSrc, clipStart, seekTo]);

    /* Follow the video clock while playing so the overlay changes on the frame
       it should, and refresh the blurred canvas backdrop at ~15 fps. */
    useEffect(() => {
      if (!playing) return;
      let frame = 0;
      let last = -1;
      const tick = () => {
        const video = foregroundRef.current;
        if (video) {
          const current = video.currentTime;
          if (Math.abs(current - last) >= 0.05) {
            last = current;
            setNow(current);
          }
          if (performance.now() - lastBackdropDrawRef.current >= 66) {
            drawBackdrop();
          }
        }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(frame);
    }, [drawBackdrop, playing]);

    function handleForegroundMetadata() {
      applyMediaState();
      const video = foregroundRef.current;
      if (!video) return;
      const pending = pendingRef.current;
      if (pending) {
        pendingRef.current = null;
        video.currentTime = pending.start + 0.01;
        if (pending.end - pending.start > 0) {
          rangeEndRef.current = pending.end;
          void video.play().catch(() => {});
        }
        drawBackdrop();
        return;
      }
      if (Number.isFinite(video.duration) && video.duration > 0) {
        video.currentTime = clamp(video.currentTime, 0, video.duration);
      }
      setNow(video.currentTime);
      drawBackdrop();
    }

    function handleTimeUpdate() {
      const video = foregroundRef.current;
      if (!video) return;
      onTimeUpdateRef.current?.(video.currentTime);
      setNow(video.currentTime);
      const end = rangeEndRef.current;
      if (!video.paused && end != null && video.currentTime >= end - 0.02) {
        rangeEndRef.current = null;
        video.pause();
      }
    }

    function handleSeeked() {
      handleTimeUpdate();
      drawBackdrop();
    }

    function handlePlay() {
      setPlaying(true);
      onPlayingChange?.(true);
    }

    function handlePause() {
      setPlaying(false);
      onPlayingChange?.(false);
    }

    /* ------------------------------ overlay ------------------------------ */

    const overlayCue = playing
      ? cueAt(cues, now - clipStart)
      : (cues.find((cue) => cue.id === selectedCueId) ?? null);

    return (
      <div
        ref={hostRef}
        className={cn("flex min-h-0 w-full flex-1 items-center justify-center", className)}
      >
        <div
          style={{ width: box.width, height: box.height }}
          className="relative shrink-0 overflow-hidden rounded-lg border border-border bg-black"
        >
          {mediaSrc ? (
            <>
              {effectiveFraming === "blur-fill" ? (
                <canvas
                  ref={backdropCanvasRef}
                  width={180}
                  height={320}
                  aria-hidden
                  className="pointer-events-none absolute inset-0 size-full scale-110 object-cover blur-2xl"
                />
              ) : null}
              <video
                key={mediaSrc}
                ref={foregroundRef}
                src={mediaSrc}
                playsInline
                preload="metadata"
                aria-label="Lecture preview"
                className={cn(
                  "absolute inset-0 size-full cursor-pointer",
                  effectiveFraming === "center-crop" ? "object-cover" : "object-contain",
                )}
                onClick={() => onTogglePlay?.()}
                onLoadedMetadata={handleForegroundMetadata}
                onLoadedData={drawBackdrop}
                onTimeUpdate={handleTimeUpdate}
                onSeeked={handleSeeked}
                onPlay={handlePlay}
                onPause={handlePause}
              />
            </>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-4 text-center">
              <ScanText className="size-4 text-muted-foreground/60" />
              <p className="max-w-[80%] text-xs leading-relaxed text-muted-foreground/60">
                The subtitles are placed exactly as they'll appear in the exported video. The video
                frame appears here in the desktop app.
              </p>
            </div>
          )}

          <SubtitleOverlay
            resolution={resolution}
            width={box.width}
            styles={styles}
            arabic={overlayCue?.arabic ?? ""}
            thai={overlayCue?.thai ?? ""}
            safeZone={safeZone}
            interactive={interactive}
            offsets={offsets}
            onNudgeLine={onNudgeLine}
          />

          {playing ? (
            <span
              aria-hidden
              className="pointer-events-none absolute left-2 top-2 size-1.5 rounded-full bg-foreground/70"
            />
          ) : null}
        </div>
      </div>
    );
  },
);

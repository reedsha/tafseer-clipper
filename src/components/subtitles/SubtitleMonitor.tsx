import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Heart, MessageCircle, ScanText, Send } from "lucide-react";
import { cn } from "cn";

import { toMediaSrc } from "@/lib/media";
import type { FramingMode, Resolution, SubtitleCue } from "@/lib/projectTypes";
import {
  ASS_RESOLUTIONS,
  previewLineMetrics,
  type AssStyle,
  type PreviewLineMetrics,
} from "@/lib/subtitleStyles";

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
    },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement>(null);
    const foregroundRef = useRef<HTMLVideoElement>(null);
    const backdropRef = useRef<HTMLVideoElement>(null);
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
      const backdrop = backdropRef.current;
      if (backdrop) {
        // The blurred copy is decorative: never let it add a second audio track.
        backdrop.muted = true;
        backdrop.playbackRate = rateRef.current;
      }
    }, [muted]);

    useEffect(() => {
      applyMediaState();
    }, [applyMediaState]);

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
      const backdrop = backdropRef.current;
      if (backdrop) {
        try {
          backdrop.currentTime = video.currentTime;
        } catch {
          /* The blurred copy may not be seekable yet. */
        }
      }
      onTimeUpdateRef.current?.(video.currentTime);
      setNow(video.currentTime);
    }, []);

    const pause = useCallback(() => {
      foregroundRef.current?.pause();
      backdropRef.current?.pause();
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
        const backdrop = backdropRef.current;
        if (backdrop) {
          try {
            backdrop.currentTime = video.currentTime;
          } catch {
            /* Not seekable yet. */
          }
        }
      }
      rangeEndRef.current = end;
      void video.play().catch(() => {
        /* Autoplay may be blocked until the user interacts with the window. */
      });
      void backdropRef.current?.play().catch(() => {});
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
      for (const element of [foregroundRef.current, backdropRef.current]) {
        if (element) element.playbackRate = next;
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
       it should, instead of waiting for the ~4 Hz `timeupdate` event. */
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
        }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(frame);
    }, [playing]);

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
          void backdropRef.current?.play().catch(() => {});
        }
        return;
      }
      if (Number.isFinite(video.duration) && video.duration > 0) {
        video.currentTime = clamp(video.currentTime, 0, video.duration);
      }
      setNow(video.currentTime);
    }

    function handleBackdropMetadata() {
      applyMediaState();
      const video = foregroundRef.current;
      const backdrop = backdropRef.current;
      if (!video || !backdrop) return;
      try {
        backdrop.currentTime = video.currentTime;
      } catch {
        /* Not seekable yet. */
      }
    }

    function handleTimeUpdate() {
      const video = foregroundRef.current;
      if (!video) return;
      const backdrop = backdropRef.current;
      if (backdrop && Math.abs(backdrop.currentTime - video.currentTime) > 0.4) {
        try {
          backdrop.currentTime = video.currentTime;
        } catch {
          /* Not seekable yet. */
        }
      }
      onTimeUpdateRef.current?.(video.currentTime);
      setNow(video.currentTime);
      const end = rangeEndRef.current;
      if (!video.paused && end != null && video.currentTime >= end - 0.02) {
        rangeEndRef.current = null;
        video.pause();
        backdrop?.pause();
      }
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
    const arabic = overlayCue?.arabic ?? "";
    const thai = overlayCue?.thai ?? "";

    const arabicMetrics = previewLineMetrics(styles.arabic, resolution, box.width);
    const thaiMetrics = previewLineMetrics(styles.thai, resolution, box.width);
    const scale = box.width / play.width;

    /** Outline ring in this line's *own* colour (Arabic and Thai can differ). */
    const textShadow = (outlinePx: number, color: string, shadowPx: number) => {
      const layers: string[] = [];
      if (outlinePx > 0) {
        layers.push(
          `-${outlinePx}px 0 0 ${color}`,
          `${outlinePx}px 0 0 ${color}`,
          `0 -${outlinePx}px 0 ${color}`,
          `0 ${outlinePx}px 0 ${color}`,
          `0 0 ${outlinePx * 1.5}px ${color}`,
        );
      }
      // `.ass` Shadow 1 is a hard drop shadow; mirror it so the preview matches.
      if (shadowPx > 0) layers.push(`${shadowPx}px ${shadowPx}px 0 rgba(0, 0, 0, 0.55)`);
      return layers.length ? layers.join(", ") : undefined;
    };

    const lineStyle = (
      metrics: PreviewLineMetrics,
      line: AssStyle,
      kind: "arabic" | "thai",
    ): CSSProperties => ({
      bottom: metrics.bottomPx,
      left: metrics.leftPx,
      right: metrics.rightPx,
      fontFamily:
        kind === "arabic"
          ? `'${line.font}', 'Noto Naskh Arabic', 'Traditional Arabic', serif`
          : `'${line.font}', 'Leelawadee UI', 'Tahoma', sans-serif`,
      fontSize: `${metrics.fontPx}px`,
      lineHeight: `${line.lineHeightPad}`,
      fontWeight: line.bold ? 700 : 400,
      color: line.primaryColor,
      textShadow: textShadow(metrics.outlinePx, line.outlineColor, line.shadow * scale),
    });

    /** BorderStyle 3: the `.ass` box is BackColour behind the text; mirror it. */
    const boxStyle = (line: AssStyle, metrics: PreviewLineMetrics) =>
      line.boxOpacity > 0
        ? {
            backgroundColor: `rgba(0, 0, 0, ${Math.min(1, Math.max(0, line.boxOpacity))})`,
            padding: `${metrics.outlinePx}px ${metrics.outlinePx * 2}px`,
            boxDecorationBreak: "clone" as const,
            WebkitBoxDecorationBreak: "clone" as const,
          }
        : undefined;

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
                <video
                  key={`${mediaSrc}-backdrop`}
                  ref={backdropRef}
                  src={mediaSrc}
                  aria-hidden
                  muted
                  playsInline
                  preload="metadata"
                  tabIndex={-1}
                  className="pointer-events-none absolute inset-0 size-full scale-110 object-cover blur-2xl"
                  onLoadedMetadata={handleBackdropMetadata}
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
                onTimeUpdate={handleTimeUpdate}
                onSeeked={handleTimeUpdate}
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

          {safeZone && portrait ? (
            <div className="pointer-events-none absolute inset-0" aria-hidden>
              {/* Platform UI: right-hand action rail and the caption block. */}
              <div className="absolute inset-y-0 right-0 w-[16%] border-l border-dashed border-foreground/25 bg-foreground/[0.04]">
                <div className="flex flex-col items-center gap-2 pt-[38%] text-foreground/30">
                  <Heart className="size-2.5" />
                  <MessageCircle className="size-2.5" />
                  <Send className="size-2.5" />
                </div>
              </div>
              <div className="absolute inset-x-0 bottom-0 h-[22%] border-t border-dashed border-foreground/25 bg-foreground/[0.04]" />
              <div className="absolute inset-x-[4%] inset-y-[6%] border border-dashed border-foreground/15" />
              <span className="absolute bottom-1 right-1.5 text-[8px] uppercase tracking-[0.14em] text-foreground/35">
                TikTok / Reels / Shorts safe zone
              </span>
            </div>
          ) : null}

          {arabic ? (
            <p
              dir="rtl"
              lang="ar"
              className="pointer-events-none absolute px-2 text-center whitespace-pre-line"
              style={lineStyle(arabicMetrics, styles.arabic, "arabic")}
            >
              <span style={boxStyle(styles.arabic, arabicMetrics)}>{arabic}</span>
            </p>
          ) : null}

          {thai ? (
            <p
              lang="th"
              className="pointer-events-none absolute px-2 text-center whitespace-pre-line"
              style={lineStyle(thaiMetrics, styles.thai, "thai")}
            >
              <span style={boxStyle(styles.thai, thaiMetrics)}>{thai}</span>
            </p>
          ) : null}

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

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { ScanText, VideoOff } from "lucide-react";
import { cn } from "cn";

import { InsertOverlayBox } from "@/components/subtitles/InsertOverlayBox";
import { SubtitleOverlay } from "@/components/subtitles/SubtitleOverlay";
import { Button } from "@/components/ui/button";
import { L } from "@/lib/i18n";
import {
  classifyMediaFailure,
  probeMediaSrc,
  toMediaSrc,
  type MediaFailureKind,
} from "@/lib/media";
import { mediaFailureMessage, relinkLecture } from "@/lib/sourceLink";
import { useProjectStore } from "@/store/projectStore";
import type {
  FramingMode,
  InsertRect,
  MediaInsert,
  Resolution,
  SubtitleCue,
} from "@/lib/projectTypes";
import { ASS_RESOLUTIONS, type AssStyle, type SubtitleLine } from "@/lib/subtitleStyles";

export interface SubtitleMonitorHandle {
  /** Play from `start` to `end` (absolute source seconds) and stop there. */
  playRange: (start: number, end: number, restart?: boolean) => void;
  /** Adjust or clear the active range end while playing (null = unrestricted). */
  setRangeEnd: (end: number | null) => void;
  pause: () => void;
  seekTo: (seconds: number) => void;
  seekBy: (delta: number, preserveRange?: boolean) => void;
  getPlaybackRate: () => number;
  setPlaybackRate: (rate: number) => void;
}

export interface SubtitleMonitorProps {
  resolution: Resolution;
  framing: FramingMode;
  sourcePath: string | null;
  /** Absolute start of the selected clip in the source video (seconds). */
  clipStart: number;
  /** Optional absolute end of the selected clip in the source video (seconds). */
  clipEnd?: number;
  cues: SubtitleCue[];
  selectedCueId: string | null;
  overlayMode?: "cue" | "playhead";
  playhead?: number;
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
  /** Visual inserts layered over the lecture and beneath subtitles. */
  inserts?: MediaInsert[];
  selectedInsertId?: string | null;
  onSelectInsert?: (id: string | null) => void;
  onCommitInsertRect?: (id: string, rect: InsertRect) => void;
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
      clipEnd,
      cues,
      selectedCueId,
      overlayMode = "cue",
      playhead,
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
      inserts = [],
      selectedInsertId = null,
      onSelectInsert,
      onCommitInsertRect,
    },
    ref,
  ) {
    const sourceStatus = useProjectStore((state) => state.sourceStatus);
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
    const [error, setError] = useState<{ kind: MediaFailureKind; message: string } | null>(
      null,
    );

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

    const playRange = useCallback((start: number, end: number, restart = false) => {
      const video = foregroundRef.current;
      if (!video || end - start <= 0) return;
      if (video.readyState < 2) {
        pendingRef.current = { start, end };
        return;
      }
      const inset = Math.min(0.01, Math.max(0, (end - start) * 0.1));
      const outside =
        restart || video.currentTime < start - 0.05 || video.currentTime >= end - 0.05;
      if (outside) {
        video.currentTime = start + inset;
      }
      rangeEndRef.current = end;
      void video.play().catch(() => {
        /* Autoplay may be blocked until the user interacts with the window. */
      });
    }, []);

    const setRangeEnd = useCallback((end: number | null) => {
      rangeEndRef.current = end;
      const video = foregroundRef.current;
      if (!video) return;
      if (pendingRef.current && end != null) {
        pendingRef.current = { ...pendingRef.current, end };
      }
      if (!video.paused && end != null && video.currentTime >= end - 0.02) {
        rangeEndRef.current = null;
        video.pause();
        onTimeUpdateRef.current?.(video.currentTime);
        setNow(video.currentTime);
      }
    }, []);

    const seekBy = useCallback(
      (delta: number, preserveRange = false) => {
        const video = foregroundRef.current;
        if (!video) return;
        const upper =
          clipEnd ??
          (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Infinity);
        const current = Number.isFinite(video.currentTime) ? video.currentTime : clipStart;
        const next = clamp(current + delta, clipStart, Math.max(clipStart, upper));
        if (preserveRange) {
          if (video.readyState < 1) {
            pendingRef.current = { start: next, end: rangeEndRef.current ?? next };
            return;
          }
          video.currentTime = next;
          onTimeUpdateRef.current?.(video.currentTime);
          setNow(video.currentTime);
          return;
        }
        seekTo(next);
      },
      [clipEnd, clipStart, seekTo],
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
        setRangeEnd,
        pause,
        seekTo,
        seekBy,
        getPlaybackRate,
        setPlaybackRate,
      }),
      [getPlaybackRate, pause, playRange, seekBy, seekTo, setPlaybackRate, setRangeEnd],
    );

    /* Park a freshly opened clip on its first frame. */
    useEffect(() => {
      if (!mediaSrc) return;
      seekTo(clipStart + 0.05);
    }, [mediaSrc, clipStart, seekTo]);

    /* A new source or confirmed re-link clears previous load failures. */
    useEffect(() => {
      setError(null);
    }, [mediaSrc]);

    useEffect(() => {
      if (sourceStatus === "ok") {
        setError((prev) =>
          prev && (prev.kind === "missing" || prev.kind === "forbidden") ? null : prev,
        );
      }
    }, [sourceStatus]);

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
          const end = rangeEndRef.current;
          if (!video.paused && end != null && current >= end - 0.02) {
            rangeEndRef.current = null;
            video.pause();
            onTimeUpdateRef.current?.(current);
            setNow(current);
          } else if (Math.abs(current - last) >= 0.016) {
            last = current;
            setNow(current);
            onTimeUpdateRef.current?.(current);
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

    const flushPending = useCallback(() => {
      const video = foregroundRef.current;
      const pending = pendingRef.current;
      if (!video || !pending) return false;
      if (pending.end - pending.start > 0 && video.readyState < 2) return false;
      pendingRef.current = null;
      const upper =
        clipEnd ??
        (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Infinity);
      const inset =
        pending.end > pending.start
          ? Math.min(0.01, Math.max(0, (pending.end - pending.start) * 0.1))
          : 0;
      const target = clamp(pending.start + inset, 0, Math.max(0, upper));
      video.currentTime = target;
      onTimeUpdateRef.current?.(target);
      setNow(target);
      if (pending.end - pending.start > 0) {
        rangeEndRef.current = pending.end;
        void video.play().catch(() => {});
      }
      drawBackdrop();
      return true;
    }, [clipEnd, drawBackdrop]);

    function handleForegroundMetadata() {
      applyMediaState();
      const video = foregroundRef.current;
      if (!video) return;
      if (flushPending()) return;
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

    const clipTime = playing ? now - clipStart : (playhead ?? now - clipStart);
    const overlayCue =
      playing || overlayMode === "playhead"
        ? cueAt(cues, clipTime)
        : (cues.find((cue) => cue.id === selectedCueId) ?? null);
    const activeInsert =
      inserts.find((item) => clipTime >= item.start - 0.001 && clipTime < item.end) ?? null;

    return (
      <div
        ref={hostRef}
        className={cn("flex min-h-0 w-full flex-1 items-center justify-center", className)}
      >
        <div
          style={{ width: box.width, height: box.height }}
          className="relative shrink-0 overflow-hidden rounded-lg border border-border bg-black"
          onClick={() => {
            if (selectedInsertId) onSelectInsert?.(null);
          }}
        >
          {mediaSrc && !error ? (
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
                onLoadedData={() => {
                  flushPending();
                  drawBackdrop();
                }}
                onTimeUpdate={handleTimeUpdate}
                onSeeked={handleSeeked}
                onPlay={handlePlay}
                onPause={handlePause}
                onError={() => {
                  const code = foregroundRef.current?.error?.code ?? null;
                  const target = mediaSrc;
                  void (async () => {
                    const probe = target
                      ? await probeMediaSrc(target)
                      : { ok: false, status: null, size: null };
                    const kind = classifyMediaFailure(code, probe);
                    setError({ kind, message: mediaFailureMessage(kind) });
                    if (kind === "missing" || kind === "forbidden") {
                      void useProjectStore.getState().refreshSourceStatus();
                    }
                  })();
                }}
              />
            </>
          ) : error ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
              <VideoOff className="size-4 text-muted-foreground/60" />
              <p className="max-w-[80%] text-xs leading-relaxed text-muted-foreground/60">
                {error.message}
              </p>
              {error.kind === "missing" || error.kind === "forbidden" ? (
                <Button variant="outline" size="xs" onClick={() => void relinkLecture()}>
                  {L("Re-link lecture")}
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-4 text-center">
              <ScanText className="size-4 text-muted-foreground/60" />
              <p className="max-w-[80%] text-xs leading-relaxed text-muted-foreground/60">
                The subtitles are placed exactly as they'll appear in the exported video. The video
                frame appears here in the desktop app.
              </p>
            </div>
          )}

          {activeInsert ? (
            <InsertOverlayBox
              insert={activeInsert}
              frameWidth={box.width}
              frameHeight={box.height}
              clipTime={clipTime}
              playing={playing}
              playbackRate={rateRef.current}
              interactive={interactive}
              selected={activeInsert.id === selectedInsertId}
              onSelect={(id) => onSelectInsert?.(id)}
              onCommitRect={onCommitInsertRect}
            />
          ) : null}

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

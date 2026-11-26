import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import NumberFlow from "@number-flow/react";
import {
  Pause,
  Play,
  SkipBack,
  SkipForward,
  VideoOff,
  Volume2,
  VolumeX,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { TimeFlow } from "@/components/TimeFlow";
import { clamp } from "@/lib/format";
import { L } from "@/lib/i18n";
import {
  classifyMediaFailure,
  probeMediaSrc,
  type MediaFailureKind,
} from "@/lib/media";
import { mediaFailureMessage, relinkLecture } from "@/lib/sourceLink";
import { useProjectStore } from "@/store/projectStore";

export interface VideoPlayerHandle {
  seekTo: (seconds: number) => void;
  seekBy: (delta: number) => void;
  playClip: () => void;
  pause: () => void;
  togglePlay: () => void;
  /** Current playback rate (1 = normal speed). */
  getPlaybackRate: () => number;
  /** Set the playback rate, clamped to the shuttle range 0.25..4. */
  setPlaybackRate: (rate: number) => void;
}

export interface VideoPlayerProps {
  src: string | null;
  clipStart: number;
  clipEnd: number;
  onTimeUpdate?: (seconds: number) => void;
  onPlayingChange?: (playing: boolean) => void;
}

/**
 * Precision-seek video preview for Step 2. The native `<video>` element is the
 * single playback source; the waveform only scrubs it.
 */
export const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(
  function VideoPlayer({ src, clipStart, clipEnd, onTimeUpdate, onPlayingChange }, ref) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const pendingSeekRef = useRef<number | null>(null);
    const pendingPlayRef = useRef(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [muted, setMuted] = useState(false);
    const [error, setError] = useState<{ kind: MediaFailureKind; message: string } | null>(
      null,
    );

    const seekTo = useCallback(
      (seconds: number) => {
        const video = videoRef.current;
        if (!video || !Number.isFinite(seconds)) return;
        const upper = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : seconds;
        const next = clamp(seconds, 0, upper);
        if (video.readyState < 1) {
          pendingSeekRef.current = next;
          setCurrentTime(next);
          return;
        }
        video.currentTime = next;
        setCurrentTime(next);
        onTimeUpdate?.(next);
      },
      [onTimeUpdate],
    );

    const pause = useCallback(() => {
      videoRef.current?.pause();
    }, []);

    const seekBy = useCallback(
      (delta: number) => {
        const video = videoRef.current;
        if (!video) return;
        const from = Number.isFinite(video.currentTime) ? video.currentTime : clipStart;
        seekTo(clamp(from + delta, clipStart, Math.max(clipStart, clipEnd)));
      },
      [clipEnd, clipStart, seekTo],
    );

    const playClip = useCallback(() => {
      const video = videoRef.current;
      if (!video) return;
      const outside = video.currentTime < clipStart || video.currentTime >= clipEnd - 0.05;
      if (outside) seekTo(clipStart);
      if (video.readyState < 2) {
        pendingPlayRef.current = true;
        return;
      }
      void video.play().catch(() => {
        /* Autoplay may be blocked until the user interacts with the window. */
      });
    }, [clipEnd, clipStart, seekTo]);

    const togglePlay = useCallback(() => {
      if (videoRef.current?.paused === false) pause();
      else playClip();
    }, [pause, playClip]);

    const getPlaybackRate = useCallback(
      () => videoRef.current?.playbackRate ?? 1,
      [],
    );

    const setPlaybackRate = useCallback((rate: number) => {
      const video = videoRef.current;
      if (!video || !Number.isFinite(rate)) return;
      video.playbackRate = clamp(rate, 0.25, 4);
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        seekTo,
        seekBy,
        playClip,
        pause,
        togglePlay,
        getPlaybackRate,
        setPlaybackRate,
      }),
      [getPlaybackRate, pause, playClip, seekBy, seekTo, setPlaybackRate, togglePlay],
    );

    useEffect(() => {
      setError(null);
      setCurrentTime(0);
      pendingSeekRef.current = clipStart;
      pendingPlayRef.current = false;
      // A new source always starts at normal speed; the shuttle re-applies.
      if (videoRef.current) videoRef.current.playbackRate = 1;
    }, [src]);

    function handleLoadedMetadata() {
      const video = videoRef.current;
      if (!video) return;
      if (pendingSeekRef.current != null) {
        const target = pendingSeekRef.current;
        pendingSeekRef.current = null;
        video.currentTime = clamp(
          target,
          0,
          Number.isFinite(video.duration) ? video.duration : target,
        );
        setCurrentTime(video.currentTime);
        onTimeUpdate?.(video.currentTime);
      }
      if (pendingPlayRef.current) {
        pendingPlayRef.current = false;
        void video.play().catch(() => {});
      }
    }

    function handleTimeUpdate() {
      const video = videoRef.current;
      if (!video) return;
      const time = video.currentTime;
      setCurrentTime(time);
      onTimeUpdate?.(time);
      if (!video.paused && clipEnd > clipStart && time >= clipEnd - 0.03) {
        video.pause();
        video.currentTime = clipEnd;
        setCurrentTime(clipEnd);
        onTimeUpdate?.(clipEnd);
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

    function toggleMute() {
      const video = videoRef.current;
      if (!video) return;
      video.muted = !video.muted;
      setMuted(video.muted);
    }

    const clipDuration = Math.max(0, clipEnd - clipStart);
    const showVideo = Boolean(src) && !error;

    return (
      <div className="flex h-full min-h-0 flex-col bg-black">
        <div className="relative min-h-0 flex-1">
          {showVideo ? (
            <video
              ref={videoRef}
              src={src ?? undefined}
              preload="metadata"
              playsInline
              className="absolute inset-0 h-full w-full object-contain"
              onClick={togglePlay}
              onLoadedMetadata={handleLoadedMetadata}
              onTimeUpdate={handleTimeUpdate}
              onSeeked={handleTimeUpdate}
              onPlay={handlePlay}
              onPause={handlePause}
              onError={() => {
                const code = videoRef.current?.error?.code ?? null;
                const target = src;
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
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <VideoOff className="size-5 text-muted-foreground" />
              <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
                {error
                  ? error.message
                  : src
                    ? "Preparing the video preview…"
                    : "Video preview unavailable outside the desktop shell."}
              </p>
              {error && (error.kind === "missing" || error.kind === "forbidden") ? (
                <Button variant="outline" size="xs" onClick={() => void relinkLecture()}>
                  {L("Re-link lecture")}
                </Button>
              ) : null}
              {!src ? (
                <p className="max-w-sm text-[11px] leading-relaxed text-muted-foreground/70">
                  The lecture is opened through Tauri's asset protocol. The waveform and trim
                  controls keep working without it.
                </p>
              ) : null}
            </div>
          )}
        </div>

        {showVideo ? (
          <div className="flex h-10 shrink-0 items-center gap-1 border-t border-border bg-card/60 px-2">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={playing ? "Pause" : "Play"}
              onClick={togglePlay}
            >
              {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Back 5 seconds"
              onClick={() => seekBy(-5)}
            >
              <SkipBack className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Forward 5 seconds"
              onClick={() => seekBy(5)}
            >
              <SkipForward className="size-3.5" />
            </Button>

            <span className="ml-1 text-[11px] tabular-nums text-muted-foreground">
              <TimeFlow value={currentTime} />
            </span>
            <span className="text-[10px] text-muted-foreground/60">/</span>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              <TimeFlow value={clipEnd} />
            </span>
            <span className="ml-1 hidden text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70 sm:inline">
              cut end
            </span>

            <div className="ml-auto flex items-center gap-1.5">
              <span className="text-[10px] tabular-nums text-muted-foreground">
                <NumberFlow
                  value={clipDuration}
                  suffix="s"
                  format={{ maximumFractionDigits: 1 }}
                />
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={muted ? "Unmute" : "Mute"}
                onClick={toggleMute}
              >
                {muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    );
  },
);

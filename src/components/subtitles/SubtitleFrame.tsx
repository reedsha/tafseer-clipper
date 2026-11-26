import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "cn";

import { SubtitleOverlay } from "@/components/subtitles/SubtitleOverlay";
import { toMediaSrc } from "@/lib/media";
import type { FramingMode, Resolution } from "@/lib/projectTypes";
import { ASS_RESOLUTIONS, type AssStyle, type SubtitleLine } from "@/lib/subtitleStyles";

export interface SubtitleFrameProps {
  resolution: Resolution;
  framing?: FramingMode;
  styles: { arabic: AssStyle; thai: AssStyle };
  arabic: string;
  thai: string;
  className?: string;
  /** Optional paused clip frame instead of the black typography grid. */
  video?: { sourcePath: string; clipStart: number } | null;
  interactive?: boolean;
  offsets?: { arabic: number; thai: number };
  onNudgeLine?: (kind: SubtitleLine, deltaExportPx: number) => void;
}

/**
 * A typography frame: no video, nothing to play. It shows the export aspect as
 * a ratio grid (rule-of-thirds guides plus the frame size) with the sample
 * line drawn at `.ass` geometry, so the style can be judged while the settings
 * that shape it scroll past. With `video`, the same frame shows a paused frame
 * of the selected Step 3 clip behind the lines — a view-only option.
 */
export function SubtitleFrame({
  resolution,
  framing = "blur-fill",
  styles,
  arabic,
  thai,
  className,
  video,
  interactive = false,
  offsets,
  onNudgeLine,
}: SubtitleFrameProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const play = ASS_RESOLUTIONS[resolution];
  const [box, setBox] = useState({ width: 200, height: 356 });
  const mediaSrc = useMemo(() => toMediaSrc(video?.sourcePath), [video?.sourcePath]);

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

  useEffect(() => {
    const element = videoRef.current;
    if (!element || !mediaSrc || element.readyState < 1) return;
    const duration = Number.isFinite(element.duration) ? element.duration : Infinity;
    element.currentTime = Math.min(
      Math.max(0, (video?.clipStart ?? 0) + 0.05),
      Math.max(0, duration - 0.05),
    );
  }, [mediaSrc, video?.clipStart]);

  const portrait = play.height > play.width;

  return (
    <div
      ref={hostRef}
      className={cn("flex min-h-0 w-full items-center justify-center", className)}
    >
      <div
        style={{ width: box.width, height: box.height }}
        className="relative shrink-0 overflow-hidden rounded-lg border border-border bg-black"
      >
        {mediaSrc ? (
          <video
            key={mediaSrc}
            ref={videoRef}
            src={mediaSrc}
            muted
            playsInline
            preload="metadata"
            aria-label="Selected clip frame"
            className={cn(
              "absolute inset-0 size-full",
              portrait && framing === "blur-fill" ? "object-contain" : "object-cover",
            )}
            onLoadedMetadata={() => {
              const element = videoRef.current;
              if (!element) return;
              const duration = Number.isFinite(element.duration) ? element.duration : Infinity;
              element.currentTime = Math.min(
                Math.max(0, (video?.clipStart ?? 0) + 0.05),
                Math.max(0, duration - 0.05),
              );
            }}
          />
        ) : (
          <div className="pointer-events-none absolute inset-0" aria-hidden>
            <div className="absolute inset-y-0 left-1/3 border-l border-dashed border-foreground/10" />
            <div className="absolute inset-y-0 left-2/3 border-l border-dashed border-foreground/10" />
            <div className="absolute inset-x-0 top-1/3 border-t border-dashed border-foreground/10" />
            <div className="absolute inset-x-0 top-2/3 border-t border-dashed border-foreground/10" />
            <span className="absolute top-1 left-1.5 text-[9px] uppercase tracking-[0.14em] text-foreground/35">
              {portrait ? "9:16" : "16:9"} · {play.width} × {play.height}
            </span>
          </div>
        )}

        <SubtitleOverlay
          resolution={resolution}
          width={box.width}
          styles={styles}
          arabic={arabic}
          thai={thai}
          interactive={interactive}
          offsets={offsets}
          onNudgeLine={onNudgeLine}
        />
      </div>
    </div>
  );
}

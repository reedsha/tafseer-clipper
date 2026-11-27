import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "cn";

import { CueRibbon } from "@/components/subtitles/CueRibbon";
import { InsertRibbon } from "@/components/subtitles/InsertRibbon";
import type { MediaInsert, SubtitleCue } from "@/lib/projectTypes";
import { clamp } from "@/lib/subtitleTiming";

const DEFAULT_VIEWPORT_PX = 336;
export const TIMELINE_MAX_ZOOM = 16;

export interface TimelineTracksProps {
  cues: SubtitleCue[];
  inserts: MediaInsert[];
  duration: number;
  selectedCueId: string | null;
  playingCueId?: string | null;
  selectedInsertId: string | null;
  playhead: number;
  zoom: number;
  missingInsertIds?: ReadonlySet<string>;
  insertDragOver?: boolean;
  onZoomChange: (nextZoom: number) => void;
  onSelectCue: (id: string) => void;
  onSelectCueOnly?: (id: string) => void;
  onSelectInsert: (id: string | null) => void;
  onSeek: (seconds: number) => void;
  onScrubEdge?: (seconds: number) => void;
  onChangeCueTime: (id: string, start: number, end: number) => void;
  onChangeCuePair?: (
    leftId: string,
    leftEnd: number,
    rightId: string,
    rightStart: number,
  ) => void;
  onChangeInsert: (
    id: string,
    patch: Pick<MediaInsert, "start" | "end" | "sourceStart">,
  ) => void;
  onDropInsertFiles?: (files: FileList) => void;
  className?: string;
}

/**
 * Shared zoomable horizontal timeline hosting both `CueRibbon` (top) and
 * `InsertRibbon` (bottom) with one continuous playhead line and cursor-anchored
 * mouse-wheel zoom restricted strictly to this timeline viewport.
 */
export function TimelineTracks({
  cues,
  inserts,
  duration,
  selectedCueId,
  playingCueId = null,
  selectedInsertId,
  playhead,
  zoom,
  missingInsertIds,
  insertDragOver = false,
  onZoomChange,
  onSelectCue,
  onSelectCueOnly,
  onSelectInsert,
  onSeek,
  onScrubEdge,
  onChangeCueTime,
  onChangeCuePair,
  onChangeInsert,
  onDropInsertFiles,
  className,
}: TimelineTracksProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(zoom);
  const durationRef = useRef(duration);
  const viewportWidthRef = useRef(DEFAULT_VIEWPORT_PX);
  const onZoomChangeRef = useRef(onZoomChange);
  const pendingAnchorRef = useRef<{ anchorTime: number; pointerOffsetX: number } | null>(null);
  const prevSelectedCueRef = useRef<string | null>(selectedCueId);

  const [viewportWidth, setViewportWidth] = useState(DEFAULT_VIEWPORT_PX);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    durationRef.current = duration;
  }, [duration]);

  useEffect(() => {
    onZoomChangeRef.current = onZoomChange;
  }, [onZoomChange]);

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const measure = () => {
      if (viewport.clientWidth > 0) {
        viewportWidthRef.current = viewport.clientWidth;
        setViewportWidth(viewport.clientWidth);
      }
    };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    measure();
    return () => observer.disconnect();
  }, []);

  // Cursor-anchored mouse-wheel zoom, active ONLY while pointer hovers this area.
  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;

    const handleWheel = (event: WheelEvent) => {
      const dur = durationRef.current;
      if (dur <= 0) return;

      // Shift + wheel or horizontal trackpad swipe pans horizontally when zoomed.
      if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        if (event.shiftKey && Math.abs(event.deltaY) > 0 && zoomRef.current > 1) {
          event.preventDefault();
          viewport.scrollLeft += event.deltaY;
        }
        return;
      }

      if (Math.abs(event.deltaY) < 0.01) return;
      event.preventDefault();
      event.stopPropagation();

      const rect = viewport.getBoundingClientRect();
      const vw = Math.max(1, viewport.clientWidth || viewportWidthRef.current);
      const pointerOffsetX = clamp(event.clientX - rect.left, 0, vw);
      const currentZoom = zoomRef.current;
      const currentTrackWidth = Math.max(1, vw * currentZoom);
      const anchorTime = clamp(
        ((viewport.scrollLeft + pointerOffsetX) / currentTrackWidth) * dur,
        0,
        dur,
      );

      const factor = Math.pow(1.0025, -event.deltaY);
      const rawNext = currentZoom * factor;
      const nextZoom =
        rawNext <= 1.02 ? 1 : clamp(Math.round(rawNext * 100) / 100, 1, TIMELINE_MAX_ZOOM);

      if (Math.abs(nextZoom - currentZoom) < 0.001) return;
      pendingAnchorRef.current = { anchorTime, pointerOffsetX };
      onZoomChangeRef.current(nextZoom);
    };

    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, []);

  // Keep the cursor-anchored timestamp aligned after zoom changes.
  useLayoutEffect(() => {
    const anchor = pendingAnchorRef.current;
    const viewport = scrollRef.current;
    if (!anchor || !viewport || duration <= 0) return;
    pendingAnchorRef.current = null;
    const vw = Math.max(1, viewport.clientWidth || viewportWidth);
    const nextTrackWidth = vw * zoom;
    const targetScrollLeft = (anchor.anchorTime / duration) * nextTrackWidth - anchor.pointerOffsetX;
    viewport.scrollLeft = clamp(targetScrollLeft, 0, Math.max(0, nextTrackWidth - vw));
  }, [duration, viewportWidth, zoom]);

  // Keep newly selected cue visible inside the zoomed viewport (skip pure zoom updates).
  useEffect(() => {
    if (prevSelectedCueRef.current === selectedCueId) return;
    prevSelectedCueRef.current = selectedCueId;
    if (zoom <= 1 || !selectedCueId || duration <= 0) return;
    const viewport = scrollRef.current;
    if (!viewport || viewport.clientWidth <= 0) return;
    const cue = cues.find((item) => item.id === selectedCueId);
    if (!cue) return;
    const width = viewport.clientWidth * zoom;
    const startPx = (cue.start / duration) * width;
    const endPx = (cue.end / duration) * width;
    const viewStart = viewport.scrollLeft;
    const viewEnd = viewStart + viewport.clientWidth;
    if (startPx < viewStart + 12 || endPx > viewEnd - 12) {
      const center = (startPx + endPx) * 0.5;
      viewport.scrollLeft = clamp(
        center - viewport.clientWidth * 0.5,
        0,
        Math.max(0, width - viewport.clientWidth),
      );
    }
  }, [cues, duration, selectedCueId, zoom]);

  const safeDuration = duration > 0 ? duration : 1;
  const trackWidth = Math.max(1, viewportWidth * zoom);

  return (
    <div
      ref={scrollRef}
      data-timeline-tracks
      className={cn(
        "min-h-0 w-full flex-1",
        zoom > 1 ? "overflow-x-auto overflow-y-hidden pb-1" : "overflow-hidden",
        className,
      )}
    >
      <div
        className="relative flex h-full min-h-[60px] flex-col gap-1"
        style={zoom > 1 ? { width: `${trackWidth}px` } : undefined}
      >
        <div className="flex min-h-[30px] flex-[1.15] flex-col">
          <CueRibbon
            cues={cues}
            duration={duration}
            selectedId={selectedCueId}
            playingCueId={playingCueId}
            playhead={playhead}
            zoom={zoom}
            externalScroll
            trackWidth={trackWidth}
            hidePlayhead
            onSelect={onSelectCue}
            onSelectOnly={onSelectCueOnly}
            onSeek={onSeek}
            onScrubEdge={onScrubEdge}
            onChangeTime={onChangeCueTime}
            onChangePair={onChangeCuePair}
          />
        </div>

        <div className="flex min-h-[26px] flex-1 flex-col">
          <InsertRibbon
            inserts={inserts}
            cues={cues}
            duration={duration}
            selectedId={selectedInsertId}
            playhead={playhead}
            zoom={zoom}
            trackWidth={trackWidth}
            missingIds={missingInsertIds}
            dragOver={insertDragOver}
            onSelect={onSelectInsert}
            onSeek={onSeek}
            onScrubEdge={onScrubEdge}
            onChangeInsert={onChangeInsert}
            onDropFiles={onDropInsertFiles}
          />
        </div>

        {duration > 0 ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 z-30 w-px bg-foreground/80"
            style={{
              left:
                zoom === 1
                  ? `${(clamp(playhead, 0, duration) / duration) * 100}%`
                  : `${(clamp(playhead, 0, duration) / safeDuration) * trackWidth}px`,
            }}
          >
            <span className="absolute -left-[3px] top-0 h-1.5 w-[7px] rounded-b-[2px] bg-foreground" />
          </span>
        ) : null}
      </div>
    </div>
  );
}

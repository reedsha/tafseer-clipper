import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { cn } from "cn";

import { formatClock } from "@/lib/format";
import type { SubtitleCue } from "@/lib/projectTypes";
import {
  clamp,
  MIN_CUE_SECONDS,
  NEIGHBOUR_GAP,
  roundTime,
} from "@/lib/subtitleTiming";

export const CUE_RIBBON_ZOOM_LEVELS = [1, 2, 4, 8, 16] as const;
export type CueRibbonZoom = number;
const DEFAULT_VIEWPORT_PX = 336;
const SEAM_TOLERANCE = NEIGHBOUR_GAP + 0.015;

type CueDragMode = "move" | "start" | "end";

type DragState =
  | {
      kind: "cue";
      id: string;
      mode: CueDragMode;
      startX: number;
      width: number;
      originStart: number;
      originEnd: number;
      draftStart: number;
      draftEnd: number;
      lowerBound: number;
      upperBound: number;
    }
  | {
      kind: "seam";
      leftId: string;
      rightId: string;
      startX: number;
      width: number;
      originLeftEnd: number;
      originRightStart: number;
      draftLeftEnd: number;
      draftRightStart: number;
      lowerBound: number;
      upperBound: number;
    };

export interface CueRibbonProps {
  cues: SubtitleCue[];
  /** Clip duration in seconds (cues are clip-relative). */
  duration: number;
  selectedId: string | null;
  /** Cue currently speaking during playback (highlighted subtly alongside selection). */
  playingCueId?: string | null;
  /** Clip-relative playhead in seconds. */
  playhead: number;
  /** Controlled horizontal zoom factor for the track. */
  zoom?: number;
  /** When hosted inside `TimelineTracks`, skip own scroll wrapper & use shared track width. */
  externalScroll?: boolean;
  trackWidth?: number;
  hidePlayhead?: boolean;
  className?: string;
  onSelect: (id: string) => void;
  /** Select a block without jumping the playhead to `cue.start` (used on edge drags). */
  onSelectOnly?: (id: string) => void;
  onSeek: (seconds: number) => void;
  /** Live-scrub preview while dragging an edge or shared cut seam. */
  onScrubEdge?: (seconds: number) => void;
  onChangeTime: (id: string, start: number, end: number) => void;
  /** Atomically shift the cut seam between two adjacent lines. */
  onChangePair?: (
    leftId: string,
    leftEnd: number,
    rightId: string,
    rightStart: number,
  ) => void;
}

/**
 * The subtitle track under the monitor: one block per line, sized by duration,
 * with a top scrub ruler, non-overlapping cut gutters, and rolling seam
 * handles between adjacent lines.
 */
export function CueRibbon({
  cues,
  duration,
  selectedId,
  playingCueId = null,
  playhead,
  zoom = 1,
  externalScroll = false,
  trackWidth: externalTrackWidth,
  hidePlayhead = false,
  className,
  onSelect,
  onSelectOnly,
  onSeek,
  onScrubEdge,
  onChangeTime,
  onChangePair,
}: CueRibbonProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const scrubbingRef = useRef(false);
  const changeRef = useRef(onChangeTime);
  const changePairRef = useRef(onChangePair);
  const seekRef = useRef(onSeek);
  const scrubRef = useRef(onScrubEdge);

  const [drag, setDrag] = useState<DragState | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(DEFAULT_VIEWPORT_PX);

  useEffect(() => {
    changeRef.current = onChangeTime;
  }, [onChangeTime]);

  useEffect(() => {
    changePairRef.current = onChangePair;
  }, [onChangePair]);

  useEffect(() => {
    seekRef.current = onSeek;
  }, [onSeek]);

  useEffect(() => {
    scrubRef.current = onScrubEdge;
  }, [onScrubEdge]);

  useEffect(() => {
    if (externalScroll) return;
    const viewport = scrollRef.current;
    if (!viewport) return;
    const measure = () => {
      if (viewport.clientWidth > 0) setViewportWidth(viewport.clientWidth);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    measure();
    return () => observer.disconnect();
  }, [externalScroll]);

  const dragging = drag !== null;

  useEffect(() => {
    if (!dragging) return;
    const handleMove = (event: PointerEvent) => {
      const state = dragRef.current;
      if (!state || state.width <= 0) return;
      const delta = ((event.clientX - state.startX) / state.width) * duration;

      if (state.kind === "seam") {
        const leftEnd = clamp(
          state.originLeftEnd + delta,
          state.lowerBound,
          state.upperBound,
        );
        const rightStart = leftEnd + NEIGHBOUR_GAP;
        const next: DragState = {
          ...state,
          draftLeftEnd: clamp(leftEnd, 0, Math.max(0, duration)),
          draftRightStart: clamp(rightStart, 0, Math.max(0, duration)),
        };
        dragRef.current = next;
        setDrag(next);
        scrubRef.current?.(next.draftLeftEnd);
        return;
      }

      let start = state.originStart;
      let end = state.originEnd;
      if (state.mode === "move") {
        const lowest = state.lowerBound - state.originStart;
        const highest = state.upperBound - state.originEnd;
        const shift = lowest <= highest ? clamp(delta, lowest, highest) : 0;
        start += shift;
        end += shift;
      } else if (state.mode === "start") {
        const lowest = state.lowerBound;
        const highest = state.originEnd - MIN_CUE_SECONDS;
        start =
          lowest <= highest
            ? clamp(state.originStart + delta, lowest, highest)
            : state.originStart;
      } else {
        const lowest = state.originStart + MIN_CUE_SECONDS;
        const highest = state.upperBound;
        end =
          lowest <= highest
            ? clamp(state.originEnd + delta, lowest, highest)
            : state.originEnd;
      }

      const next: DragState = {
        ...state,
        draftStart: clamp(start, 0, Math.max(0, duration)),
        draftEnd: clamp(end, 0, Math.max(0, duration)),
      };
      dragRef.current = next;
      setDrag(next);

      if (state.mode === "start") scrubRef.current?.(next.draftStart);
      else if (state.mode === "end") scrubRef.current?.(next.draftEnd);
      else scrubRef.current?.(next.draftStart);
    };

    const handleUp = () => {
      const state = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!state) return;

      if (state.kind === "seam") {
        const leftEnd = roundTime(state.draftLeftEnd);
        const rightStart = roundTime(leftEnd + NEIGHBOUR_GAP);
        if (
          Math.abs(leftEnd - state.originLeftEnd) > 0.001 ||
          Math.abs(rightStart - state.originRightStart) > 0.001
        ) {
          if (changePairRef.current) {
            changePairRef.current(state.leftId, leftEnd, state.rightId, rightStart);
          }
        }
        return;
      }

      const start = roundTime(state.draftStart);
      const end = roundTime(state.draftEnd);
      if (
        Math.abs(start - state.originStart) > 0.001 ||
        Math.abs(end - state.originEnd) > 0.001
      ) {
        changeRef.current(state.id, start, end);
      }
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
  }, [dragging, duration]);

  useEffect(() => {
    if (!scrubbing) return;
    const seekAtClientX = (clientX: number) => {
      const rail = railRef.current;
      if (!rail || duration <= 0) return;
      const rect = rail.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
      seekRef.current(roundTime(ratio * duration));
    };
    const handleMove = (event: PointerEvent) => {
      if (!scrubbingRef.current) return;
      seekAtClientX(event.clientX);
    };
    const handleUp = () => {
      scrubbingRef.current = false;
      setScrubbing(false);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
  }, [scrubbing, duration]);

  const ordered = useMemo(
    () => [...cues].sort((a, b) => a.start - b.start || a.end - b.end),
    [cues],
  );

  // Keep the selected block visible inside the zoomed track viewport when standalone.
  useEffect(() => {
    if (externalScroll || zoom <= 1 || !selectedId || duration <= 0) return;
    const viewport = scrollRef.current;
    if (!viewport || viewport.clientWidth <= 0) return;
    const cue = ordered.find((item) => item.id === selectedId);
    if (!cue) return;
    const trackWidth = viewport.clientWidth * zoom;
    const cueStartPx = (cue.start / duration) * trackWidth;
    const cueEndPx = (cue.end / duration) * trackWidth;
    const viewStart = viewport.scrollLeft;
    const viewEnd = viewStart + viewport.clientWidth;
    if (cueStartPx < viewStart + 12 || cueEndPx > viewEnd - 12) {
      const center = (cueStartPx + cueEndPx) * 0.5;
      viewport.scrollLeft = clamp(
        center - viewport.clientWidth * 0.5,
        0,
        Math.max(0, trackWidth - viewport.clientWidth),
      );
    }
  }, [duration, externalScroll, ordered, selectedId, zoom]);

  function beginDrag(event: ReactPointerEvent, cue: SubtitleCue, mode: CueDragMode) {
    if (!railRef.current || duration <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = railRef.current.getBoundingClientRect();
    if (rect.width <= 0) return;
    const index = ordered.findIndex((item) => item.id === cue.id);
    const previous = index > 0 ? ordered[index - 1] : null;
    const next = index >= 0 ? ordered[index + 1] : null;
    const state: DragState = {
      kind: "cue",
      id: cue.id,
      mode,
      startX: event.clientX,
      width: rect.width,
      originStart: cue.start,
      originEnd: cue.end,
      draftStart: cue.start,
      draftEnd: cue.end,
      lowerBound: previous ? previous.end + NEIGHBOUR_GAP : 0,
      upperBound: next ? next.start - NEIGHBOUR_GAP : duration,
    };
    dragRef.current = state;
    setDrag(state);
    if (mode === "move") {
      onSelect(cue.id);
    } else if (onSelectOnly) {
      onSelectOnly(cue.id);
    } else {
      onSelect(cue.id);
    }
  }

  function beginSeamDrag(
    event: ReactPointerEvent,
    leftCue: SubtitleCue,
    rightCue: SubtitleCue,
  ) {
    if (!railRef.current || duration <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = railRef.current.getBoundingClientRect();
    if (rect.width <= 0) return;
    const lowerBound = leftCue.start + MIN_CUE_SECONDS;
    const upperBound = rightCue.end - MIN_CUE_SECONDS - NEIGHBOUR_GAP;
    if (lowerBound > upperBound) return;
    const state: DragState = {
      kind: "seam",
      leftId: leftCue.id,
      rightId: rightCue.id,
      startX: event.clientX,
      width: rect.width,
      originLeftEnd: leftCue.end,
      originRightStart: rightCue.start,
      draftLeftEnd: leftCue.end,
      draftRightStart: rightCue.start,
      lowerBound,
      upperBound,
    };
    dragRef.current = state;
    setDrag(state);
    if (onSelectOnly) onSelectOnly(rightCue.id);
    else onSelect(rightCue.id);
  }

  function beginScrub(event: ReactPointerEvent<HTMLDivElement>) {
    if (duration <= 0 || !railRef.current) return;
    event.stopPropagation();
    const rect = railRef.current.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    onSeek(roundTime(ratio * duration));
    scrubbingRef.current = true;
    setScrubbing(true);
  }

  const safeDuration = duration > 0 ? duration : 1;
  const trackWidth = Math.max(1, externalTrackWidth ?? viewportWidth * zoom);

  const layout = useMemo(() => {
    const resolved = ordered.map((cue) => {
      let start = cue.start;
      let end = cue.end;
      if (drag?.kind === "cue" && drag.id === cue.id) {
        start = drag.draftStart;
        end = drag.draftEnd;
      } else if (drag?.kind === "seam") {
        if (drag.leftId === cue.id) end = drag.draftLeftEnd;
        else if (drag.rightId === cue.id) start = drag.draftRightStart;
      }
      return { cue, start, end };
    });

    return resolved.map((entry, index) => {
      const rawStartPx = (entry.start / safeDuration) * trackWidth;
      const rawEndPx = (entry.end / safeDuration) * trackWidth;
      const rawWidthPx = Math.max(0, rawEndPx - rawStartPx);

      const prev = index > 0 ? resolved[index - 1] : null;
      const next = index + 1 < resolved.length ? resolved[index + 1] : null;
      const prevEndPx = prev ? (prev.end / safeDuration) * trackWidth : 0;
      const nextStartPx = next ? (next.start / safeDuration) * trackWidth : trackWidth;

      let leftPx = rawStartPx;
      let rightPx = rawEndPx;

      if (prev && rawStartPx - prevEndPx < 2) {
        const seamPx = (prevEndPx + rawStartPx) * 0.5;
        const inset = rawWidthPx >= 4 ? 1 : 0.5;
        leftPx = Math.max(rawStartPx, seamPx + inset);
      }
      if (next && nextStartPx - rawEndPx < 2) {
        const seamPx = (rawEndPx + nextStartPx) * 0.5;
        const inset = rawWidthPx >= 4 ? 1 : 0.5;
        rightPx = Math.min(rawEndPx, seamPx - inset);
      }

      const maxAllowedRight = next ? Math.max(leftPx + 1.5, nextStartPx - 1) : trackWidth;
      const widthPx = Math.min(
        Math.max(2, rightPx - leftPx),
        Math.max(1.5, maxAllowedRight - leftPx),
      );
      const handlePx =
        widthPx >= 24 ? 6 : widthPx >= 10 ? Math.max(2, Math.floor(widthPx * 0.22)) : 0;

      return {
        ...entry,
        index,
        leftPx,
        widthPx,
        handlePx,
      };
    });
  }, [drag, ordered, safeDuration, trackWidth]);

  const rail = (
    <div
      ref={railRef}
      role="group"
      aria-label="Subtitle track"
      className={cn(
        "relative select-none overflow-hidden rounded-md border border-border bg-card/40 touch-none",
        externalScroll ? "h-full min-h-[30px] w-full" : "h-11",
        className,
      )}
      style={!externalScroll && zoom > 1 ? { width: `${trackWidth}px` } : undefined}
      onPointerDown={beginScrub}
    >
      {/* Top scrub ruler: always seeks even directly over a subtitle block. */}
      {duration > 0 ? (
        <div
          aria-label="Scrub timeline"
          title="Drag top strip to scrub · drag seam to adjust cut"
          className="absolute inset-x-0 top-0 z-10 h-2.5 cursor-ew-resize border-b border-border/50 bg-background/35"
          onPointerDown={beginScrub}
        />
      ) : null}

      {cues.length === 0 ? (
        <span className="pointer-events-none absolute inset-x-0 top-2.5 bottom-0 flex items-center justify-center text-[11px] text-muted-foreground">
          No subtitle lines yet
        </span>
      ) : null}

      {layout.map(({ cue, leftPx, widthPx, handlePx }) => {
        const active = cue.id === selectedId;
        const isPlaying = cue.id === playingCueId;
        return (
          <div
            key={cue.id}
            role="button"
            tabIndex={0}
            aria-label={`Subtitle line ${formatClock(cue.start, true)} to ${formatClock(
              cue.end,
              true,
            )}`}
            aria-pressed={active}
            title={cue.thai || cue.arabic || "Empty line"}
            onPointerDown={(event) => beginDrag(event, cue, "move")}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(cue.id);
              }
            }}
            className={cn(
              "absolute top-3 bottom-1 cursor-grab rounded-sm border transition-colors",
              cue.reviewed
                ? "border-border/80 bg-foreground/[0.06] hover:bg-foreground/10"
                : "border-ring/40 bg-foreground/15 hover:bg-foreground/20",
              isPlaying && !active && "border-foreground/50 bg-foreground/20",
              active && "z-10 border-ring bg-foreground/25 ring-1 ring-inset ring-ring/70",
            )}
            style={{
              left: zoom === 1 ? `${(leftPx / trackWidth) * 100}%` : `${leftPx}px`,
              width: zoom === 1 ? `${(widthPx / trackWidth) * 100}%` : `${widthPx}px`,
            }}
          >
            {handlePx > 0 ? (
              <>
                <span
                  aria-hidden
                  className="absolute inset-y-0 left-0 cursor-ew-resize rounded-l-sm hover:bg-foreground/25"
                  style={{ width: `${handlePx}px` }}
                  onPointerDown={(event) => beginDrag(event, cue, "start")}
                />
                <span
                  aria-hidden
                  className="absolute inset-y-0 right-0 cursor-ew-resize rounded-r-sm hover:bg-foreground/25"
                  style={{ width: `${handlePx}px` }}
                  onPointerDown={(event) => beginDrag(event, cue, "end")}
                />
              </>
            ) : null}
            {cue.reviewed && widthPx >= 10 ? (
              <span
                aria-hidden
                className="absolute left-2 top-1.5 size-1 rounded-full bg-foreground/60"
              />
            ) : null}
          </div>
        );
      })}

      {onChangePair
        ? layout.map((entry, idx) => {
            const nextEntry = layout[idx + 1];
            if (!nextEntry) return null;
            if (nextEntry.start - entry.end > SEAM_TOLERANCE) return null;
            if (entry.widthPx < 8 || nextEntry.widthPx < 8) return null;
            const seamCenterPx =
              (((entry.end + nextEntry.start) * 0.5) / safeDuration) * trackWidth;
            const isDraggingSeam =
              drag?.kind === "seam" &&
              drag.leftId === entry.cue.id &&
              drag.rightId === nextEntry.cue.id;
            return (
              <div
                key={`seam-${entry.cue.id}-${nextEntry.cue.id}`}
                role="separator"
                aria-orientation="vertical"
                aria-label={`Adjust cut between line ${idx + 1} and line ${idx + 2}`}
                title="Drag to adjust cut between lines"
                onPointerDown={(event) => beginSeamDrag(event, entry.cue, nextEntry.cue)}
                className="group absolute top-3 bottom-1 z-20 flex w-1 cursor-col-resize items-center justify-center"
                style={{
                  left:
                    zoom === 1
                      ? `calc(${(seamCenterPx / trackWidth) * 100}% - 2px)`
                      : `${seamCenterPx - 2}px`,
                }}
              >
                <span
                  aria-hidden
                  className={cn(
                    "h-full w-px transition-colors",
                    isDraggingSeam
                      ? "w-0.5 bg-foreground"
                      : "bg-transparent group-hover:bg-foreground/60",
                  )}
                />
              </div>
            );
          })
        : null}

      {!hidePlayhead && duration > 0 ? (
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
  );

  if (externalScroll) return rail;

  return (
    <div
      ref={scrollRef}
      className={cn("w-full shrink-0", zoom > 1 ? "overflow-x-auto pb-0.5" : "overflow-hidden")}
    >
      {rail}
    </div>
  );
}

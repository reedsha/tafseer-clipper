import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { cn } from "cn";

import { formatClock } from "@/lib/format";
import type { SubtitleCue } from "@/lib/projectTypes";

const MIN_CUE_SECONDS = 0.2;
/** Keeps two neighbouring lines from touching after a drag. */
const NEIGHBOUR_GAP = 0.02;

type DragMode = "move" | "start" | "end";

interface DragState {
  id: string;
  mode: DragMode;
  startX: number;
  width: number;
  originStart: number;
  originEnd: number;
  draftStart: number;
  draftEnd: number;
  lowerBound: number;
  upperBound: number;
}

export interface CueRibbonProps {
  cues: SubtitleCue[];
  /** Clip duration in seconds (cues are clip-relative). */
  duration: number;
  selectedId: string | null;
  /** Clip-relative playhead in seconds. */
  playhead: number;
  onSelect: (id: string) => void;
  onSeek: (seconds: number) => void;
  onChangeTime: (id: string, start: number, end: number) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundTime(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The subtitle track under the monitor: one block per line, sized by duration.
 * Click a block to jump to that line, drag its body to shift it, or drag either
 * edge to retime it. Blocks stop at their neighbours so the burn-in can never
 * receive overlapping lines.
 */
export function CueRibbon({
  cues,
  duration,
  selectedId,
  playhead,
  onSelect,
  onSeek,
  onChangeTime,
}: CueRibbonProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const changeRef = useRef(onChangeTime);
  const [drag, setDrag] = useState<DragState | null>(null);

  useEffect(() => {
    changeRef.current = onChangeTime;
  }, [onChangeTime]);

  const dragging = drag !== null;

  useEffect(() => {
    if (!dragging) return;
    const handleMove = (event: PointerEvent) => {      const state = dragRef.current;
      if (!state) return;
      const delta = ((event.clientX - state.startX) / state.width) * duration;
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
          lowest <= highest ? clamp(state.originStart + delta, lowest, highest) : state.originStart;
      } else {
        const lowest = state.originStart + MIN_CUE_SECONDS;
        const highest = state.upperBound;
        end = lowest <= highest ? clamp(state.originEnd + delta, lowest, highest) : state.originEnd;
      }

      const next = {
        ...state,
        draftStart: clamp(start, 0, Math.max(0, duration)),
        draftEnd: clamp(end, 0, Math.max(0, duration)),
      };
      dragRef.current = next;
      setDrag(next);
    };

    const handleUp = () => {
      const state = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!state) return;
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

  function beginDrag(event: ReactPointerEvent, cue: SubtitleCue, mode: DragMode) {
    if (!railRef.current || duration <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = railRef.current.getBoundingClientRect();
    if (rect.width <= 0) return;
    const sorted = [...cues].sort((a, b) => a.start - b.start);
    const index = sorted.findIndex((item) => item.id === cue.id);
    const previous = index > 0 ? sorted[index - 1] : null;
    const next = index >= 0 ? sorted[index + 1] : null;
    const state: DragState = {
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
    onSelect(cue.id);
  }

  function seekFromPointer(event: ReactPointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || duration <= 0) return;
    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    onSeek(ratio * duration);
  }

  const safeDuration = duration > 0 ? duration : 1;

  return (
    <div className="space-y-1">
      <div
        ref={railRef}
        role="group"
        aria-label="Subtitle track"
        className="relative h-11 select-none overflow-hidden rounded-md border border-border bg-card/40 touch-none"
        onPointerDown={seekFromPointer}
      >
        {cues.length === 0 ? (
          <span className="absolute inset-0 flex items-center justify-center text-[11px] text-muted-foreground">
            No subtitle lines yet
          </span>
        ) : null}

        {cues.map((cue) => {
          const draft = drag?.id === cue.id ? drag : null;
          const start = draft ? draft.draftStart : cue.start;
          const end = draft ? draft.draftEnd : cue.end;
          const active = cue.id === selectedId;
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
                "absolute inset-y-1.5 cursor-grab rounded-sm border transition-colors",
                cue.reviewed
                  ? "border-border/80 bg-foreground/[0.06] hover:bg-foreground/10"
                  : "border-ring/40 bg-foreground/15 hover:bg-foreground/20",
                active && "border-ring bg-foreground/25 ring-1 ring-ring/70",
              )}
              style={{
                left: `${(start / safeDuration) * 100}%`,
                width: `${Math.max(0.6, ((end - start) / safeDuration) * 100)}%`,
              }}
            >
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize rounded-l-sm hover:bg-foreground/25"
                onPointerDown={(event) => beginDrag(event, cue, "start")}
              />
              <span
                aria-hidden
                className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize rounded-r-sm hover:bg-foreground/25"
                onPointerDown={(event) => beginDrag(event, cue, "end")}
              />
              {cue.reviewed ? (
                <span
                  aria-hidden
                  className="absolute left-2 top-1.5 size-1 rounded-full bg-foreground/60"
                />
              ) : null}
            </div>
          );
        })}

        {duration > 0 ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 w-px bg-foreground/70"
            style={{ left: `${(clamp(playhead, 0, duration) / duration) * 100}%` }}
          />
        ) : null}
      </div>
    </div>
  );
}

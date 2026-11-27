import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { AlertTriangle, Film, Image as ImageIcon } from "lucide-react";
import { cn } from "cn";

import { formatClock } from "@/lib/format";
import {
  computeInsertDrag,
  INSERT_NEIGHBOUR_GAP,
  type InsertDragMode,
} from "@/lib/insertTiming";
import type { MediaInsert, SubtitleCue } from "@/lib/projectTypes";
import { clamp, roundTime } from "@/lib/subtitleTiming";

interface DragState {
  id: string;
  mode: InsertDragMode;
  startX: number;
  width: number;
  origin: MediaInsert;
  draftStart: number;
  draftEnd: number;
  draftSourceStart: number;
  hitLimit: "source-start" | "source-end" | null;
  lowerBound: number;
  upperBound: number;
}

export interface InsertRibbonProps {
  inserts: MediaInsert[];
  cues: SubtitleCue[];
  duration: number;
  selectedId: string | null;
  playhead: number;
  zoom: number;
  trackWidth: number;
  missingIds?: ReadonlySet<string>;
  dragOver?: boolean;
  onSelect: (id: string | null) => void;
  onSeek: (seconds: number) => void;
  onScrubEdge?: (seconds: number) => void;
  onChangeInsert: (
    id: string,
    patch: Pick<MediaInsert, "start" | "end" | "sourceStart">,
  ) => void;
  onDropFiles?: (files: FileList) => void;
}

/**
 * Insert footage track directly beneath `CueRibbon`, aligned to the same
 * clip timeline and playhead. Videos cap at their natural duration and support
 * both front (`sourceStart`) and tail trimming; images can stretch across the
 * full clip.
 */
export function InsertRibbon({
  inserts,
  cues,
  duration,
  selectedId,
  playhead,
  zoom,
  trackWidth,
  missingIds,
  dragOver = false,
  onSelect,
  onSeek,
  onScrubEdge,
  onChangeInsert,
  onDropFiles,
}: InsertRibbonProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const scrubbingRef = useRef(false);
  const changeRef = useRef(onChangeInsert);
  const seekRef = useRef(onSeek);
  const scrubRef = useRef(onScrubEdge);
  const cuesRef = useRef(cues);
  const playheadRef = useRef(playhead);

  const [drag, setDrag] = useState<DragState | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [localDropHover, setLocalDropHover] = useState(false);

  useEffect(() => {
    changeRef.current = onChangeInsert;
  }, [onChangeInsert]);

  useEffect(() => {
    seekRef.current = onSeek;
  }, [onSeek]);

  useEffect(() => {
    scrubRef.current = onScrubEdge;
  }, [onScrubEdge]);

  useEffect(() => {
    cuesRef.current = cues;
  }, [cues]);

  useEffect(() => {
    playheadRef.current = playhead;
  }, [playhead]);

  const dragging = drag !== null;

  useEffect(() => {
    if (!dragging) return;
    const handleMove = (event: PointerEvent) => {
      const state = dragRef.current;
      if (!state || state.width <= 0) return;
      const deltaSeconds = ((event.clientX - state.startX) / state.width) * duration;
      const snapTargets = event.altKey
        ? []
        : [
            0,
            duration,
            playheadRef.current,
            ...cuesRef.current.flatMap((cue) => [cue.start, cue.end]),
          ];
      const snapThresholdSeconds = event.altKey ? 0 : (7 / state.width) * duration;

      const resolved = computeInsertDrag({
        insert: state.origin,
        mode: state.mode,
        deltaSeconds,
        lowerBound: state.lowerBound,
        upperBound: state.upperBound,
        clipDuration: duration,
        snapTargets,
        snapThresholdSeconds,
      });

      const next: DragState = {
        ...state,
        draftStart: resolved.start,
        draftEnd: resolved.end,
        draftSourceStart: resolved.sourceStart,
        hitLimit: resolved.hitLimit,
      };
      dragRef.current = next;
      setDrag(next);

      if (state.mode === "end") scrubRef.current?.(Math.max(next.draftStart, next.draftEnd - 0.02));
      else scrubRef.current?.(next.draftStart + 0.02);
    };

    const handleUp = () => {
      const state = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!state) return;
      const start = roundTime(state.draftStart);
      const end = roundTime(state.draftEnd);
      const sourceStart = roundTime(state.draftSourceStart);
      if (
        Math.abs(start - state.origin.start) > 0.001 ||
        Math.abs(end - state.origin.end) > 0.001 ||
        Math.abs(sourceStart - state.origin.sourceStart) > 0.001
      ) {
        changeRef.current(state.id, { start, end, sourceStart });
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
    () => [...inserts].sort((a, b) => a.start - b.start || a.end - b.end),
    [inserts],
  );

  function beginDrag(event: ReactPointerEvent, item: MediaInsert, mode: InsertDragMode) {
    if (!railRef.current || duration <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = railRef.current.getBoundingClientRect();
    if (rect.width <= 0) return;
    const index = ordered.findIndex((entry) => entry.id === item.id);
    const previous = index > 0 ? ordered[index - 1] : null;
    const next = index >= 0 ? ordered[index + 1] : null;
    const state: DragState = {
      id: item.id,
      mode,
      startX: event.clientX,
      width: rect.width,
      origin: item,
      draftStart: item.start,
      draftEnd: item.end,
      draftSourceStart: item.sourceStart,
      hitLimit: null,
      lowerBound: previous ? previous.end + INSERT_NEIGHBOUR_GAP : 0,
      upperBound: next ? next.start - INSERT_NEIGHBOUR_GAP : duration,
    };
    dragRef.current = state;
    setDrag(state);
    onSelect(item.id);
    if (mode === "move") {
      onSeek(item.start + 0.02);
    }
  }

  function beginScrub(event: ReactPointerEvent<HTMLDivElement>) {
    if (duration <= 0 || !railRef.current) return;
    event.stopPropagation();
    const rect = railRef.current.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    onSelect(null);
    onSeek(roundTime(ratio * duration));
    scrubbingRef.current = true;
    setScrubbing(true);
  }

  function handleHtmlDragOver(event: DragEvent<HTMLDivElement>) {
    if (!onDropFiles) return;
    if (event.dataTransfer?.types?.includes("Files")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      if (!localDropHover) setLocalDropHover(true);
    }
  }

  function handleHtmlDrop(event: DragEvent<HTMLDivElement>) {
    setLocalDropHover(false);
    if (!onDropFiles || !event.dataTransfer?.files?.length) return;
    event.preventDefault();
    event.stopPropagation();
    onDropFiles(event.dataTransfer.files);
  }

  const safeDuration = duration > 0 ? duration : 1;
  const safeTrackWidth = Math.max(1, trackWidth);

  const layout = useMemo(() => {
    return ordered.map((item) => {
      const activeDrag = drag?.id === item.id ? drag : null;
      const start = activeDrag ? activeDrag.draftStart : item.start;
      const end = activeDrag ? activeDrag.draftEnd : item.end;
      const sourceStart = activeDrag ? activeDrag.draftSourceStart : item.sourceStart;
      const leftPx = (start / safeDuration) * safeTrackWidth;
      const rightPx = (end / safeDuration) * safeTrackWidth;
      const widthPx = Math.max(4, rightPx - leftPx);
      const handlePx =
        widthPx >= 24 ? 6 : widthPx >= 10 ? Math.max(3, Math.floor(widthPx * 0.22)) : 0;
      return {
        item,
        start,
        end,
        sourceStart,
        leftPx,
        widthPx,
        handlePx,
        hitLimit: activeDrag?.hitLimit ?? null,
      };
    });
  }, [drag, ordered, safeDuration, safeTrackWidth]);

  return (
    <div
      ref={railRef}
      role="group"
      aria-label="Insert footage track"
      onDragOver={handleHtmlDragOver}
      onDragLeave={() => setLocalDropHover(false)}
      onDrop={handleHtmlDrop}
      onPointerDown={beginScrub}
      className={cn(
        "relative h-full min-h-[26px] w-full select-none overflow-hidden rounded-md border bg-card/30 touch-none transition-colors",
        dragOver || localDropHover ? "border-ring bg-accent/15" : "border-border",
      )}
    >
      {inserts.length === 0 ? (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center px-2 text-center text-[10px] text-muted-foreground/80">
          Drop, paste (Ctrl+V), or click + to insert image or video
        </span>
      ) : null}

      {layout.map(({ item, start, end, sourceStart, leftPx, widthPx, handlePx, hitLimit }) => {
        const active = item.id === selectedId;
        const missing = missingIds?.has(item.id) ?? false;
        const span = Math.max(0, end - start);
        const frontTrimmed = item.kind === "video" && sourceStart > 0.01;
        const tailTrimmed =
          item.kind === "video" &&
          item.sourceDuration !== null &&
          sourceStart + span < item.sourceDuration - 0.01;
        const durationLabel =
          item.kind === "video" && item.sourceDuration !== null
            ? `${span.toFixed(1)}s/${item.sourceDuration.toFixed(1)}s`
            : `${span.toFixed(1)}s`;

        return (
          <div
            key={item.id}
            role="button"
            tabIndex={0}
            data-insert-block={item.id}
            aria-label={`Insert ${item.kind} ${item.name} ${formatClock(start, true)} to ${formatClock(
              end,
              true,
            )}`}
            aria-pressed={active}
            title={`${item.name} · ${formatClock(start, true)} → ${formatClock(end, true)} (${durationLabel})${
              frontTrimmed ? ` · from ${formatClock(sourceStart, true)}` : ""
            }`}
            onPointerDown={(event) => beginDrag(event, item, "move")}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(item.id);
                onSeek(start + 0.02);
              }
            }}
            className={cn(
              "absolute inset-y-1 flex cursor-grab items-center overflow-hidden rounded-sm border px-2 transition-colors",
              missing
                ? "border-destructive/60 bg-destructive/15 text-destructive-foreground"
                : active
                  ? "z-10 border-ring bg-foreground/25 ring-1 ring-inset ring-ring/70"
                  : "border-border/80 bg-secondary/70 hover:bg-secondary",
            )}
            style={{
              left: zoom === 1 ? `${(leftPx / safeTrackWidth) * 100}%` : `${leftPx}px`,
              width: zoom === 1 ? `${(widthPx / safeTrackWidth) * 100}%` : `${widthPx}px`,
            }}
          >
            {frontTrimmed ? (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-foreground/60"
              />
            ) : null}
            {tailTrimmed ? (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-0 right-0 w-0.5 bg-foreground/60"
              />
            ) : null}

            {handlePx > 0 ? (
              <>
                <span
                  aria-hidden
                  data-insert-handle="start"
                  className="absolute inset-y-0 left-0 z-10 cursor-ew-resize rounded-l-sm hover:bg-foreground/25"
                  style={{ width: `${handlePx}px` }}
                  onPointerDown={(event) => beginDrag(event, item, "start")}
                />
                <span
                  aria-hidden
                  data-insert-handle="end"
                  className="absolute inset-y-0 right-0 z-10 cursor-ew-resize rounded-r-sm hover:bg-foreground/25"
                  style={{ width: `${handlePx}px` }}
                  onPointerDown={(event) => beginDrag(event, item, "end")}
                />
              </>
            ) : null}

            {widthPx >= 28 ? (
              <div className="pointer-events-none flex min-w-0 flex-1 flex-col justify-center gap-0.5">
                <div className="flex min-w-0 items-center gap-1 text-[10px] text-foreground/90">
                  {missing ? (
                    <AlertTriangle className="size-3 shrink-0 text-destructive" />
                  ) : item.kind === "video" ? (
                    <Film className="size-3 shrink-0 text-muted-foreground" />
                  ) : (
                    <ImageIcon className="size-3 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-medium">{item.name}</span>
                  {widthPx >= 95 ? (
                    <span className="shrink-0 text-[9px] tabular-nums text-muted-foreground">
                      {durationLabel}
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}

            {hitLimit ? (
              <span className="pointer-events-none absolute right-1.5 bottom-0.5 rounded bg-background/90 px-1 text-[8px] font-medium text-foreground">
                {hitLimit === "source-start" ? "Start of video" : "Max length"}
              </span>
            ) : null}
          </div>
        );
      })}

      {drag ? (
        <div
          aria-hidden
          className="pointer-events-none absolute top-0.5 right-1.5 z-20 rounded border border-border bg-background/95 px-1.5 py-0.5 text-[9px] tabular-nums text-foreground shadow-sm"
        >
          {formatClock(drag.draftStart, true)} → {formatClock(drag.draftEnd, true)} ·{" "}
          {(drag.draftEnd - drag.draftStart).toFixed(1)}s
          {drag.origin.kind === "video" && drag.draftSourceStart > 0.01
            ? ` (in ${formatClock(drag.draftSourceStart, true)})`
            : ""}
        </div>
      ) : null}
    </div>
  );
}

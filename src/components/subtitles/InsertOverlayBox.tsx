import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { cn } from "cn";

import { computeRectDrag, type RectHandle } from "@/lib/insertTiming";
import { toMediaSrc } from "@/lib/media";
import type { InsertRect, MediaInsert } from "@/lib/projectTypes";
import { clamp } from "@/lib/subtitleTiming";

export interface InsertOverlayBoxProps {
  insert: MediaInsert;
  frameWidth: number;
  frameHeight: number;
  /** Clip-relative time in seconds. */
  clipTime: number;
  playing: boolean;
  playbackRate: number;
  interactive?: boolean;
  selected?: boolean;
  onSelect?: (id: string) => void;
  onCommitRect?: (id: string, rect: InsertRect) => void;
}

const HANDLES: { id: RectHandle; className: string; label: string }[] = [
  { id: "nw", className: "top-0.5 left-0.5 cursor-nwse-resize", label: "Resize top-left" },
  { id: "n", className: "top-0.5 left-1/2 -translate-x-1/2 cursor-ns-resize", label: "Resize top" },
  { id: "ne", className: "top-0.5 right-0.5 cursor-nesw-resize", label: "Resize top-right" },
  { id: "e", className: "top-1/2 right-0.5 -translate-y-1/2 cursor-ew-resize", label: "Resize right" },
  { id: "se", className: "bottom-0.5 right-0.5 cursor-nwse-resize", label: "Resize bottom-right" },
  { id: "s", className: "bottom-0.5 left-1/2 -translate-x-1/2 cursor-ns-resize", label: "Resize bottom" },
  { id: "sw", className: "bottom-0.5 left-0.5 cursor-nesw-resize", label: "Resize bottom-left" },
  { id: "w", className: "top-1/2 left-0.5 -translate-y-1/2 cursor-ew-resize", label: "Resize left" },
];

interface BoxDragState {
  handle: RectHandle;
  startX: number;
  startY: number;
  originRect: InsertRect;
  draftRect: InsertRect;
  guides: { verticalCenter: boolean; horizontalCenter: boolean };
}

/**
 * Live visual insert layer inside `SubtitleMonitor` with PowerPoint-style move
 * and 8-handle resize controls when selected. Always renders beneath
 * `SubtitleOverlay` so subtitles stay readable on top.
 */
export function InsertOverlayBox({
  insert,
  frameWidth,
  frameHeight,
  clipTime,
  playing,
  playbackRate,
  interactive = false,
  selected = false,
  onSelect,
  onCommitRect,
}: InsertOverlayBoxProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const dragRef = useRef<BoxDragState | null>(null);
  const commitRef = useRef(onCommitRect);
  const [drag, setDrag] = useState<BoxDragState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const src = useMemo(() => toMediaSrc(insert.path), [insert.path]);

  useEffect(() => {
    commitRef.current = onCommitRect;
  }, [onCommitRect]);

  useEffect(() => {
    setLoadFailed(false);
  }, [src, insert.id]);

  // Keep insert video synced with main lecture playhead / speed / play state.
  useEffect(() => {
    if (insert.kind !== "video") return;
    const video = videoRef.current;
    if (!video || !src) return;

    video.muted = insert.muted !== false;
    video.playbackRate = playbackRate;

    const rawTarget = insert.sourceStart + Math.max(0, clipTime - insert.start);
    const maxSource =
      insert.sourceDuration !== null && Number.isFinite(insert.sourceDuration)
        ? Math.max(0, insert.sourceDuration - 0.02)
        : rawTarget;
    const target = clamp(rawTarget, 0, maxSource);

    if (playing) {
      if (video.readyState >= 1 && Math.abs(video.currentTime - target) > 0.25) {
        video.currentTime = target;
      }
      if (video.paused) {
        void video.play().catch(() => {});
      }
    } else {
      if (!video.paused) video.pause();
      if (video.readyState >= 1 && Math.abs(video.currentTime - target) > 0.04) {
        video.currentTime = target;
      }
    }
  }, [clipTime, insert.kind, insert.muted, insert.sourceDuration, insert.sourceStart, insert.start, playbackRate, playing, src]);

  const dragging = drag !== null;

  useEffect(() => {
    if (!dragging) return;
    const safeW = Math.max(1, frameWidth);
    const safeH = Math.max(1, frameHeight);
    const frameAspect = safeW / safeH;

    const handleMove = (event: PointerEvent) => {
      const state = dragRef.current;
      if (!state) return;
      const dxNorm = (event.clientX - state.startX) / safeW;
      const dyNorm = (event.clientY - state.startY) / safeH;
      const result = computeRectDrag({
        originRect: state.originRect,
        handle: state.handle,
        dxNorm,
        dyNorm,
        lockAspect: !event.shiftKey,
        frameAspect,
      });
      const next: BoxDragState = {
        ...state,
        draftRect: result.rect,
        guides: result.guides,
      };
      dragRef.current = next;
      setDrag(next);
    };

    const handleUp = () => {
      const state = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!state) return;
      const changed =
        Math.abs(state.draftRect.x - state.originRect.x) > 0.0005 ||
        Math.abs(state.draftRect.y - state.originRect.y) > 0.0005 ||
        Math.abs(state.draftRect.width - state.originRect.width) > 0.0005 ||
        Math.abs(state.draftRect.height - state.originRect.height) > 0.0005;
      if (changed) {
        // Suppress the trailing synthetic click so releasing a handle over the
        // frame does not toggle playback or deselect the insert.
        const suppress = (clickEvent: MouseEvent) => {
          clickEvent.stopPropagation();
          clickEvent.preventDefault();
        };
        window.addEventListener("click", suppress, { capture: true, once: true });
        window.setTimeout(() => {
          window.removeEventListener("click", suppress, { capture: true });
        }, 0);
        commitRef.current?.(insert.id, state.draftRect);
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
  }, [dragging, frameHeight, frameWidth, insert.id]);

  function beginBoxDrag(event: ReactPointerEvent, handle: RectHandle) {
    if (!interactive) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect?.(insert.id);
    const state: BoxDragState = {
      handle,
      startX: event.clientX,
      startY: event.clientY,
      originRect: insert.rect,
      draftRect: insert.rect,
      guides: { verticalCenter: false, horizontalCenter: false },
    };
    dragRef.current = state;
    setDrag(state);
  }

  const rect = drag ? drag.draftRect : insert.rect;
  const fade = insert.fade ?? 0;
  let opacity = 1;
  if (fade > 0) {
    const fadeIn = clamp((clipTime - insert.start) / fade, 0, 1);
    const fadeOut = clamp((insert.end - clipTime) / fade, 0, 1);
    opacity = Math.min(fadeIn, fadeOut);
  }

  const objectFitClass =
    insert.fit === "cover" ? "object-cover" : "object-contain";

  return (
    <>
      {drag?.guides.verticalCenter ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-1/2 z-20 w-px border-l border-dashed border-foreground/60"
        />
      ) : null}
      {drag?.guides.horizontalCenter ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-1/2 z-20 h-px border-t border-dashed border-foreground/60"
        />
      ) : null}

      <div
        data-insert-overlay={insert.id}
        onClick={(event) => {
          event.stopPropagation();
          onSelect?.(insert.id);
        }}
        onPointerDown={(event) => {
          if (selected && interactive) beginBoxDrag(event, "move");
          else if (interactive) {
            event.stopPropagation();
            onSelect?.(insert.id);
          }
        }}
        style={{
          left: `${rect.x * 100}%`,
          top: `${rect.y * 100}%`,
          width: `${rect.width * 100}%`,
          height: `${rect.height * 100}%`,
          opacity,
        }}
        className={cn(
          "absolute z-10 overflow-visible select-none",
          interactive && (selected ? "cursor-move" : "cursor-pointer"),
        )}
      >
        <div
          className={cn(
            "relative size-full overflow-hidden",
            insert.fit === "contain" ? "bg-transparent" : "bg-black",
          )}
        >
          {src && !loadFailed ? (
            insert.kind === "image" ? (
              <>
                {insert.fit === "blur-fill" ? (
                  <img
                    src={src}
                    alt=""
                    aria-hidden
                    draggable={false}
                    className="pointer-events-none absolute inset-0 size-full scale-110 object-cover blur-2xl"
                  />
                ) : null}
                <img
                  src={src}
                  alt={insert.name}
                  draggable={false}
                  onError={() => setLoadFailed(true)}
                  className={cn("pointer-events-none relative size-full", objectFitClass)}
                />
              </>
            ) : (
              <>
                {insert.fit === "blur-fill" ? (
                  <video
                    src={src}
                    muted
                    playsInline
                    preload="metadata"
                    aria-hidden
                    data-insert-video="backdrop"
                    className="pointer-events-none absolute inset-0 size-full scale-110 object-cover blur-2xl"
                  />
                ) : null}
                <video
                  ref={videoRef}
                  src={src}
                  muted={insert.muted !== false}
                  playsInline
                  preload="auto"
                  aria-label={`Insert video ${insert.name}`}
                  data-insert-video="true"
                  onLoadedMetadata={() => {
                    const video = videoRef.current;
                    if (!video) return;
                    const target = clamp(
                      insert.sourceStart + Math.max(0, clipTime - insert.start),
                      0,
                      insert.sourceDuration ?? Infinity,
                    );
                    video.currentTime = target;
                  }}
                  onError={() => setLoadFailed(true)}
                  className={cn("pointer-events-none relative size-full", objectFitClass)}
                />
              </>
            )
          ) : (
            <div className="flex size-full items-center justify-center border border-dashed border-border bg-card/80 px-2 text-center text-[10px] text-muted-foreground">
              {insert.name}
            </div>
          )}
        </div>

        {interactive && selected ? (
          <div
            aria-label="Insert transform handles"
            className="pointer-events-none absolute inset-0 border border-foreground/80 shadow-[0_0_0_1px_rgba(0,0,0,0.45)]"
          >
            {HANDLES.map((handle) => (
              <span
                key={handle.id}
                role="slider"
                aria-label={handle.label}
                aria-valuenow={Math.round(rect.width * 100)}
                data-insert-rect-handle={handle.id}
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => beginBoxDrag(event, handle.id)}
                className={cn(
                  "pointer-events-auto absolute size-2.5 rounded-[2px] border border-background bg-foreground shadow-sm",
                  handle.className,
                )}
              />
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}

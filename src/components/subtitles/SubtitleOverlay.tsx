import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { Heart, MessageCircle, Send } from "lucide-react";
import { cn } from "cn";

import type { Resolution } from "@/lib/projectTypes";
import {
  ASS_RESOLUTIONS,
  previewLineMetrics,
  type AssStyle,
  type PreviewLineMetrics,
  type SubtitleLine,
} from "@/lib/subtitleStyles";

export interface SubtitleOverlayProps {
  resolution: Resolution;
  /** Rendered frame width in CSS pixels. */
  width: number;
  styles: { arabic: AssStyle; thai: AssStyle };
  arabic: string;
  thai: string;
  safeZone?: boolean;
  /** Allow the lines to be selected and moved vertically. */
  interactive?: boolean;
  /** Current offsets, used for the sliders' accessible values. */
  offsets?: { arabic: number; thai: number };
  /** Delta is in export-frame pixels; positive moves the line up. */
  onNudgeLine?: (kind: SubtitleLine, deltaExportPx: number) => void;
}

/** Outline ring in this line's *own* colour (Arabic and Thai can differ). */
function textShadow(outlinePx: number, color: string, shadowPx: number): string | undefined {
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
}

function lineStyle(
  metrics: PreviewLineMetrics,
  line: AssStyle,
  kind: "arabic" | "thai",
  scale: number,
): CSSProperties {
  return {
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
  };
}

/** BorderStyle 3: the `.ass` box is BackColour behind the text; mirror it. */
function boxStyle(line: AssStyle, metrics: PreviewLineMetrics): CSSProperties | undefined {
  return line.boxOpacity > 0
    ? {
        backgroundColor: `rgba(0, 0, 0, ${Math.min(1, Math.max(0, line.boxOpacity))})`,
        padding: `${metrics.outlinePx}px ${metrics.outlinePx * 2}px`,
        boxDecorationBreak: "clone" as const,
        WebkitBoxDecorationBreak: "clone" as const,
      }
    : undefined;
}

/**
 * The bilingual subtitle lines laid out at `.ass` geometry inside a frame of
 * `width` CSS pixels: the one source of truth for "what the export looks
 * like", shared by the playable Step 3 monitor and the static configuration
 * preview.
 *
 * With `interactive`, each line becomes a vertical slider: click to select,
 * drag to move, or use ↑/↓ (Shift for a larger step). The visual position
 * still comes from `.ass` geometry — dragging only changes the stored offset
 * that feeds `margin_v`, so the preview and the burned video stay identical.
 */
export function SubtitleOverlay({
  resolution,
  width,
  styles,
  arabic,
  thai,
  safeZone = false,
  interactive = false,
  offsets,
  onNudgeLine,
}: SubtitleOverlayProps) {
  const play = ASS_RESOLUTIONS[resolution];
  const portrait = play.height > play.width;
  const scale = width / play.width;
  const arabicMetrics = previewLineMetrics(styles.arabic, resolution, width);
  const thaiMetrics = previewLineMetrics(styles.thai, resolution, width);
  const [selectedLine, setSelectedLine] = useState<SubtitleLine | null>(null);
  const dragRef = useRef<{ kind: SubtitleLine; lastY: number } | null>(null);

  function beginDrag(kind: SubtitleLine, event: PointerEvent<HTMLParagraphElement>) {
    if (!interactive || !onNudgeLine) return;
    // Don't let a drag on the caption also toggle playback in Step 3.
    event.stopPropagation();
    event.preventDefault();
    setSelectedLine(kind);
    dragRef.current = { kind, lastY: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent<HTMLParagraphElement>) {
    const drag = dragRef.current;
    if (!drag || !onNudgeLine) return;
    // Screen pixels → export pixels. Upward drag increases margin_v (bottom
    // offset), so invert the pointer delta.
    const delta = (drag.lastY - event.clientY) / scale;
    drag.lastY = event.clientY;
    if (delta !== 0) onNudgeLine(drag.kind, delta);
  }

  function endDrag(event: PointerEvent<HTMLParagraphElement>) {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleKey(kind: SubtitleLine, event: KeyboardEvent<HTMLParagraphElement>) {
    if (!interactive || !onNudgeLine) return;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const screenPixels = event.shiftKey ? 10 : 1;
      const delta = ((event.key === "ArrowUp" ? screenPixels : -screenPixels) / scale);
      onNudgeLine(kind, delta);
    } else if (event.key === "Escape") {
      setSelectedLine(null);
    }
  }

  function lineProps(kind: SubtitleLine) {
    if (!interactive) return {};
    return {
      tabIndex: 0,
      role: "slider" as const,
      "aria-orientation": "vertical" as const,
      "aria-label": `${kind === "arabic" ? "Arabic" : "Thai"} subtitle line vertical position`,
      "aria-valuenow": Math.round(offsets?.[kind] ?? 0),
      "aria-valuemin": -900,
      "aria-valuemax": 900,
      onPointerDown: (event: PointerEvent<HTMLParagraphElement>) => beginDrag(kind, event),
      onPointerMove: moveDrag,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onKeyDown: (event: KeyboardEvent<HTMLParagraphElement>) => handleKey(kind, event),
    };
  }

  function lineClass(kind: SubtitleLine) {
    return cn(
      "absolute px-2 text-center whitespace-pre-line",
      interactive && "pointer-events-auto cursor-ns-resize touch-none select-none outline-none",
      interactive &&
        selectedLine === kind &&
        "outline-1 outline-dashed outline-foreground/40 focus-visible:outline-foreground/60",
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0">
      {safeZone && portrait ? portraitSafeZone() : null}

      {arabic ? (
        <p
          dir="rtl"
          lang="ar"
          className={lineClass("arabic")}
          style={lineStyle(arabicMetrics, styles.arabic, "arabic", scale)}
          {...lineProps("arabic")}
        >
          <span style={boxStyle(styles.arabic, arabicMetrics)}>{arabic}</span>
        </p>
      ) : null}

      {thai ? (
        <p
          lang="th"
          className={lineClass("thai")}
          style={lineStyle(thaiMetrics, styles.thai, "thai", scale)}
          {...lineProps("thai")}
        >
          <span style={boxStyle(styles.thai, thaiMetrics)}>{thai}</span>
        </p>
      ) : null}

      {interactive && selectedLine ? (
        <span className="absolute top-2 right-2 rounded border border-border bg-background/85 px-1.5 py-0.5 text-[9px] tracking-wide text-foreground/70">
          {selectedLine === "arabic" ? "Arabic" : "Thai"} · ↑↓ nudge · Esc release
        </span>
      ) : null}
    </div>
  );
}

/** The safe-zone guides are decorative and never take pointer events. */
function portraitSafeZone() {
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      <div className="absolute inset-y-0 right-0 w-[16%] border-l border-dashed border-foreground/25 bg-foreground/[0.04]">
        <div className="flex flex-col items-center gap-2 pt-[38%] text-foreground/30">
          <Heart className="size-2.5" />
          <MessageCircle className="size-2.5" />
          <Send className="size-2.5" />
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-0 h-[22%] border-t border-dashed border-foreground/25 bg-foreground/[0.04]" />
      <div className="absolute inset-x-[4%] inset-y-[6%] border border-dashed border-foreground/15" />
      <span className="absolute right-1.5 bottom-1 text-[8px] uppercase tracking-[0.14em] text-foreground/35">
        TikTok / Reels / Shorts safe zone
      </span>
    </div>
  );
}

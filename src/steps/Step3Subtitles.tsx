import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Heart,
  Languages,
  Loader2,
  MessageCircle,
  Monitor,
  ScanText,
  Send,
  ShieldCheck,
  Smartphone,
  SplitSquareHorizontal,
} from "lucide-react";
import { cn } from "cn";

import { SegmentedToggle } from "@/components/SegmentedToggle";
import { TimeFlow } from "@/components/TimeFlow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { verifyArabic } from "@/lib/api";
import { formatClock } from "@/lib/format";
import { toMediaSrc } from "@/lib/media";
import { buildProviderFor } from "@/lib/providers";
import type { FramingMode, Resolution, SubtitleCue } from "@/lib/projectTypes";
import {
  ASS_RESOLUTIONS,
  previewLineMetrics,
  resolveAssStyles,
  stylesOverlap,
} from "@/lib/subtitleStyles";
import { useProjectStore } from "@/store/projectStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";
import { wrapSubtitleText } from "@/lib/subtitleWrap";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Split a transcript segment into its Arabic and Thai halves. */
export function splitBilingual(text: string): { arabic: string; thai: string } {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return { arabic: "", thai: "" };

  const arabicRuns = clean.match(/[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]+/g) ?? [];
  const arabic = arabicRuns.join(" ").trim();
  const thai = clean.replace(/[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]+/g, " ").replace(/\s+/g, " ").trim();
  return { arabic, thai };
}

/* -------------------------------------------------------------------------- */
/* Preview                                                                     */
/* -------------------------------------------------------------------------- */

function SubtitlePreview({
  resolution,
  arabic,
  thai,
  safeZone,
  framing,
  sourcePath,
  clipStart,
  className,
}: {
  resolution: Resolution;
  arabic: string;
  thai: string;
  safeZone: boolean;
  framing: FramingMode;
  sourcePath: string | null;
  /** Absolute start of the selected clip in the source video (seconds). */
  clipStart: number;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const foregroundRef = useRef<HTMLVideoElement>(null);
  const backdropRef = useRef<HTMLVideoElement>(null);
  const [width, setWidth] = useState(360);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  const settings = useSettingsStore((state) => state);
  const styles = useMemo(
    () =>
      resolveAssStyles(
        resolution,
        {
          font: settings.arabic.fontFamily,
          size: settings.arabic.fontSize,
          primaryColor: settings.arabic.color,
          outline: settings.arabic.outlineWidth,
          outlineColor: settings.arabic.outlineColor,
          boxOpacity: settings.arabic.boxOpacity,
          bold: settings.arabic.bold,
          lineHeightPad: settings.arabic.lineHeightPad,
        },
        {
          font: settings.thai.fontFamily,
          size: settings.thai.fontSize,
          primaryColor: settings.thai.color,
          outline: settings.thai.outlineWidth,
          outlineColor: settings.thai.outlineColor,
          boxOpacity: settings.thai.boxOpacity,
          bold: settings.thai.bold,
          lineHeightPad: 1.2,
        },
      ),
    [resolution, settings.arabic, settings.thai],
  );

  const arabicMetrics = previewLineMetrics(styles.arabic, resolution, width);
  const thaiMetrics = previewLineMetrics(styles.thai, resolution, width);
  const scale = width / ASS_RESOLUTIONS[resolution].width;
  const portrait = ASS_RESOLUTIONS[resolution].height > ASS_RESOLUTIONS[resolution].width;
  // Framing only changes the 9:16 canvas; a 16:9 export never letterboxes.
  const effectiveFraming: FramingMode = portrait ? framing : "center-crop";

  const mediaSrc = toMediaSrc(sourcePath);

  /* Park both decoders on the first frame of the clip; the preview is a still. */
  useEffect(() => {
    if (!mediaSrc) return;
    const target = Math.max(0, clipStart + 0.05);
    const elements = [foregroundRef.current, backdropRef.current];
    for (const element of elements) {
      if (!element) continue;
      const seek = () => {
        try {
          element.currentTime = target;
        } catch {
          /* Metadata not ready yet; the loadedmetadata listener handles it. */
        }
        element.pause();
      };
      if (element.readyState >= 1) seek();
      else element.addEventListener("loadedmetadata", seek, { once: true });
    }
  }, [mediaSrc, clipStart]);

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
    metrics: ReturnType<typeof previewLineMetrics>,
    line: typeof styles.arabic,
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
  const boxStyle = (line: typeof styles.arabic, metrics: ReturnType<typeof previewLineMetrics>) =>
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
      ref={containerRef}
      aria-label="Subtitle preview"
      className={cn(
        "relative w-full overflow-hidden rounded-lg border border-border bg-black",
        portrait ? "aspect-[9/16]" : "aspect-video",
        className,
      )}
    >
      {mediaSrc ? (
        <>
          {effectiveFraming === "blur-fill" ? (
            <video
              ref={backdropRef}
              src={mediaSrc}
              aria-hidden
              muted
              playsInline
              preload="metadata"
              tabIndex={-1}
              className="pointer-events-none absolute inset-0 size-full scale-110 object-cover blur-2xl"
            />
          ) : null}
          <video
            ref={foregroundRef}
            src={mediaSrc}
            muted
            playsInline
            preload="metadata"
            tabIndex={-1}
            className={cn(
              "pointer-events-none absolute inset-0 size-full",
              effectiveFraming === "center-crop" ? "object-cover" : "object-contain",
            )}
          />
        </>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center">
          <ScanText className="size-4 text-muted-foreground/60" />
          <p className="max-w-[80%] text-[10px] leading-relaxed text-muted-foreground/60">
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
          className="absolute px-2 text-center whitespace-pre-line"
          style={lineStyle(arabicMetrics, styles.arabic, "arabic")}
        >
          <span style={boxStyle(styles.arabic, arabicMetrics)}>{arabic}</span>
        </p>
      ) : null}

      {thai ? (
        <p
          lang="th"
          className="absolute px-2 text-center whitespace-pre-line"
          style={lineStyle(thaiMetrics, styles.thai, "thai")}
        >
          <span style={boxStyle(styles.thai, thaiMetrics)}>{thai}</span>
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Step 3                                                                      */
/* -------------------------------------------------------------------------- */

export function Step3Subtitles() {
  const project = useProjectStore((state) => state.project);
  const setSubtitles = useProjectStore((state) => state.setSubtitles);
  const selectClip = useProjectStore((state) => state.selectClip);
  const setStep = useProjectStore((state) => state.setStep);
  const updateExportSettings = useProjectStore((state) => state.updateExportSettings);

  const arabicSettings = useSettingsStore((state) => state.arabic);
  const thaiSettings = useSettingsStore((state) => state.thai);
  const maxCharsPerLine = useSettingsStore((state) => state.editor.maxCharsPerLine);
  const language = useSettingsStore((state) => state.editor.language);

  const resolution: Resolution = project?.export.resolution ?? "1080x1920";
  const framing: FramingMode = project?.export.framing ?? "blur-fill";
  const portrait = resolution === "1080x1920";
  const [safeZone, setSafeZone] = useState(true);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [activeCueId, setActiveCueId] = useState<string | null>(null);

  const approvedClips = useMemo(
    () => (project?.clips ?? []).filter((clip) => clip.approved),
    [project?.clips],
  );
  const selectedClipId = project?.selectedClipId ?? approvedClips[0]?.id ?? null;
  const selectedClip = approvedClips.find((clip) => clip.id === selectedClipId) ?? null;
  const cues = project?.subtitles[selectedClipId ?? ""] ?? [];

  /* Seed the cue list from the transcript the first time a clip is opened. */
  useEffect(() => {
    if (!project || !selectedClip) return;
    if (project.subtitles[selectedClip.id]?.length) return;

    const segments = (project.transcript?.segments ?? []).filter(
      (segment) => segment.end > selectedClip.start && segment.start < selectedClip.end,
    );
    if (!segments.length) return;

    const seeded: SubtitleCue[] = segments.map((segment) => {
      const { arabic, thai } = splitBilingual(segment.text);
      const clipDuration = selectedClip.end - selectedClip.start;
      return {
        id: crypto.randomUUID(),
        start: Math.max(0, segment.start - selectedClip.start),
        // Clamp into the clip window: a segment straddling the cut must not
        // seed a cue that runs past the clip's end.
        end: Math.min(Math.max(0, segment.end - selectedClip.start), clipDuration),
        arabic,
        thai: wrapSubtitleText(thai, maxCharsPerLine),
      };
    });

    setSubtitles(selectedClip.id, seeded);
  }, [project, selectedClip, maxCharsPerLine, setSubtitles]);

  const activeCue = cues.find((cue) => cue.id === activeCueId) ?? cues[0] ?? null;

  const handleCueChange = useCallback(
    (cueId: string, field: "arabic" | "thai", value: string) => {
      if (!selectedClipId) return;
      // Store the raw value; Thai wraps on commit (blur/split), not on every
      // keystroke, so typing past the wrap width never jumps the caret.
      const next = cues.map((cue) =>
        cue.id === cueId ? { ...cue, [field]: value } : cue,
      );
      setSubtitles(selectedClipId, next);
    },
    [cues, selectedClipId, setSubtitles],
  );

  const handleCueBlur = useCallback(
    (cueId: string, field: "arabic" | "thai") => {
      if (!selectedClipId) return;
      const next = cues.map((cue) => {
        if (cue.id !== cueId) return cue;
        const wrapped =
          field === "thai" ? wrapSubtitleText(cue.thai, maxCharsPerLine) : cue.thai;
        return wrapped === cue.thai ? cue : { ...cue, thai: wrapped };
      });
      setSubtitles(selectedClipId, next);
    },
    [cues, maxCharsPerLine, selectedClipId, setSubtitles],
  );

  /**
   * Ctrl+Enter splits the cue *at the textarea caret*: the edited line is cut
   * exactly where the cursor sits, the other language line is cut at the same
   * relative position, and the time range is divided by the same ratio. Both
   * halves keep at least one character so no empty cue can be created.
   */
  const handleSplit = useCallback(
    (cueId: string, field: "arabic" | "thai", cursor: number) => {
      if (!selectedClipId) return;
      const cue = cues.find((item) => item.id === cueId);
      if (!cue) return;

      const edited = cue[field];
      const offset = Math.min(Math.max(cursor, 0), edited.length);
      if (offset <= 0 || offset >= edited.length) {
        toast.error("Click inside the line where you want to split it", {
          description: "Then press Ctrl + Enter.",
        });
        return;
      }

      const editedFirst = edited.slice(0, offset).trim();
      const editedSecond = edited.slice(offset).trim();
      if (!editedFirst || !editedSecond) {
        toast.error("Both halves need text", {
          description: "Move the cursor away from the edge of the line and try again.",
        });
        return;
      }

      const ratio = offset / edited.length;
      const other = field === "arabic" ? cue.thai : cue.arabic;
      const otherOffset = Math.round(other.length * ratio);
      const otherFirst = other.slice(0, otherOffset).trim();
      const otherSecond = other.slice(otherOffset).trim();

      const duration = cue.end - cue.start;
      if (duration < 0.2) {
        toast.error("This line is too short to split", {
          description: "Make the surrounding lines longer first.",
        });
        return;
      }
      const boundary = Math.min(
        cue.end - 0.05,
        Math.max(cue.start + 0.05, cue.start + duration * ratio),
      );

      const first: SubtitleCue = {
        ...cue,
        id: crypto.randomUUID(),
        end: boundary,
        arabic: field === "arabic" ? editedFirst : otherFirst,
        thai:
          field === "thai"
            ? wrapSubtitleText(editedFirst, maxCharsPerLine)
            : wrapSubtitleText(otherFirst, maxCharsPerLine),
      };
      const second: SubtitleCue = {
        ...cue,
        id: crypto.randomUUID(),
        start: boundary,
        arabic: field === "arabic" ? editedSecond : otherSecond,
        thai:
          field === "thai"
            ? wrapSubtitleText(editedSecond, maxCharsPerLine)
            : wrapSubtitleText(otherSecond, maxCharsPerLine),
      };

      const index = cues.findIndex((item) => item.id === cueId);
      const next = [...cues];
      next.splice(index, 1, first, second);
      setSubtitles(selectedClipId, next);
      setActiveCueId(second.id);
      toast.success("Line split", {
        description: `Split at ${formatClock(boundary - cue.start, true)} into the line · ${editedFirst.length} / ${editedSecond.length} characters.`,
      });
    },
    [cues, maxCharsPerLine, selectedClipId, setSubtitles],
  );

  const handleVerify = useCallback(
    async (cue: SubtitleCue) => {
      const arabicText = cue.arabic.trim();
      if (!arabicText) {
        toast.error("Nothing to verify", {
          description: "This cue has no Arabic text.",
        });
        return;
      }
      const settings = useSettingsStore.getState();
      if (settings.analysisMode === "cloud" && !settings.cloud.fastTextModel) {
        toast.error("The Arabic checker isn't connected yet", {
          description: "Choose a model in Settings → 3 · Subtitles.",
          action: {
            label: "Set up",
            onClick: () => useUiStore.getState().openSettings("stage3"),
          },
        });
        return;
      }

      setVerifying(cue.id);
      try {
        const result = await verifyArabic({
          arabic_text: arabicText,
          context_thai: cue.thai.replace(/\n/g, " "),
          provider: buildProviderFor(settings, "fast"),
        });

        if (!selectedClipId) return;
        const next = cues.map((item) =>
          item.id === cue.id ? { ...item, arabic: result.verified_text || item.arabic } : item,
        );
        setSubtitles(selectedClipId, next);

        if (result.correction_applied) {
          toast.success("Arabic corrected", {
            description: result.notes || "The Uthmani spelling was updated.",
          });
        } else {
          toast.success("Arabic verified", {
            description: result.notes || "The spelling and Harakat match the source.",
          });
        }
      } catch (error) {
        toast.error("Verification failed", {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setVerifying(null);
      }
    },
    [cues, selectedClipId, setSubtitles],
  );

  const styles = useMemo(
    () =>
      resolveAssStyles(
        resolution,
        {
          font: arabicSettings.fontFamily,
          size: arabicSettings.fontSize,
          primaryColor: arabicSettings.color,
          outline: arabicSettings.outlineWidth,
          outlineColor: arabicSettings.outlineColor,
          boxOpacity: arabicSettings.boxOpacity,
          bold: arabicSettings.bold,
          lineHeightPad: arabicSettings.lineHeightPad,
        },
        {
          font: thaiSettings.fontFamily,
          size: thaiSettings.fontSize,
          primaryColor: thaiSettings.color,
          outline: thaiSettings.outlineWidth,
          outlineColor: thaiSettings.outlineColor,
          boxOpacity: thaiSettings.boxOpacity,
          bold: thaiSettings.bold,
          lineHeightPad: 1.2,
        },
      ),
    [resolution, arabicSettings, thaiSettings],
  );
  const overlap = stylesOverlap(styles.arabic, styles.thai);

  if (!project) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
        <Languages className="size-5 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">No project open</p>
        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
          Create or resume a lecture on Step 1 before editing subtitles.
        </p>
      </div>
    );
  }

  if (!approvedClips.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
        <Languages className="size-5 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">No approved clips</p>
        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
          Approve clips in Step 2 first — each approved clip gets its own bilingual subtitle track.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border px-4 py-3">
        <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          Step 3 of 4 · Bilingual subtitle studio
        </p>
        <div className="mt-0.5 flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-base font-medium text-foreground">Subtitles</h1>
          <Badge variant="outline" className="text-[10px]">
            {cues.length} line{cues.length === 1 ? "" : "s"} · {language.toUpperCase()}
          </Badge>
        </div>

        <Tabs
          value={selectedClipId ?? undefined}
          onValueChange={(value) => selectClip(value)}
          className="mt-2"
        >
          <TabsList variant="line" className="h-9 w-max max-w-full justify-start gap-1 overflow-x-auto px-0">
            {approvedClips.map((clip, index) => (
              <TabsTrigger key={clip.id} value={clip.id} className="gap-1.5 px-2.5 text-xs">
                <span className="text-[10px] tabular-nums text-muted-foreground">{index + 1}</span>
                <span className="max-w-[160px] truncate">{clip.title}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(320px,400px)]">
        {/* ------------------------------ editor ------------------------------ */}
        <section className="flex min-h-0 flex-col border-r border-border">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <div className="flex items-center gap-2">
              <h2 className="text-[13px] font-medium text-foreground">Subtitle lines</h2>
              <span className="text-[11px] text-muted-foreground">
                Thai + Arabic, {maxCharsPerLine} chars per line
              </span>
            </div>
            <span className="text-[10px] text-muted-foreground">Ctrl + Enter splits a line at the cursor</span>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-2 px-3 py-3">
              {cues.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
                  <ScanText className="size-5 text-muted-foreground" />
                  <p className="text-xs font-medium text-foreground">No subtitle lines for this clip</p>
                  <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
                    The transcript has no speech inside this clip. Widen the cut in Step 2 so the
                    speech is covered.
                  </p>
                </div>
              ) : null}

              {cues.map((cue) => {
                const active = cue.id === activeCue?.id;
                const hasArabic = cue.arabic.trim().length > 0;
                return (
                  <div
                    key={cue.id}
                    data-active={active ? "true" : undefined}
                    onClick={() => setActiveCueId(cue.id)}
                    onFocus={() => setActiveCueId(cue.id)}
                    className={cn(
                      "rounded-lg border px-3 py-2.5 transition-colors",
                      active
                        ? "border-ring/50 bg-accent/20"
                        : "border-border bg-card/40 hover:bg-accent/10",
                    )}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span
                        aria-label={`${formatClock(cue.start, true)} to ${formatClock(
                          cue.end,
                          true,
                        )}`}
                        className="flex items-baseline gap-1 font-mono text-[11px] tabular-nums text-muted-foreground"
                      >
                        <TimeFlow value={cue.start} hundredths />
                        <span aria-hidden>→</span>
                        <TimeFlow value={cue.end} hundredths />
                      </span>
                      <div className="flex items-center gap-1.5">
                        {hasArabic ? (
                          <Badge variant="outline" className="text-[9px]">
                            Arabic
                          </Badge>
                        ) : null}
                        <Button
                          variant="outline"
                          size="xs"
                          className="gap-1"
                          disabled={!hasArabic || verifying === cue.id}
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleVerify(cue);
                          }}
                        >
                          {verifying === cue.id ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <ShieldCheck className="size-3" />
                          )}
                          Verify Quran / Fix Arabic
                        </Button>
                      </div>
                    </div>

                    <div className="mt-2 grid gap-2">
                      <Textarea
                        value={cue.arabic}
                        onChange={(event) => handleCueChange(cue.id, "arabic", event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                            event.preventDefault();
                            handleSplit(cue.id, "arabic", event.currentTarget.selectionStart);
                          }
                        }}
                        rows={2}
                        dir="rtl"
                        lang="ar"
                        spellCheck={false}
                        placeholder="Arabic Quran / Hadith line (optional)"
                        className="resize-y text-right font-arabic text-base leading-relaxed"
                      />
                      <Textarea
                        value={cue.thai}
                        onChange={(event) => handleCueChange(cue.id, "thai", event.target.value)}
                        onBlur={() => handleCueBlur(cue.id, "thai")}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                            event.preventDefault();
                            handleSplit(cue.id, "thai", event.currentTarget.selectionStart);
                          }
                        }}
                        rows={2}
                        lang="th"
                        placeholder="Thai explanation"
                        className="resize-y text-sm leading-relaxed"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </section>

        {/* ------------------------------ preview ----------------------------- */}
        <section className="flex min-h-0 flex-col overflow-y-auto">
          <div className="space-y-3 px-4 py-4">
            <div className="space-y-1.5">
              <Label className="text-[13px] font-medium text-foreground">Aspect ratio</Label>
              <SegmentedToggle<Resolution>
                label="Preview aspect ratio"
                value={resolution}
                options={[
                  { value: "1080x1920", label: "9:16 Vertical" },
                  { value: "1920x1080", label: "16:9 Widescreen" },
                ]}
                onChange={(value) => updateExportSettings({ resolution: value })}
              />
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                The export step uses this resolution, so the preview matches the burned-in file.
              </p>
            </div>

            {portrait ? (
              <div className="space-y-1.5">
                <Label className="text-[13px] font-medium text-foreground">9:16 framing</Label>
                <SegmentedToggle<FramingMode>
                  label="Framing mode"
                  value={framing}
                  options={[
                    { value: "blur-fill", label: "Blur fill" },
                    { value: "center-crop", label: "Center crop" },
                  ]}
                  onChange={(value) => updateExportSettings({ framing: value })}
                />
                <p className="text-[10px] leading-relaxed text-muted-foreground">
                  Blur fill pads the 9:16 frame with a blurred copy; center crop cuts to the
                  middle. The exported video uses this framing.
                </p>
              </div>
            ) : (
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                16:9 output uses the whole frame, so 9:16 framing does not apply.
              </p>
            )}

            <SubtitlePreview
              resolution={resolution}
              arabic={activeCue?.arabic ?? ""}
              thai={activeCue?.thai ?? ""}
              safeZone={safeZone}
              framing={framing}
              sourcePath={project.sourcePath}
              clipStart={selectedClip?.start ?? 0}
              className="mx-auto max-w-[300px]"
            />

            <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-card/40 px-3 py-2.5">
              <div className="space-y-0.5">
                <p className="text-xs font-medium text-foreground">Platform safe-zone overlay</p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Shows the TikTok / Reels / Shorts action rail and caption block. Hidden in 16:9,
                  where no platform UI overlays the frame.
                </p>
              </div>
              <Switch
                checked={safeZone}
                onCheckedChange={setSafeZone}
                disabled={!portrait}
                aria-label="Toggle platform safe-zone overlay"
              />
            </div>

            <Collapsible className="rounded-md border border-border bg-card/40">
              <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left">
                <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <SplitSquareHorizontal className="size-3.5" />
                  Burned-in styles
                </span>
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-1.5 px-3 pb-2.5">
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] tabular-nums text-muted-foreground">
                  <dt>Arabic</dt>
                  <dd className="truncate text-foreground/80">
                    {styles.arabic.font} · {styles.arabic.size}px · bottom margin{" "}
                    {styles.arabic.marginV}
                  </dd>
                  <dt>Thai</dt>
                  <dd className="truncate text-foreground/80">
                    {styles.thai.font} · {styles.thai.size}px · bottom margin {styles.thai.marginV}
                  </dd>
                </dl>
                {overlap.overlaps ? (
                  <p className="flex items-start gap-1.5 text-xs leading-relaxed text-status-warning">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    The Arabic and Thai lines overlap by {Math.abs(Math.round(overlap.gap))} px.
                    Adjust the sizes in Settings → 3 · Subtitles.
                  </p>
                ) : (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground/80">
                    <CheckCircle2 className="size-3" />
                    Lines are {Math.round(overlap.gap)} px apart in the burned-in file.
                  </p>
                )}
              </CollapsibleContent>
            </Collapsible>

            <p className="text-xs leading-relaxed text-muted-foreground">
              Times are shown relative to the start of the clip.
            </p>
          </div>
        </section>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border bg-card/20 px-4 py-2.5">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Monitor className="size-3.5" />
          {selectedClip ? selectedClip.title : "Select a clip"}
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => setStep(2)}>
            Back to clip discovery
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            disabled={cues.length === 0}
            onClick={() => setStep(4)}
          >
            <Smartphone className="size-3.5" />
            Continue to export
          </Button>
        </div>
      </footer>
    </div>
  );
}

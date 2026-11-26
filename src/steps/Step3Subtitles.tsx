import { L } from "@/lib/i18n";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import NumberFlow from "@number-flow/react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Languages,
  Loader2,
  Maximize2,
  Merge,
  Minimize2,
  Monitor,
  Pause,
  Play,
  Plus,
  RefreshCw,
  ScanText,
  Scissors,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Trash2,
  Type,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { cn } from "cn";

import { AiActivityLine } from "@/components/AiActivityLine";
import { SegmentedToggle } from "@/components/SegmentedToggle";
import { TimeFlow } from "@/components/TimeFlow";
import { CueRibbon } from "@/components/subtitles/CueRibbon";
import { SubtitleMonitor, type SubtitleMonitorHandle } from "@/components/subtitles/SubtitleMonitor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { presetMatchesStyle } from "@/components/config/shared";
import { verifyArabic, verifyArabicBatch } from "@/lib/api";
import { formatClock } from "@/lib/format";
import { FRAMING_LABELS, type FramingMode, type Resolution, type SubtitleCue } from "@/lib/projectTypes";
import {
  nudgeVerticalOffset,
  resolveAssStyles,
  stylesOverlap,
  type SubtitleLine,
} from "@/lib/subtitleStyles";
import { buildCuesFromTranscript, looksLikeFragmentSeed } from "@/lib/subtitleCues";
import { useAiActivityStore } from "@/store/aiActivityStore";
import { deliverTaskResult, useJobStore, useTaskJob } from "@/store/jobStore";
import { useProjectStore } from "@/store/projectStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";
import { splitAtWordBoundary, wrapArabicText, wrapSubtitleText } from "@/lib/subtitleWrap";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

type CueField = "arabic" | "thai";

/** Playback-rate ladder for the J/K/L shuttle (1× = normal speed). */
const SHUTTLE_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hasText(cue: SubtitleCue): boolean {
  return cue.arabic.trim().length > 0 || cue.thai.trim().length > 0;
}

interface SubtitleCueRowProps {
  cue: SubtitleCue;
  index: number;
  active: boolean;
  hasFollowing: boolean;
  canPlay: boolean;
  verifyingThis: boolean;
  verifyAll: boolean;
  onPlayCue: (cue: SubtitleCue) => void;
  onSelectCue: (cue: SubtitleCue) => void;
  onToggleReviewed: (cue: SubtitleCue) => void;
  onCueChange: (cueId: string, field: CueField, value: string) => void;
  onCueBlur: (cueId: string, field: CueField) => void;
  onSelectCaret: (cueId: string, field: CueField, offset: number) => void;
  onSplitAt: (cueId: string, field: CueField, offset: number) => void;
  onVerify: (cue: SubtitleCue) => void;
  onSplitCue: (cue: SubtitleCue) => void;
  onMerge: (cueId: string) => void;
  onDelete: (cueId: string) => void;
}

const SubtitleCueRow = memo(function SubtitleCueRow({
  cue,
  index,
  active,
  hasFollowing,
  canPlay,
  verifyingThis,
  verifyAll,
  onPlayCue,
  onSelectCue,
  onToggleReviewed,
  onCueChange,
  onCueBlur,
  onSelectCaret,
  onSplitAt,
  onVerify,
  onSplitCue,
  onMerge,
  onDelete,
}: SubtitleCueRowProps) {
  return (
    <div
      data-cue-row={cue.id}
      className={cn(
        "min-w-0 overflow-hidden rounded-lg border transition-colors",
        active
          ? "border-ring/50 bg-accent/20"
          : "border-border bg-card/40 hover:bg-accent/10",
      )}
    >
      <div className="flex items-start gap-1 px-1.5 py-1.5">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Play line ${index + 1}`}
          disabled={!canPlay}
          onClick={() => onPlayCue(cue)}
          className="mt-0.5"
        >
          <Play className="size-3" />
        </Button>

        <div
          role="button"
          tabIndex={0}
          aria-expanded={active}
          aria-label={`Subtitle line ${index + 1}`}
          onClick={() => onSelectCue(cue)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelectCue(cue);
            }
          }}
          className="min-w-0 flex-1 cursor-default rounded-sm px-1 py-0.5 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
        >
          <div className="flex items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground">
            <span className="font-mono">
              <TimeFlow value={cue.start} tenths />
              <span aria-hidden> → </span>
              <TimeFlow value={cue.end} tenths />
            </span>
            <span className="text-muted-foreground/50">·</span>
            <NumberFlow
              value={cue.end - cue.start}
              suffix="s"
              format={{ maximumFractionDigits: 1 }}
            />
          </div>
          <p
            dir={cue.arabic ? "rtl" : undefined}
            className={cn(
              "mt-0.5 line-clamp-2 whitespace-pre-line text-sm leading-snug",
              cue.arabic ? "font-arabic text-foreground/90" : "text-muted-foreground/50",
            )}
          >
            {cue.arabic || L("No Arabic line")}
          </p>
          <p
            lang="th"
            className={cn(
              "line-clamp-2 text-xs leading-snug",
              cue.thai ? "text-foreground/90" : "text-muted-foreground/60",
            )}
          >
            {cue.thai.replace(/\n/g, " ") || L("No Thai line")}
          </p>
        </div>

        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={cue.reviewed ? "Mark as not checked" : "Mark as checked"}
          aria-pressed={cue.reviewed}
          disabled={!hasText(cue)}
          onClick={() => onToggleReviewed(cue)}
          className={cn(
            "mt-0.5",
            cue.reviewed ? "text-foreground/80" : "text-muted-foreground/50",
          )}
        >
          {cue.reviewed ? <CheckCircle2 className="size-4" /> : <Circle className="size-4" />}
        </Button>
      </div>

      {active ? (
        <div className="space-y-2 border-t border-border/70 px-2.5 py-2">
          <Textarea
            value={cue.arabic}
            onChange={(event) => onCueChange(cue.id, "arabic", event.target.value)}
            onBlur={() => onCueBlur(cue.id, "arabic")}
            onSelect={(event) =>
              onSelectCaret(cue.id, "arabic", event.currentTarget.selectionStart)
            }
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                onSplitAt(cue.id, "arabic", event.currentTarget.selectionStart);
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
            onChange={(event) => onCueChange(cue.id, "thai", event.target.value)}
            onBlur={() => onCueBlur(cue.id, "thai")}
            onSelect={(event) =>
              onSelectCaret(cue.id, "thai", event.currentTarget.selectionStart)
            }
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                onSplitAt(cue.id, "thai", event.currentTarget.selectionStart);
              }
            }}
            rows={2}
            lang="th"
            placeholder="Thai explanation"
            className="resize-y text-sm leading-relaxed"
          />
          <div className="flex flex-wrap items-center gap-1">
            <Button
              size="xs"
              variant="outline"
              className="gap-1"
              disabled={!canPlay}
              onClick={() => onPlayCue(cue)}
            >
              <Play className="size-3" />
              {L("Play")}
            </Button>
            {cue.arabic.trim() ? (
              <Button
                size="xs"
                variant="outline"
                className="gap-1"
                disabled={verifyingThis || verifyAll}
                title="Verify Quran / Fix Arabic"
                onClick={() => void onVerify(cue)}
              >
                {verifyingThis ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <ShieldCheck className="size-3" />
                )}
                {L("Check Arabic")}
              </Button>
            ) : null}
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Split line at the cursor"
              title="Split line at the cursor (Ctrl + Enter)"
              onClick={() => onSplitCue(cue)}
            >
              <Scissors className="size-3" />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Merge with the next line"
              title="Merge with the next line"
              disabled={!hasFollowing}
              onClick={() => onMerge(cue.id)}
            >
              <Merge className="size-3" />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              className="ml-auto text-destructive"
              title="Delete this line"
              aria-label={`Delete line ${index + 1}`}
              onClick={() => onDelete(cue.id)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Ctrl + Enter splits at the cursor · Space plays the line.
          </p>
        </div>
      ) : null}
    </div>
  );
});

function arabicSourceLabel(cue: SubtitleCue): string {
  if (cue.source === "quran") {
    return cue.reference ? `Qur'an ${cue.reference}` : "Qur'an (verified)";
  }
  if (cue.source === "hadith") return "Hadith · AI-suggested";
  if (cue.source === "quote") return "Arabic quote · AI-suggested";
  return "Arabic recitation";
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
  const updateArabic = useSettingsStore((state) => state.updateArabic);
  const updateThai = useSettingsStore((state) => state.updateThai);
  const maxCharsPerLine = useSettingsStore((state) => state.editor.maxCharsPerLine);
  const maxLines = useSettingsStore((state) => state.editor.subtitleMaxLines);
  const language = useSettingsStore((state) => state.editor.language);
  const presets = useSettingsStore((state) => state.presets);
  const activePresetId = useSettingsStore((state) => state.activePresetId);
  const applyPreset = useSettingsStore((state) => state.applyPreset);

  const openConfig = useUiStore((state) => state.openConfig);
  const aiEntries = useAiActivityStore((state) => state.entries);
  const activeArabicCheck =
    aiEntries.find((entry) => entry.task === "arabic-check" && entry.status === "running") ??
    aiEntries.find((entry) => entry.task === "arabic-check");

  const monitorRef = useRef<SubtitleMonitorHandle>(null);
  const queueRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<{ cueId: string; field: CueField; offset: number } | null>(null);
  const healedSeedRef = useRef<string | null>(null);
  const seekKeyRef = useRef<string | null>(null);

  const [activeCueId, setActiveCueId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "unchecked">("all");
  const [safeZone, setSafeZone] = useState(true);
  const [previewFocus, setPreviewFocus] = useState(false);
  const [styleOpen, setStyleOpen] = useState(false);
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [arabicReviewOpen, setArabicReviewOpen] = useState(false);
  const [rebuildHint, setRebuildHint] = useState(false);
  const [muted, setMuted] = useState(false);
  const [verifying, setVerifying] = useState<string | null>(null);
  // The batch owns its job, so leaving Step 3 no longer stops the check; only
  // the explicit Stop button (or starting a new run) cancels it.
  const verifyJob = useTaskJob("verify", project?.id ?? null);
  const verifyAll = verifyJob?.status === "running" ? verifyJob.progress : null;
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);

  const resolution: Resolution = project?.export.resolution ?? "1080x1920";
  const framing: FramingMode = project?.export.framing ?? "blur-fill";
  const portrait = resolution === "1080x1920";

  const approvedClips = useMemo(
    () => (project?.clips ?? []).filter((clip) => clip.approved),
    [project?.clips],
  );
  const selectedClip =
    approvedClips.find((clip) => clip.id === project?.selectedClipId) ??
    approvedClips[0] ??
    null;
  const selectedClipId = selectedClip?.id ?? null;
  const cues = project?.subtitles[selectedClipId ?? ""] ?? [];
  const clipStart = selectedClip?.start ?? 0;
  const clipDuration = selectedClip ? selectedClip.end - selectedClip.start : 0;
  const canPlay = Boolean(project?.sourcePath);

  const activeCue = cues.find((cue) => cue.id === activeCueId) ?? cues[0] ?? null;
  const activeCueKey = activeCue?.id ?? null;
  const arabicMaxCharsPerLine = Math.max(
    16,
    Math.round(maxCharsPerLine * (thaiSettings.fontSize / Math.max(1, arabicSettings.fontSize))),
  );

  const checkedCount = cues.filter((cue) => cue.reviewed).length;
  const arabicCount = cues.filter((cue) => cue.arabic.trim().length > 0).length;
  const visibleCues = useMemo(
    () => cues.map((cue, index) => ({ cue, index })).filter(({ cue }) => filter === "all" || !cue.reviewed),
    [cues, filter],
  );
  const arabicPassages = useMemo(
    () =>
      cues.filter(
        (cue) => cue.arabic.trim() && !cue.thai.trim() && (cue.source || cue.originalText),
      ),
    [cues],
  );
  const verifiedArabicCount = arabicPassages.filter((cue) => cue.source === "quran").length;
  const unreviewedArabicCount = arabicPassages.filter((cue) => !cue.reviewed).length;

  /* Seed the cue list from the transcript the first time a clip is opened.
     Raw transcript segments are not subtitle lines: rebuild them into readable
     lines, and auto-heal a track saved by the old one-cue-per-segment seeding. */
  useEffect(() => {
    const current = useProjectStore.getState().project;
    if (!current || !selectedClip) return;
    const segments = current.transcript?.segments ?? [];
    if (!segments.length) return;

    const existing = current.subtitles[selectedClip.id] ?? [];
    if (existing.length) {
      if (looksLikeFragmentSeed(existing)) {
        const key = `${selectedClip.id}:${existing.length}`;
        if (healedSeedRef.current !== key) {
          healedSeedRef.current = key;
          const rebuilt = buildCuesFromTranscript(segments, {
            clipStart: selectedClip.start,
            clipEnd: selectedClip.end,
            maxCharsPerLine,
            maxLines,
            arabicMaxCharsPerLine,
          });
          if (rebuilt.length) {
            const flatten = (list: SubtitleCue[]) =>
              list
                .map((cue) => `${cue.arabic}${cue.thai}`)
                .join("")
                .replace(/\s+/g, "");
            // Only replace an untouched transcript seed; a manual edit keeps
            // the track and surfaces the Rebuild banner instead.
            if (flatten(existing) === flatten(rebuilt)) {
              setSubtitles(selectedClip.id, rebuilt);
              toast("Subtitle lines rebuilt", {
                description: `Merged ${existing.length} transcript fragments into ${rebuilt.length} readable line${
                  rebuilt.length === 1 ? "" : "s"
                }.`,
              });
            }
          }
        }
      }
      return;
    }

    const seeded = buildCuesFromTranscript(segments, {
      clipStart: selectedClip.start,
      clipEnd: selectedClip.end,
      maxCharsPerLine,
      maxLines,
      arabicMaxCharsPerLine,
    });
    if (seeded.length) setSubtitles(selectedClip.id, seeded);
  }, [
    project?.id,
    project?.transcriptId,
    project?.transcript,
    selectedClip,
    maxCharsPerLine,
    maxLines,
    arabicMaxCharsPerLine,
    setSubtitles,
  ]);

  /**
   * Detect a saved track that was generated before word-safe cuts (or by a
   * different rule) even when it no longer looks like a sliver seed: the cue
   * text still matches the transcript, but the cue boundaries do not match the
   * word-stream rebuild. Offer Rebuild instead of silently replacing it.
   */
  useEffect(() => {
    if (!selectedClip) {
      setRebuildHint(false);
      return;
    }
    const current = useProjectStore.getState().project;
    const existing = current?.subtitles[selectedClip.id] ?? [];
    const segments = current?.transcript?.segments ?? [];
    if (!existing.length || !segments.length || existing.some((cue) => cue.reviewed)) {
      setRebuildHint(false);
      return;
    }
    if (looksLikeFragmentSeed(existing)) {
      // The auto-heal above owns this case.
      setRebuildHint(false);
      return;
    }
    const rebuilt = buildCuesFromTranscript(segments, {
      clipStart: selectedClip.start,
      clipEnd: selectedClip.end,
      maxCharsPerLine,
      maxLines,
      arabicMaxCharsPerLine,
    });
    if (!rebuilt.length) {
      setRebuildHint(false);
      return;
    }
    const flatten = (list: SubtitleCue[]) =>
      list
        .map((cue) => `${cue.arabic}${cue.thai}`)
        .join("")
        .replace(/\s+/g, "");
    if (flatten(existing) !== flatten(rebuilt)) {
      // The editor has changed words; never suggest replacing their text.
      setRebuildHint(false);
      return;
    }
    const normalize = (value: string) => value.replace(/\s+/g, "");
    const sameSegmentation =
      existing.length === rebuilt.length &&
      existing.every(
        (cue, index) =>
          normalize(cue.thai) === normalize(rebuilt[index].thai) &&
          normalize(cue.arabic) === normalize(rebuilt[index].arabic),
      );
    setRebuildHint(!sameSegmentation);
  }, [
    maxCharsPerLine,
    maxLines,
    arabicMaxCharsPerLine,
    project?.transcript,
    selectedClip,
    selectedClipId,
  ]);

  /** Explicit rebuild from the Rebuild banner (may overwrite manual edits). */
  const handleRebuild = useCallback(() => {
    if (!selectedClip) return;
    const segments = project?.transcript?.segments ?? [];
    if (!segments.length) return;
    const rebuilt = buildCuesFromTranscript(segments, {
      clipStart: selectedClip.start,
      clipEnd: selectedClip.end,
      maxCharsPerLine,
      maxLines,
      arabicMaxCharsPerLine,
    });
    if (!rebuilt.length) return;
    setSubtitles(selectedClip.id, rebuilt);
    healedSeedRef.current = `${selectedClip.id}:${rebuilt.length}`;
    setRebuildHint(false);
    setActiveCueId(null);
    toast.success("Subtitle lines rebuilt", {
      description: `${rebuilt.length} readable line${rebuilt.length === 1 ? "" : "s"} from the transcript.`,
    });
  }, [
    maxCharsPerLine,
    maxLines,
    arabicMaxCharsPerLine,
    project?.transcript?.segments,
    selectedClip,
    setSubtitles,
  ]);

  /** Mark every corpus-verified Qur'an passage in this clip as reviewed. */
  const approveAllVerifiedArabic = () => {
    if (!selectedClipId) return;
    const latest = useProjectStore.getState().project?.subtitles[selectedClipId] ?? [];
    const verified = latest.filter((cue) => cue.source === "quran" && !cue.reviewed);
    if (!verified.length) return;
    setSubtitles(
      selectedClipId,
      latest.map((cue) =>
        cue.source === "quran" ? { ...cue, reviewed: true } : cue,
      ),
    );
    toast.success("Qur'an passages approved", {
      description: `${verified.length} verified line${verified.length === 1 ? "" : "s"} marked as reviewed.`,
    });
  };

  /** Put the original Thai transliteration back for a misdetected passage. */
  const restoreArabicPassage = (cueId: string) => {
    if (!selectedClipId) return;
    const latest = useProjectStore.getState().project?.subtitles[selectedClipId] ?? [];
    const cue = latest.find((item) => item.id === cueId);
    if (!cue) return;
    // Restoring without a saved original would set both languages to "" and
    // erase the line for good. Refuse instead of destroying the editor's text.
    const original = cue.originalText?.trim() ?? "";
    if (!original) {
      toast.error("Cannot restore this line", {
        description:
          "The original Thai text was not saved for this line. Build the subtitles for this clip again to recover it.",
      });
      return;
    }
    setRebuildHint(false);
    setSubtitles(
      selectedClipId,
      latest.map((item) =>
        item.id === cueId
          ? {
              ...item,
              arabic: "",
              thai: original,
              source: undefined,
              reference: undefined,
              confidence: undefined,
              originalText: undefined,
              translation: undefined,
              reviewed: false,
            }
          : item,
      ),
    );
    toast(L("Original Thai line restored"), {
      description: original.slice(0, 80),
    });
  };

  /* Reset the transport when the editor moves to another clip. */
  useEffect(() => {
    setActiveCueId(null);
    setPlayhead(0);
    setPlaying(false);
    setRate(1);
    monitorRef.current?.pause();
    monitorRef.current?.setPlaybackRate(1);
  }, [selectedClipId]);

  /* Park the monitor on the first line (or the clip's first frame) once the
     cue list for this clip is known. Editing text does not re-seek: the key is
     the clip plus its first cue id. */
  useEffect(() => {
    if (!selectedClip) return;
    const key = `${selectedClip.id}:${cues[0]?.id ?? "empty"}`;
    if (seekKeyRef.current === key) return;
    seekKeyRef.current = key;
    monitorRef.current?.seekTo(selectedClip.start + (cues[0]?.start ?? 0) + 0.05);
    setPlayhead(cues[0]?.start ?? 0);
  }, [selectedClip, cues]);

  /* Keep the active clip chip in view in the queue. */
  useEffect(() => {
    if (!selectedClipId) return;
    const element = queueRef.current?.querySelector<HTMLElement>(
      `[data-clip-id="${selectedClipId}"]`,
    );
    element?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedClipId]);

  /* Keep the active line in view when it is chosen from the ribbon or keyboard. */
  useEffect(() => {
    if (!activeCueKey) return;
    const element = listRef.current?.querySelector<HTMLElement>(
      `[data-cue-row="${activeCueKey}"]`,
    );
    element?.scrollIntoView({ block: "nearest" });
  }, [activeCueKey]);

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
          verticalOffset: arabicSettings.verticalOffset,
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
          verticalOffset: thaiSettings.verticalOffset,
        },
      ),
    [resolution, arabicSettings, thaiSettings],
  );
  const overlap = stylesOverlap(styles.arabic, styles.thai);

  /** Drag/arrow positioning writes the same style fields the preset captures. */
  const nudgeMonitorLine = (kind: SubtitleLine, delta: number) => {
    const state = useSettingsStore.getState();
    if (kind === "arabic") {
      updateArabic({
        verticalOffset: nudgeVerticalOffset(
          "arabic",
          resolution,
          state.arabic.verticalOffset,
          delta,
        ),
      });
    } else {
      updateThai({
        verticalOffset: nudgeVerticalOffset("thai", resolution, state.thai.verticalOffset, delta),
      });
    }
  };

  const activePreset = presets.find((preset) => preset.id === activePresetId) ?? null;
  const presetModified = activePreset
    ? !presetMatchesStyle(activePreset, arabicSettings, thaiSettings)
    : false;

  /* ------------------------------ transport ------------------------------ */

  const handleMonitorTime = useCallback(
    (seconds: number) => {
      setPlayhead(clamp(seconds - clipStart, 0, Math.max(0, clipDuration)));
    },
    [clipDuration, clipStart],
  );

  const playCue = useCallback(
    (cue: SubtitleCue) => {
      setActiveCueId(cue.id);
      if (!selectedClip) return;
      monitorRef.current?.playRange(selectedClip.start + cue.start, selectedClip.start + cue.end);
    },
    [selectedClip],
  );

  const selectCue = useCallback(
    (cue: SubtitleCue) => {
      setActiveCueId(cue.id);
      if (!selectedClip) return;
      monitorRef.current?.pause();
      monitorRef.current?.seekTo(selectedClip.start + cue.start + 0.02);
      setPlayhead(cue.start + 0.02);
    },
    [selectedClip],
  );

  const togglePlay = useCallback(() => {
    if (playing) {
      monitorRef.current?.pause();
      return;
    }
    if (activeCue) playCue(activeCue);
  }, [activeCue, playCue, playing]);

  const applyRate = useCallback((next: number) => {
    setRate(next);
    monitorRef.current?.setPlaybackRate(next);
  }, []);

  const shuttle = useCallback(
    (direction: -1 | 1) => {
      const current = monitorRef.current?.getPlaybackRate() ?? rate;
      if (direction === 1) {
        if (activeCue) playCue(activeCue);
        const faster =
          SHUTTLE_RATES.find((entry) => entry > current + 0.001) ??
          SHUTTLE_RATES[SHUTTLE_RATES.length - 1];
        applyRate(faster);
        return;
      }
      const slower = [...SHUTTLE_RATES].reverse().find((entry) => entry < current - 0.001);
      if (slower === undefined) {
        monitorRef.current?.seekBy(-2);
        return;
      }
      if (activeCue) playCue(activeCue);
      applyRate(slower);
    },
    [activeCue, applyRate, playCue, rate],
  );

  const pauseShuttle = useCallback(() => {
    monitorRef.current?.pause();
    applyRate(1);
  }, [applyRate]);

  const moveCue = useCallback(
    (direction: -1 | 1) => {
      const index = cues.findIndex((cue) => cue.id === activeCue?.id);
      const target = index < 0 ? cues[0] : cues[index + direction];
      if (target) selectCue(target);
    },
    [activeCue?.id, cues, selectCue],
  );

  /* ------------------------------ editing ------------------------------- */

  const handleCueChange = useCallback(
    (cueId: string, field: CueField, value: string) => {
      if (!selectedClipId) return;
      setRebuildHint(false);
      // Store the raw value; Thai wraps on commit (blur/split), not on every
      // keystroke, so typing past the wrap width never jumps the caret.
      const latest = useProjectStore.getState().project?.subtitles[selectedClipId] ?? [];
      const next = latest.map((cue) =>
        cue.id === cueId ? { ...cue, [field]: value, reviewed: false } : cue,
      );
      setSubtitles(selectedClipId, next);
    },
    [selectedClipId, setSubtitles],
  );

  const handleCueBlur = useCallback(
    (cueId: string, field: CueField) => {
      if (!selectedClipId) return;
      const latest = useProjectStore.getState().project?.subtitles[selectedClipId] ?? [];
      const next = latest.map((cue) => {
        if (cue.id !== cueId) return cue;
        if (field === "thai") {
          const wrapped = wrapSubtitleText(cue.thai, maxCharsPerLine);
          return wrapped === cue.thai ? cue : { ...cue, thai: wrapped };
        }
        const wrapped = wrapArabicText(cue.arabic, arabicMaxCharsPerLine);
        return wrapped === cue.arabic ? cue : { ...cue, arabic: wrapped };
      });
      setSubtitles(selectedClipId, next);
    },
    [arabicMaxCharsPerLine, maxCharsPerLine, selectedClipId, setSubtitles],
  );

  const handleSelectCaret = useCallback(
    (cueId: string, field: CueField, offset: number) => {
      caretRef.current = { cueId, field, offset };
    },
    [],
  );

  const setReviewed = useCallback(
    (cueId: string, reviewed: boolean) => {
      if (!selectedClipId) return;
      setRebuildHint(false);
      const latest = useProjectStore.getState().project?.subtitles[selectedClipId] ?? [];
      setSubtitles(
        selectedClipId,
        latest.map((cue) => (cue.id === cueId ? { ...cue, reviewed } : cue)),
      );
    },
    [selectedClipId, setSubtitles],
  );

  /** The next line that still needs a proof-read, wrapping to the start. */
  const nextUnchecked = useCallback(
    (cueId: string): SubtitleCue | null => {
      const index = cues.findIndex((cue) => cue.id === cueId);
      if (index < 0) return null;
      return (
        cues.slice(index + 1).find((cue) => !cue.reviewed) ??
        cues.slice(0, index).find((cue) => !cue.reviewed) ??
        null
      );
    },
    [cues],
  );

  /**
   * The one-tap review loop: checking a line moves the deck to the next line
   * that still needs attention, so L("To check") drains without extra clicks.
   */
  const toggleReviewed = useCallback(
    (cue: SubtitleCue) => {
      if (cue.reviewed) {
        setReviewed(cue.id, false);
        return;
      }
      setReviewed(cue.id, true);
      if (filter !== "unchecked") return;
      const next = nextUnchecked(cue.id);
      if (next) selectCue(next);
      else setActiveCueId(null);
    },
    [filter, nextUnchecked, selectCue, setReviewed],
  );

  const updateCueTime = useCallback(
    (cueId: string, start: number, end: number) => {
      if (!selectedClipId) return;
      const latest = useProjectStore.getState().project?.subtitles[selectedClipId] ?? [];
      setSubtitles(
        selectedClipId,
        latest.map((cue) => (cue.id === cueId ? { ...cue, start, end } : cue)),
      );
      setPlayhead((current) => clamp(current, 0, Math.max(0, clipDuration)));
    },
    [clipDuration, selectedClipId, setSubtitles],
  );

  /**
   * Ctrl+Enter (or the Split button) cuts the line at the textarea caret: the
   * edited line is cut exactly where the cursor sits, the other language line
   * is cut at the same relative position, and the time range is divided by the
   * same ratio.
   */
  const handleSplit = useCallback(
    (cueId: string, field: CueField, cursor: number) => {
      if (!selectedClipId) return;
      setRebuildHint(false);
      const latest = useProjectStore.getState().project?.subtitles[selectedClipId] ?? [];
      const cue = latest.find((item) => item.id === cueId);
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
      // The counterpart is cut at a word boundary, never at a character ratio:
      // a proportional slice severs Thai word clusters and pulls Arabic Harakat
      // away from their letters. A pair with no safe break (one long Arabic
      // word) is refused instead of being mutilated.
      const otherOffset = other.trim()
        ? splitAtWordBoundary(other, ratio, field === "arabic" ? "thai" : "arabic")
        : 0;
      const otherFirst = other.slice(0, otherOffset).trim();
      const otherSecond = other.slice(otherOffset).trim();
      if (other.trim() && (!otherFirst || !otherSecond)) {
        toast.error("Can't split this pair of lines here", {
          description:
            "The other language has no word break near the cursor. Move the cursor and try again.",
        });
        return;
      }

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
        arabic: wrapArabicText(
          field === "arabic" ? editedFirst : otherFirst,
          arabicMaxCharsPerLine,
        ),
        thai: wrapSubtitleText(
          field === "thai" ? editedFirst : otherFirst,
          maxCharsPerLine,
        ),
        reviewed: false,
      };
      const second: SubtitleCue = {
        ...cue,
        id: crypto.randomUUID(),
        start: boundary,
        arabic: wrapArabicText(
          field === "arabic" ? editedSecond : otherSecond,
          arabicMaxCharsPerLine,
        ),
        thai: wrapSubtitleText(
          field === "thai" ? editedSecond : otherSecond,
          maxCharsPerLine,
        ),
        reviewed: false,
      };

      const index = latest.findIndex((item) => item.id === cueId);
      const next = [...latest];
      next.splice(index, 1, first, second);
      setSubtitles(selectedClipId, next);
      setActiveCueId(second.id);
      monitorRef.current?.seekTo((selectedClip?.start ?? 0) + boundary + 0.02);
      setPlayhead(boundary + 0.02);
      toast.success("Line split", {
        description: `Split at ${formatClock(boundary - cue.start, true)} into the line · ${editedFirst.length} / ${editedSecond.length} characters.`,
      });
    },
    [arabicMaxCharsPerLine, maxCharsPerLine, selectedClip, selectedClipId, setSubtitles],
  );

  /** Split the active line at the last caret position, or at the midpoint. */
  const splitCue = useCallback(
    (cue: SubtitleCue) => {
      const caret = caretRef.current;
      const preferred: CueField =
        caret && caret.cueId === cue.id
          ? caret.field
          : cue.thai.trim()
            ? "thai"
            : "arabic";
      const text = cue[preferred];
      const offset =
        caret && caret.cueId === cue.id && caret.field === preferred
          ? caret.offset
          : Math.floor(text.length / 2);
      handleSplit(cue.id, preferred, offset);
    },
    [handleSplit],
  );

  const handleMerge = useCallback(
    (cueId: string) => {
      if (!selectedClipId) return;
      setRebuildHint(false);
      const latest = useProjectStore.getState().project?.subtitles[selectedClipId] ?? [];
      const index = latest.findIndex((cue) => cue.id === cueId);
      const cue = latest[index];
      const following = latest[index + 1];
      if (!cue || !following) return;

      const arabic = wrapArabicText(
        [cue.arabic.trim(), following.arabic.trim()].filter(Boolean).join(" "),
        arabicMaxCharsPerLine,
      );
      const thai = wrapSubtitleText(
        [cue.thai.trim(), following.thai.trim()].filter(Boolean).join(" "),
        maxCharsPerLine,
      );
      const merged: SubtitleCue = {
        ...cue,
        end: following.end,
        arabic,
        thai,
        reviewed: false,
      };
      const next = latest
        .filter((item) => item.id !== following.id)
        .map((item) => (item.id === cue.id ? merged : item));
      setSubtitles(selectedClipId, next);
      setActiveCueId(merged.id);
      toast.success("Lines merged", {
        description: `One line now covers ${formatClock(merged.end - merged.start, true)}.`,
      });
    },
    [arabicMaxCharsPerLine, maxCharsPerLine, selectedClipId, setSubtitles],
  );

  const handleDelete = useCallback(
    (cueId: string) => {
      if (!selectedClipId) return;
      setRebuildHint(false);
      const latest = useProjectStore.getState().project?.subtitles[selectedClipId] ?? [];
      const index = latest.findIndex((cue) => cue.id === cueId);
      const removed = latest[index];
      if (!removed) return;

      const next = latest.filter((cue) => cue.id !== cueId);
      setSubtitles(selectedClipId, next);
      const fallback = next[Math.min(index, next.length - 1)] ?? null;
      setActiveCueId(fallback?.id ?? null);

      toast("Line deleted", {
        description: "The subtitle line was removed from this clip.",
        action: {
          label: "Undo",
          onClick: () => {
            const current = useProjectStore.getState().project;
            const list = current?.subtitles[selectedClipId] ?? [];
            if (list.some((cue) => cue.id === removed.id)) return;
            useProjectStore
              .getState()
              .setSubtitles(
                selectedClipId,
                [...list, removed].sort((a, b) => a.start - b.start),
              );
            setActiveCueId(removed.id);
          },
        },
      });
    },
    [selectedClipId, setSubtitles],
  );

  const handleAdd = useCallback(() => {
    if (!selectedClipId || !selectedClip) return;
    setRebuildHint(false);
    const latest = useProjectStore.getState().project?.subtitles[selectedClipId] ?? [];
    const previous =
      [...latest]
        .filter((cue) => cue.start <= playhead)
        .sort((a, b) => b.end - a.end)[0] ?? null;
    const following =
      latest
        .filter((cue) => cue.start > playhead)
        .sort((a, b) => a.start - b.start)[0] ?? null;
    const start = Math.max(playhead, previous?.end ?? 0);
    const end = Math.min(start + 2.5, following?.start ?? clipDuration);
    if (end - start < 0.3) {
      toast.error("No room for a new line here", {
        description: "Move the playhead, or shorten a neighbouring line first.",
      });
      return;
    }
    const cue: SubtitleCue = {
      id: crypto.randomUUID(),
      start: Math.round(start * 100) / 100,
      end: Math.round(end * 100) / 100,
      arabic: "",
      thai: "",
      reviewed: false,
    };
    setSubtitles(
      selectedClipId,
      [...latest, cue].sort((a, b) => a.start - b.start),
    );
    setActiveCueId(cue.id);
  }, [clipDuration, playhead, selectedClip, selectedClipId, setSubtitles]);

  /* ---------------------------- verification --------------------------- */

  const verifyOne = useCallback(
    async (
      cue: SubtitleCue,
      announce = true,
    ): Promise<"corrected" | "verified" | "unmatched"> => {
      const arabicText = cue.arabic.trim();
      if (!arabicText) {
        toast.error("Nothing to verify", {
          description: "This line has no Arabic text.",
        });
        throw new Error("empty");
      }
      // Capture the owning session now: the reply may land after a switch.
      const projectId = useProjectStore.getState().project?.id;
      const result = await verifyArabic({
        arabic_text: arabicText,
        context_thai: cue.thai.replace(/\n/g, " "),
        provider: null,
      });

      if (result.source === "unmatched" || result.source === "needs_model") {
        if (announce) {
          toast.info("Not in the Qur'an corpus", {
            description:
              result.notes ||
              "Only Qur'an verses are checked offline. Review non-Qur'anic Arabic manually.",
          });
        }
        return "unmatched";
      }

      if (selectedClipId && projectId) {
        // Route by project id: a session switch mid-check must not write into
        // whatever project happens to be open when the reply lands.
        deliverTaskResult(projectId, {
          kind: "verify",
          clipId: selectedClipId,
          lines: [
            {
              cueId: cue.id,
              arabic: result.verified_text || cue.arabic,
              // Provenance travels with the text: a corpus match must badge the
              // line as verified even when the spelling did not change.
              source: result.source,
              reference: result.reference ?? undefined,
              confidence: result.confidence ?? undefined,
            },
          ],
        });
      }

      if (result.correction_applied) {
        if (announce) {
          toast.success(L("Arabic corrected"), {
            description: result.notes || "The Uthmani spelling was updated.",
          });
        }
        return "corrected";
      }
      if (announce) {
        toast.success("Arabic verified", {
          description:
            result.notes ||
            (result.source === "quran"
              ? "Matches the Qur'an corpus."
              : "The spelling and Harakat match the source."),
        });
      }
      return "verified";
    },
    [selectedClipId],
  );

  const handleVerify = useCallback(
    async (cue: SubtitleCue) => {
      setVerifying(cue.id);
      try {
        await verifyOne(cue);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== "empty") {
          toast.error("Verification failed", { description: message });
        }
      } finally {
        setVerifying(null);
      }
    },
    [verifyOne],
  );

  const handleVerifyAll = useCallback(async () => {
    if (!selectedClipId) return;
    const projectId = useProjectStore.getState().project?.id;
    if (!projectId) return;
    const alreadyRunning = useJobStore
      .getState()
      .jobs.some(
        (job) =>
          job.kind === "verify" && job.projectId === projectId && job.status === "running",
      );
    if (alreadyRunning) return;
    const targets = (useProjectStore.getState().project?.subtitles[selectedClipId] ?? []).filter(
      (cue) => cue.arabic.trim().length > 0,
    );
    if (!targets.length) return;

    const clipId = selectedClipId;
    const BATCH = 64;
    type VerifiedLine = {
      cueId: string;
      arabic: string;
      source?: string;
      reference?: string;
      confidence?: number;
    };
    let corrected = 0;
    let failed = 0;
    let checked = 0;
    let corpus = 0;
    let unmatched = 0;

    useJobStore.getState().startTask({
      kind: "verify",
      projectId,
      label: "Checking Arabic",
      run: async (signal, hooks) => {
        const allLines: VerifiedLine[] = [];
        hooks.setProgress(0, targets.length);
        for (let offset = 0; offset < targets.length; offset += BATCH) {
          if (signal.aborted) break;
          const chunk = targets.slice(offset, offset + BATCH);
          try {
            const result = await verifyArabicBatch(
              {
                lines: chunk.map((cue) => ({
                  arabic_text: cue.arabic.trim(),
                  context_thai: cue.thai.replace(/\n/g, " "),
                  cue_id: cue.id,
                })),
                provider: null,
                decision_provider: null,
              },
              { signal },
            );
            const byCue = new Map(
              result.lines
                .filter((line) => line.cue_id)
                .map((line) => [line.cue_id as string, line]),
            );
            const chunkLines: VerifiedLine[] = [];
            for (const cue of chunk) {
              const line = byCue.get(cue.id);
              if (!line) continue;
              if (line.source === "unmatched" || line.source === "needs_model") {
                unmatched += 1;
                continue;
              }
              if (line.source === "quran") corpus += 1;
              if (line.correction_applied) corrected += 1;
              if (line.verified_text) {
                const entry: VerifiedLine = {
                  cueId: cue.id,
                  arabic: line.verified_text,
                  source: line.source,
                  reference: line.reference ?? undefined,
                  confidence: line.confidence ?? undefined,
                };
                chunkLines.push(entry);
                allLines.push(entry);
              }
            }
            if (chunkLines.length) {
              hooks.deliverPartial({ kind: "verify", clipId, lines: chunkLines });
            }
            checked += chunk.length;
          } catch {
            if (signal.aborted) break;
            failed += chunk.length;
          }
          hooks.setProgress(Math.min(targets.length, offset + chunk.length), targets.length);
        }
        // A cancelled batch keeps whatever chunks already landed (delivered as
        // partials); a finished one returns the full list so a session that was
        // not open can still receive it through the journal.
        if (signal.aborted) return null;
        return { kind: "verify" as const, clipId, lines: allLines };
      },
      onSuccess: () => {
        if (failed > 0) {
          toast.error(`Checked ${checked} of ${targets.length} lines`, {
            description: `${failed} line${failed === 1 ? "" : "s"} could not be checked.`,
          });
          return;
        }
        if (unmatched === 0) {
          toast.success(L("Arabic checked"), {
            description: `${corpus} Qur'an match${corpus === 1 ? "" : "es"} · ${corrected} corrected.`,
          });
          return;
        }
        toast.info(
          `Matched ${corpus} of ${targets.length} lines in the Qur'an corpus`,
          {
            description: `${corrected} corrected · ${unmatched} non-Qur'anic line${
              unmatched === 1 ? "" : "s"
            } left unchanged for manual review.`,
          },
        );
      },
      onError: (message) => {
        toast.error("Arabic check failed", { description: message });
      },
      onCancel: () => {
        toast("Arabic check stopped", {
          description: `${checked} line${checked === 1 ? "" : "s"} checked.`,
        });
      },
    });
  }, [selectedClipId]);

  /* ------------------------------ keyboard ----------------------------- */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        document.querySelector(
          '[data-slot="dialog-content"][data-state="open"], [data-vaul-drawer][data-state="open"]',
        )
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === "Escape" && previewFocus) {
        event.preventDefault();
        setPreviewFocus(false);
        return;
      }

      switch (event.key) {
        case " ":
          event.preventDefault();
          togglePlay();
          break;
        case "j":
        case "J":
          event.preventDefault();
          shuttle(-1);
          break;
        case "k":
        case "K":
          event.preventDefault();
          pauseShuttle();
          break;
        case "l":
        case "L":
          event.preventDefault();
          shuttle(1);
          break;
        case "ArrowLeft":
          event.preventDefault();
          moveCue(-1);
          break;
        case "ArrowRight":
          event.preventDefault();
          moveCue(1);
          break;
        case "Enter":
          if (activeCue && hasText(activeCue) && !activeCue.reviewed) {
            event.preventDefault();
            setReviewed(activeCue.id, true);
            const next = nextUnchecked(activeCue.id);
            if (next) selectCue(next);
            else setActiveCueId(null);
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    activeCue,
    moveCue,
    nextUnchecked,
    pauseShuttle,
    previewFocus,
    selectCue,
    setReviewed,
    shuttle,
    togglePlay,
  ]);

  /* ------------------------------ guards ------------------------------- */

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
        <p className="text-sm font-medium text-foreground">{L("No approved clips")}</p>
        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
          Approve clips in Find Clips first — each approved clip gets its own bilingual subtitle
          track.
        </p>
        <Button className="mt-1" size="sm" onClick={() => setStep(2)}>
          {L("Back to clip discovery")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="relative shrink-0 bg-card/30 px-4 pt-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-baseline gap-2">
            <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              {L("Step 3 of 4")}
            </p>
            <h1 className="text-base font-medium text-foreground">{L("Subtitles")}</h1>
            <span className="truncate text-[11px] text-muted-foreground">{project.name}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Badge variant="outline" className="text-[10px] tabular-nums">
              {checkedCount}/{cues.length} checked
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              {language.toUpperCase()}
            </Badge>
          </div>
        </div>

        {/* The rule the active clip tab sits on (and visually erases), so the
            clip queue reads like the stage tabs above it. */}
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-border" />

        {/* `relative` matters: it lifts the strip into the positioned paint
            layer so the selected tab's background covers the rule below it,
            exactly like the stage tabs in the header above. */}
        <div
          ref={queueRef}
          role="group"
          aria-label="Clips"
          className="relative -mx-1 mt-2 flex items-end gap-1.5 overflow-x-auto px-1"
        >
          {approvedClips.map((clip, index) => {
            const clipCues = project.subtitles[clip.id] ?? [];
            const checkedInClip = clipCues.filter((cue) => cue.reviewed).length;
            const complete = clipCues.length > 0 && checkedInClip === clipCues.length;
            const selected = clip.id === selectedClipId;
            return (
              <div
                key={clip.id}
                data-clip-id={clip.id}
                className={cn(
                  "flex shrink-0 items-center gap-0.5 rounded-t-lg border border-b-0 px-1",
                  selected
                    ? "border-border bg-background"
                    : "border-transparent hover:bg-accent/30",
                )}
              >
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-pressed={selected}
                  onClick={() => selectClip(clip.id)}
                  className={cn(
                    "h-auto gap-2.5 px-4 py-2 text-xs font-normal hover:bg-transparent",
                    selected
                      ? "text-foreground hover:bg-transparent"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-5 items-center justify-center rounded-full border text-[10px] tabular-nums",
                      selected
                        ? "border-ring/50 bg-secondary text-foreground"
                        : complete
                          ? "border-border bg-secondary/60 text-foreground"
                          : "border-border text-muted-foreground",
                    )}
                  >
                    {complete ? <Check className="size-3" /> : index + 1}
                  </span>
                  <span className="max-w-[150px] truncate">{clip.title}</span>
                  {complete ? null : (
                    <span className="text-[10px] tabular-nums text-muted-foreground">
                      {checkedInClip}/{clipCues.length}
                    </span>
                  )}
                </Button>
              </div>
            );
          })}
        </div>
      </header>

      <div
        className={cn(
          "grid min-h-0 flex-1",
          previewFocus
            ? "grid-cols-1"
            : "grid-cols-[minmax(0,1fr)_minmax(300px,360px)]",
        )}
      >
        {/* ------------------------------ lines ------------------------------ */}
        {previewFocus ? null : (
          <section className="flex min-h-0 flex-col border-r border-border">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
              <div className="flex items-center gap-2">
                <h2 className="text-[13px] font-medium text-foreground">{L("Subtitle lines")}</h2>
                <Badge variant="outline" className="text-[10px] tabular-nums">
                  {cues.length}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {maxCharsPerLine} chars per line
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  size="xs"
                  variant={filter === "all" ? "secondary" : "ghost"}
                  aria-pressed={filter === "all"}
                  onClick={() => setFilter("all")}
                >
                  {L("All")}
                </Button>
                <Button
                  size="xs"
                  variant={filter === "unchecked" ? "secondary" : "ghost"}
                  aria-pressed={filter === "unchecked"}
                  onClick={() => setFilter("unchecked")}
                >
                  {L("To check")}
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={L("Rebuild lines from transcript")}
                  title={L("Rebuild lines from transcript")}
                  disabled={(project.transcript?.segments.length ?? 0) === 0}
                  onClick={() => setRebuildOpen(true)}
                >
                  <RefreshCw className="size-3.5" />
                </Button>
                <Button size="xs" variant="outline" className="gap-1" onClick={handleAdd}>
                  <Plus className="size-3" />
                  {L("Add line")}
                </Button>
              </div>
            </div>

            {arabicPassages.length ? (
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card/30 px-3 py-2">
                <Languages className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                  {arabicPassages.length} Arabic passage
                  {arabicPassages.length === 1 ? "" : "s"} · {verifiedArabicCount} verified ·{" "}
                  {unreviewedArabicCount} to review
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => setArabicReviewOpen(true)}
                >
                  Review
                </Button>
              </div>
            ) : null}

            {rebuildHint ? (
              <div className="flex shrink-0 items-start gap-2 border-b border-status-warning/30 bg-status-warning/10 px-3 py-2">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-status-warning" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-foreground">
                    These lines were cut in the middle of words
                  </p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Rebuild them from the transcript so every line starts and ends on a whole word.
                  </p>
                </div>
                <Button
                  size="xs"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => setRebuildOpen(true)}
                >
                  {L("Rebuild lines")}
                </Button>
              </div>
            ) : null}

            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
              <span className="text-xs tabular-nums text-muted-foreground">
                {checkedCount} of {cues.length} checked
              </span>
              <div className="flex items-center gap-1">
                {verifyAll ? (
                  <>
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      <NumberFlow
                        value={verifyAll.done}
                        suffix={`/${verifyAll.total}`}
                        format={{ maximumFractionDigits: 0 }}
                      />
                    </span>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => useJobStore.getState().cancelKind("verify", project?.id ?? null)}
                    >
                      Stop
                    </Button>
                  </>
                ) : arabicCount > 0 ? (
                  <Button
                    size="xs"
                    variant="outline"
                    className="gap-1"
                    title="Verify Quran / Fix Arabic for every line in this clip"
                    onClick={() => void handleVerifyAll()}
                  >
                    <ShieldCheck className="size-3" />
                    Check {arabicCount} Arabic
                  </Button>
                ) : (
                  <span className="text-[11px] text-muted-foreground">{L("No Arabic lines")}</span>
                )}
              </div>
            </div>

            {verifyAll && activeArabicCheck ? (
              <div className="border-b border-border px-3 py-1">
                <AiActivityLine entry={activeArabicCheck} />
              </div>
            ) : null}

            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
              <div ref={listRef} className="min-w-0 space-y-2 px-3 py-3">
                {cues.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
                    <ScanText className="size-5 text-muted-foreground" />
                    <p className="text-xs font-medium text-foreground">
                      {L("No subtitle lines for this clip")}
                    </p>
                    <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
                      The transcript has no speech inside this clip. Widen the cut in Find Clips,
                      or add a line where the playhead sits.
                    </p>
                    <div className="mt-1 flex items-center gap-2">
                      <Button size="sm" variant="outline" onClick={() => setStep(2)}>
                        Adjust clip
                      </Button>
                      <Button size="sm" className="gap-1.5" onClick={handleAdd}>
                        <Plus className="size-3.5" />
                        {L("Add line")}
                      </Button>
                    </div>
                  </div>
                ) : visibleCues.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-1 px-6 py-12 text-center">
                    <CheckCircle2 className="size-5 text-muted-foreground" />
                    <p className="text-xs font-medium text-foreground">
                      {L("Every line in this clip is checked")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {L("Switch to All to edit a line again.")}
                    </p>
                  </div>
                ) : (
                  visibleCues.map(({ cue, index }) => (
                    <SubtitleCueRow
                      key={cue.id}
                      cue={cue}
                      index={index}
                      active={activeCue?.id === cue.id}
                      hasFollowing={Boolean(cues[index + 1])}
                      canPlay={canPlay}
                      verifyingThis={verifying === cue.id}
                      verifyAll={Boolean(verifyAll)}
                      onPlayCue={playCue}
                      onSelectCue={selectCue}
                      onToggleReviewed={toggleReviewed}
                      onCueChange={handleCueChange}
                      onCueBlur={handleCueBlur}
                      onSelectCaret={handleSelectCaret}
                      onSplitAt={handleSplit}
                      onVerify={handleVerify}
                      onSplitCue={splitCue}
                      onMerge={handleMerge}
                      onDelete={handleDelete}
                    />
                  ))
                )}
              </div>
            </div>
          </section>
        )}

        {/* ----------------------------- monitor ----------------------------- */}
        <section
          className={cn(
            "flex min-h-0 flex-col",
            previewFocus
              ? "fixed inset-x-0 bottom-0 top-[var(--titlebar-height)] z-40 border-0 bg-background p-3"
              : "border-l border-border",
          )}
          role={previewFocus ? "dialog" : undefined}
          aria-modal={previewFocus || undefined}
          aria-label={previewFocus ? L("Output preview") : undefined}
        >
          {previewFocus ? (
            <div className="flex shrink-0 items-center justify-between px-1 pb-2">
              <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                {L("Output preview")}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Close preview"
                onClick={() => setPreviewFocus(false)}
              >
                <X className="size-4" />
              </Button>
            </div>
          ) : null}
          <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 py-2">
            {/* Output shape sits above the picture it changes: the editor
                frames the clip while looking at the frame. */}
            <div className="flex shrink-0 items-start gap-2">
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  {L("Aspect ratio")}
                </p>
                <SegmentedToggle<Resolution>
                  label={L("Aspect ratio")}
                  value={resolution}
                  options={[
                    { value: "1080x1920", label: "9:16", hint: "1080 x 1920, vertical" },
                    { value: "1920x1080", label: "16:9", hint: "1920 x 1080, widescreen" },
                  ]}
                  onChange={(value) => updateExportSettings({ resolution: value })}
                />
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  {L("Framing mode")}
                </p>
                <SegmentedToggle<FramingMode>
                  label={L("Framing mode")}
                  value={framing}
                  disabled={!portrait}
                  options={[
                    {
                      value: "blur-fill",
                      label: FRAMING_LABELS["blur-fill"],
                      hint: "Keeps the slide visible inside blurred bars",
                    },
                    {
                      value: "center-crop",
                      label: FRAMING_LABELS["center-crop"],
                      hint: "Crops to fill the frame",
                    },
                  ]}
                  onChange={(value) => updateExportSettings({ framing: value })}
                />
              </div>
            </div>
            {portrait ? null : (
              <p className="shrink-0 text-[10px] leading-relaxed text-muted-foreground">
                16:9 uses the whole frame, so framing applies to 9:16 only.
              </p>
            )}

            <SubtitleMonitor
              ref={monitorRef}
              resolution={resolution}
              framing={framing}
              sourcePath={project.sourcePath}
              clipStart={clipStart}
              cues={cues}
              selectedCueId={activeCue?.id ?? null}
              styles={styles}
              safeZone={safeZone}
              muted={muted}
              interactive
              offsets={{
                arabic: arabicSettings.verticalOffset,
                thai: thaiSettings.verticalOffset,
              }}
              onNudgeLine={nudgeMonitorLine}
              onTimeUpdate={handleMonitorTime}
              onPlayingChange={setPlaying}
              onTogglePlay={togglePlay}
            />

            <CueRibbon
              cues={cues}
              duration={clipDuration}
              selectedId={activeCue?.id ?? null}
              playhead={playhead}
              onSelect={(cueId) => {
                const cue = cues.find((item) => item.id === cueId);
                if (cue) selectCue(cue);
              }}
              onSeek={(seconds) => {
                monitorRef.current?.pause();
                monitorRef.current?.seekTo(clipStart + seconds);
                setPlayhead(seconds);
              }}
              onChangeTime={updateCueTime}
            />

            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={playing ? L("Pause") : "Play the selected line"}
                disabled={!canPlay || !activeCue}
                onClick={togglePlay}
              >
                {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={L("Previous line")}
                disabled={!activeCue}
                onClick={() => moveCue(-1)}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={L("Next line")}
                disabled={!activeCue}
                onClick={() => moveCue(1)}
              >
                <ChevronRight className="size-4" />
              </Button>

              <span className="ml-1 text-[11px] tabular-nums text-muted-foreground">
                <TimeFlow value={playhead} tenths />
              </span>
              <span className="text-[10px] text-muted-foreground/60">/</span>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                <TimeFlow value={clipDuration} />
              </span>

              <div className="ml-auto flex items-center gap-1">
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  <NumberFlow
                    value={rate}
                    suffix="×"
                    format={{ maximumFractionDigits: 2 }}
                  />
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={muted ? L("Unmute") : L("Mute")}
                  onClick={() => setMuted((value) => !value)}
                >
                  {muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={previewFocus ? "Back to editing" : "Focus the preview"}
                  aria-pressed={previewFocus}
                  onClick={() => setPreviewFocus((value) => !value)}
                >
                  {previewFocus ? (
                    <Minimize2 className="size-3.5" />
                  ) : (
                    <Maximize2 className="size-3.5" />
                  )}
                </Button>
              </div>
            </div>
          </div>

          <div className="shrink-0 border-t border-border px-3 py-2">
            <Popover open={styleOpen} onOpenChange={setStyleOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="xs" className="w-full justify-between gap-2 text-xs">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <SlidersHorizontal className="size-3" />
                    <span className="truncate">
                      {activePreset?.name ?? L("Custom style")}
                    </span>
                  </span>
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" side="top" className="w-80 space-y-3">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                      Style
                    </p>
                    {presetModified ? (
                      <Badge variant="outline" className="text-[9px] text-status-warning">
                        Modified
                      </Badge>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <Select
                      value={activePresetId ?? undefined}
                      onValueChange={(value) => applyPreset(value)}
                    >
                      <SelectTrigger className="h-8 flex-1 text-xs" aria-label="Subtitle style">
                        <SelectValue placeholder={L("Custom style")} />
                      </SelectTrigger>
                      <SelectContent>
                        {presets.map((preset) => (
                          <SelectItem key={preset.id} value={preset.id}>
                            {preset.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="outline"
                      size="xs"
                      className="gap-1"
                      onClick={() => {
                        setStyleOpen(false);
                        openConfig(3);
                      }}
                    >
                      <Type className="size-3" />
                      {L("Edit")}
                    </Button>
                  </div>
                </div>

                <Separator />

                <div className="flex items-center justify-between gap-2">
                  <div className="space-y-0.5">
                    <p className="text-xs font-medium text-foreground">{L("Safe zone")}</p>
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      Shows the TikTok / Reels / Shorts buttons and caption area.
                    </p>
                  </div>
                  <Switch
                    checked={safeZone}
                    onCheckedChange={setSafeZone}
                    disabled={!portrait}
                    aria-label="Platform safe-zone overlay"
                  />
                </div>

                {overlap.overlaps ? (
                  <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-status-warning">
                    <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                    The Arabic and Thai lines overlap by {Math.abs(Math.round(overlap.gap))} px at
                    this size. Adjust the sizes in Edit.
                  </p>
                ) : null}
              </PopoverContent>
            </Popover>
          </div>
        </section>
      </div>

      <Dialog open={rebuildOpen} onOpenChange={setRebuildOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rebuild subtitle lines?</DialogTitle>
            <DialogDescription>
              This replaces the {cues.length} line{cues.length === 1 ? "" : "s"} in this clip with
              lines rebuilt from the transcript. Text edits and check marks in this clip will be
              lost.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setRebuildOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setRebuildOpen(false);
                handleRebuild();
              }}
            >
              {L("Rebuild lines")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={arabicReviewOpen} onOpenChange={setArabicReviewOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{L("Arabic passages")}</DialogTitle>
            <DialogDescription>
              Each recitation is its own subtitle. Qur'an passages marked verified were matched
              against the bundled corpus; hadith and quotes are AI suggestions. Review them before
              exporting.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {arabicPassages.length === 0 ? (
              <p className="text-xs text-muted-foreground">{L("No Arabic passages in this clip.")}</p>
            ) : null}
            {arabicPassages.map((cue) => (
              <div
                key={cue.id}
                className={cn(
                  "rounded-md border px-3 py-2.5",
                  cue.reviewed
                    ? "border-border bg-card/40"
                    : "border-status-warning/40 bg-status-warning/5",
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-1 text-[11px] tabular-nums text-muted-foreground">
                    <TimeFlow value={cue.start} tenths />
                    <span aria-hidden>→</span>
                    <TimeFlow value={cue.end} tenths />
                  </span>
                  <div className="flex items-center gap-1.5">
                    <Badge
                      variant={cue.source === "quran" ? "secondary" : "outline"}
                      className="text-[10px]"
                    >
                      {arabicSourceLabel(cue)}
                    </Badge>
                    {cue.reviewed ? (
                      <CheckCircle2 className="size-3.5 text-foreground/70" />
                    ) : null}
                  </div>
                </div>

                <p
                  dir="rtl"
                  lang="ar"
                  className="mt-2 whitespace-pre-line font-arabic text-lg leading-relaxed text-foreground"
                >
                  {cue.arabic}
                </p>

                {cue.translation ? (
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                    Translation reference: {cue.translation}
                  </p>
                ) : null}

                {cue.originalText ? (
                  <details className="mt-1.5">
                    <summary className="cursor-default text-[11px] text-muted-foreground/80">
                      Original Thai transcription
                    </summary>
                    <p lang="th" className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {cue.originalText}
                    </p>
                  </details>
                ) : null}

                <div className="mt-2 flex flex-wrap items-center gap-1">
                  <Button
                    size="xs"
                    variant="outline"
                    className="gap-1"
                    disabled={!canPlay}
                    onClick={() => playCue(cue)}
                  >
                    <Play className="size-3" />
                    {L("Play")}
                  </Button>
                  <Button
                    size="xs"
                    variant={cue.reviewed ? "secondary" : "outline"}
                    className="gap-1"
                    onClick={() => setReviewed(cue.id, true)}
                  >
                    <CheckCircle2 className="size-3" />
                    {cue.reviewed ? "Approved" : "Approve"}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setArabicReviewOpen(false);
                      selectCue(cue);
                    }}
                  >
                    {L("Edit")}
                  </Button>
                  {cue.originalText ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      className="text-muted-foreground"
                      onClick={() => restoreArabicPassage(cue.id)}
                    >
                      {L("Restore Thai")}
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setArabicReviewOpen(false)}>
              Close
            </Button>
            {verifiedArabicCount > 0 ? (
              <Button size="sm" onClick={approveAllVerifiedArabic}>
                Approve {verifiedArabicCount} verified
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border bg-card/20 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
          <Monitor className="size-3.5 shrink-0" />
          <span className="max-w-[240px] truncate">{selectedClip?.title}</span>
          <span aria-hidden>·</span>
          <span className="tabular-nums">
            {checkedCount} of {cues.length} checked
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => setStep(2)}>
            {L("Back to clip discovery")}
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            disabled={cues.length === 0}
            onClick={() => setStep(4)}
          >
            <Smartphone className="size-3.5" />
            {L("Continue to export")}
          </Button>
        </div>
      </footer>
    </div>
  );
}

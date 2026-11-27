import { L } from "@/lib/i18n";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import NumberFlow from "@number-flow/react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeftToLine,
  ArrowRightToLine,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Film,
  Image as ImageIcon,
  ImagePlus,
  Languages,
  Loader2,
  Maximize2,
  Merge,
  Minimize2,
  Monitor,
  Pause,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  ScanText,
  Scissors,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Trash2,
  Type,
  Undo2,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { cn } from "cn";
import type { Layout } from "react-resizable-panels";

import { SegmentedToggle } from "@/components/SegmentedToggle";
import { TimeFlow } from "@/components/TimeFlow";
import { CUE_RIBBON_ZOOM_LEVELS } from "@/components/subtitles/CueRibbon";
import { SubtitleMonitor, type SubtitleMonitorHandle } from "@/components/subtitles/SubtitleMonitor";
import { TimelineTracks } from "@/components/subtitles/TimelineTracks";
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
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
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
import {
  cloneInserts,
  DEFAULT_INSERT_RECT,
  isFullFrameRect,
  resolveInsertPlacement,
} from "@/lib/insertTiming";
import {
  classifyInsertFile,
  isTauriRuntime,
  openInsertMediaFiles,
  probeInsertMedia,
  probeMediaSrc,
  readClipboardFilePaths,
  saveClipboardImage,
  subscribeNativeDrops,
  toMediaSrc,
  type InsertMediaPick,
} from "@/lib/media";
import {
  FRAMING_LABELS,
  isSubtitleOnlyProject,
  type FramingMode,
  type InsertFit,
  type InsertRect,
  type MediaInsert,
  type Resolution,
  type SubtitleCue,
} from "@/lib/projectTypes";
import {
  nudgeVerticalOffset,
  resolveAssStyles,
  stylesOverlap,
  type SubtitleLine,
} from "@/lib/subtitleStyles";
import {
  buildCuesFromTranscript,
  looksLikeBrokenBoundaryTrack,
  looksLikeFragmentSeed,
} from "@/lib/subtitleCues";
import { deliverTaskResult, useJobStore, useTaskJob } from "@/store/jobStore";
import { useProjectStore } from "@/store/projectStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";
import {
  splitAtWordBoundary,
  wordBoundaries,
  wrapArabicText,
  wrapSubtitleText,
} from "@/lib/subtitleWrap";
import {
  clamp,
  MIN_CUE_SECONDS,
  MIN_SPLITTABLE_DURATION,
  NEIGHBOUR_GAP,
  resolveSplitTiming,
  resolveTextSplitOffsetForTime,
  roundTime,
  spokenWeight,
} from "@/lib/subtitleTiming";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

type CueField = "arabic" | "thai";

/** Playback-rate ladder for the J/K/L shuttle (1× = normal speed). */
const SHUTTLE_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

const MAX_UNDO_HISTORY = 100;
const TEXT_EDIT_COALESCE_MS = 800;

const STEP3_LAYOUT_STORAGE_KEY = "tafseer.step3.layout.v1";
const STEP3_LINES_PANEL_ID = "step3-lines";
const STEP3_PREVIEW_PANEL_ID = "step3-preview";
const STEP3_LINES_MIN_PX = 340;
const STEP3_PREVIEW_MIN_PX = 320;
const STEP3_PREVIEW_DEFAULT_PX = 360;

const STEP3_PREVIEW_SPLIT_STORAGE_KEY = "tafseer.step3.previewSplit.v1";
const STEP3_MONITOR_PANE_ID = "step3-monitor-pane";
const STEP3_TIMELINE_PANE_ID = "step3-timeline-pane";
const STEP3_MONITOR_MIN_PX = 180;
const STEP3_TIMELINE_MIN_PX = 132;
const STEP3_TIMELINE_DEFAULT_PX = 144;

interface Step3HistorySnapshot {
  cues: SubtitleCue[];
  inserts: MediaInsert[];
}

function loadTwoPaneLayout(
  storageKey: string,
  firstId: string,
  secondId: string,
): Layout | undefined {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const first = (parsed as Record<string, unknown>)[firstId];
    const second = (parsed as Record<string, unknown>)[secondId];
    if (
      typeof first === "number" &&
      typeof second === "number" &&
      Number.isFinite(first) &&
      Number.isFinite(second) &&
      first > 0 &&
      second > 0 &&
      Math.abs(first + second - 100) < 1
    ) {
      return {
        [firstId]: first,
        [secondId]: second,
      };
    }
  } catch {
    /* Ignore unavailable or malformed localStorage. */
  }
  return undefined;
}

function cloneCues(list: SubtitleCue[]): SubtitleCue[] {
  return list.map((cue) => ({ ...cue }));
}

function hasText(cue: SubtitleCue): boolean {
  return cue.arabic.trim().length > 0 || cue.thai.trim().length > 0;
}

function unwrapLines(text: string): string {
  return text
    .replace(/\s*\n\s*/g, (match, offset: number, source: string) => {
      const before = offset > 0 ? source[offset - 1] : "";
      const afterIndex = offset + match.length;
      const after = afterIndex < source.length ? source[afterIndex] : "";
      if (before && after && /[\u0E00-\u0E7F]/.test(before) && /[\u0E00-\u0E7F]/.test(after)) {
        return "";
      }
      return " ";
    })
    .trim();
}

function joinMergedText(first: string, second: string, kind: "thai" | "arabic"): string {
  const a = unwrapLines(first);
  const b = unwrapLines(second);
  if (!a) return b;
  if (!b) return a;
  if (kind === "arabic") return `${a} ${b}`;
  return /[\u0E00-\u0E7F]$/.test(a) && /^[\u0E00-\u0E7F]/.test(b) ? `${a}${b}` : `${a} ${b}`;
}

function hasMidWordCut(list: SubtitleCue[]): boolean {
  for (let i = 0; i < list.length - 1; i += 1) {
    const prev = list[i].thai.replace(/\s*\n\s*/g, "").trimEnd();
    const next = list[i + 1].thai.replace(/\s*\n\s*/g, "").trimStart();
    if (!prev || !next) continue;
    const lastChar = prev[prev.length - 1];
    const firstChar = next[0];
    if (!/[\u0E00-\u0E7F]/.test(lastChar) || !/[\u0E00-\u0E7F]/.test(firstChar)) continue;
    const boundaries = wordBoundaries(prev + next, "thai");
    if (!boundaries.includes(prev.length)) return true;
  }
  return false;
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
  canSplitAtPlayhead: boolean;
  canSetStartToPlayhead: boolean;
  canSetEndToPlayhead: boolean;
  onSplitAtPlayhead: (cue: SubtitleCue) => void;
  onSetEdgeToPlayhead: (cue: SubtitleCue, edge: "start" | "end") => void;
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
  canSplitAtPlayhead,
  canSetStartToPlayhead,
  canSetEndToPlayhead,
  onSplitAtPlayhead,
  onSetEdgeToPlayhead,
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
              <TimeFlow value={cue.start} hundredths />
              <span aria-hidden> → </span>
              <TimeFlow value={cue.end} hundredths />
            </span>
            <span className="text-muted-foreground/50">·</span>
            <NumberFlow
              value={Math.max(0, Math.round((cue.end - cue.start) * 100) / 100)}
              suffix="s"
              locales="en-US"
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
              "line-clamp-2 whitespace-pre-line text-xs leading-snug",
              cue.thai ? "text-foreground/90" : "text-muted-foreground/60",
            )}
          >
            {cue.thai || L("No Thai line")}
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
                if (event.shiftKey) {
                  onSplitAtPlayhead(cue);
                } else {
                  onSplitAt(cue.id, "arabic", event.currentTarget.selectionStart);
                }
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
                if (event.shiftKey) {
                  onSplitAtPlayhead(cue);
                } else {
                  onSplitAt(cue.id, "thai", event.currentTarget.selectionStart);
                }
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
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSplitCue(cue)}
            >
              <Scissors className="size-3" />
            </Button>
            <Button
              size="xs"
              variant="ghost"
              className="gap-1 px-1.5 text-[11px]"
              aria-label="Split line at playhead"
              title="Split line at playhead (Ctrl + Shift + Enter)"
              disabled={!canSplitAtPlayhead}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSplitAtPlayhead(cue)}
            >
              <Scissors className="size-3" />
              {L("Split at playhead")}
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={L("Set start to playhead")}
              title={L("Set start to playhead")}
              disabled={!canSetStartToPlayhead}
              onClick={() => onSetEdgeToPlayhead(cue, "start")}
            >
              <ArrowLeftToLine className="size-3" />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={L("Set end to playhead")}
              title={L("Set end to playhead")}
              disabled={!canSetEndToPlayhead}
              onClick={() => onSetEdgeToPlayhead(cue, "end")}
            >
              <ArrowRightToLine className="size-3" />
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
            Ctrl + Enter splits at cursor · Ctrl + Shift + Enter splits at playhead · Space plays.
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
  const setSubtitlesBatch = useProjectStore((state) => state.setSubtitlesBatch);
  const setInserts = useProjectStore((state) => state.setInserts);
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
  const settingsOpen = useUiStore((state) => state.settingsOpen);
  const configStep = useUiStore((state) => state.configStep);

  const monitorRef = useRef<SubtitleMonitorHandle>(null);
  const queueRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<{ cueId: string; field: CueField; offset: number } | null>(null);
  const healedSeedRef = useRef<string | null>(null);
  const seekKeyRef = useRef<string | null>(null);
  const manualEditClipsRef = useRef<Set<string>>(new Set());
  const historyRef = useRef<
    Map<string, { past: Step3HistorySnapshot[]; future: Step3HistorySnapshot[] }>
  >(new Map());
  const lastTextEditRef = useRef<{ key: string; at: number } | null>(null);

  const [historyRev, setHistoryRev] = useState(0);
  const [defaultLayout] = useState<Layout | undefined>(() =>
    loadTwoPaneLayout(STEP3_LAYOUT_STORAGE_KEY, STEP3_LINES_PANEL_ID, STEP3_PREVIEW_PANEL_ID),
  );
  const [defaultPreviewSplit] = useState<Layout | undefined>(() =>
    loadTwoPaneLayout(
      STEP3_PREVIEW_SPLIT_STORAGE_KEY,
      STEP3_MONITOR_PANE_ID,
      STEP3_TIMELINE_PANE_ID,
    ),
  );
  const [activeCueId, setActiveCueId] = useState<string | null>(null);
  const [selectedInsertId, setSelectedInsertId] = useState<string | null>(null);
  const [insertPopoverOpen, setInsertPopoverOpen] = useState(false);
  const [insertDragOver, setInsertDragOver] = useState(false);
  const [missingInsertIds, setMissingInsertIds] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState<"all" | "unchecked">("all");
  const [safeZone, setSafeZone] = useState(true);
  const [previewFocus, setPreviewFocus] = useState(false);
  const [styleOpen, setStyleOpen] = useState(false);
  const [resetDialogMode, setResetDialogMode] = useState<"reset" | "rebuild" | null>(null);
  const [arabicReviewOpen, setArabicReviewOpen] = useState(false);
  const [rebuildHint, setRebuildHint] = useState(false);
  const [muted, setMuted] = useState(false);
  const [verifyingIds, setVerifyingIds] = useState<Set<string>>(() => new Set());
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [continuousPlay, setContinuousPlay] = useState(false);
  const [rate, setRate] = useState(1);
  const [overlayMode, setOverlayMode] = useState<"cue" | "playhead">("cue");
  const [ribbonZoom, setRibbonZoom] = useState<number>(1);

  const resolution: Resolution = project?.export.resolution ?? "1080x1920";
  const framing: FramingMode = project?.export.framing ?? "blur-fill";
  const portrait = resolution === "1080x1920";
  const subtitleOnly = isSubtitleOnlyProject(project);

  const approvedClips = useMemo(
    () => (project?.clips ?? []).filter((clip) => clip.approved),
    [project?.clips],
  );
  const selectedClip =
    approvedClips.find((clip) => clip.id === project?.selectedClipId) ??
    approvedClips[0] ??
    null;
  const selectedClipId = selectedClip?.id ?? null;
  // The batch owns its job, so leaving Step 3 no longer stops the check; only
  // the explicit Stop button (or starting a new run) cancels it.
  const verifyJob = useTaskJob("verify", project?.id ?? null, selectedClipId);
  const verifyAll = verifyJob?.status === "running" ? verifyJob.progress : null;
  const cues = project?.subtitles[selectedClipId ?? ""] ?? [];
  const inserts = useMemo(
    () => project?.inserts?.[selectedClipId ?? ""] ?? [],
    [project?.inserts, selectedClipId],
  );
  const selectedInsert = useMemo(
    () => inserts.find((item) => item.id === selectedInsertId) ?? null,
    [inserts, selectedInsertId],
  );
  const clipStart = selectedClip?.start ?? 0;
  const clipDuration = selectedClip ? selectedClip.end - selectedClip.start : 0;
  const canPlay = Boolean(project?.sourcePath);

  const historyKey = project?.id && selectedClipId ? `${project.id}:${selectedClipId}` : null;
  const { canUndo, canRedo } = useMemo(() => {
    void historyRev;
    const entry = historyKey ? historyRef.current.get(historyKey) : undefined;
    return {
      canUndo: Boolean(entry && entry.past.length > 0),
      canRedo: Boolean(entry && entry.future.length > 0),
    };
  }, [historyKey, historyRev]);

  const pushHistory = useCallback(
    (
      clipId: string,
      cuesSnapshot: SubtitleCue[],
      textCoalesceKey?: string,
      insertsSnapshot?: MediaInsert[],
    ) => {
      const projectNow = useProjectStore.getState().project;
      if (!projectNow) return;
      const key = `${projectNow.id}:${clipId}`;
      const now = Date.now();
      if (textCoalesceKey) {
        const last = lastTextEditRef.current;
        if (last && last.key === textCoalesceKey && now - last.at < TEXT_EDIT_COALESCE_MS) {
          last.at = now;
          return;
        }
        lastTextEditRef.current = { key: textCoalesceKey, at: now };
      } else {
        lastTextEditRef.current = null;
      }

      let entry = historyRef.current.get(key);
      if (!entry) {
        entry = { past: [], future: [] };
        historyRef.current.set(key, entry);
      }
      const insertsNow = insertsSnapshot ?? projectNow.inserts?.[clipId] ?? [];
      entry.past.push({
        cues: cloneCues(cuesSnapshot),
        inserts: cloneInserts(insertsNow),
      });
      if (entry.past.length > MAX_UNDO_HISTORY) {
        entry.past.splice(0, entry.past.length - MAX_UNDO_HISTORY);
      }
      entry.future = [];
      setHistoryRev((n) => n + 1);
    },
    [],
  );

  const applyHistorySnapshot = useCallback(
    (clipId: string, target: Step3HistorySnapshot) => {
      const clonedCues = cloneCues(target.cues);
      const clonedInserts = cloneInserts(target.inserts);
      manualEditClipsRef.current.add(clipId);
      setRebuildHint(false);
      seekKeyRef.current = `${clipId}:${clonedCues[0]?.id ?? "empty"}`;
      setSubtitles(clipId, clonedCues);
      setInserts(clipId, clonedInserts);
      setActiveCueId((prev) =>
        prev && clonedCues.some((cue) => cue.id === prev) ? prev : (clonedCues[0]?.id ?? null),
      );
      setSelectedInsertId((prev) =>
        prev && clonedInserts.some((item) => item.id === prev) ? prev : null,
      );
      setPlayhead((current) => clamp(current, 0, Math.max(0, clipDuration)));
      setHistoryRev((n) => n + 1);
    },
    [clipDuration, setInserts, setSubtitles],
  );

  const handleUndo = useCallback(() => {
    const projectNow = useProjectStore.getState().project;
    if (!projectNow || !selectedClipId) return;
    const key = `${projectNow.id}:${selectedClipId}`;
    const entry = historyRef.current.get(key);
    const previous = entry?.past.pop();
    if (!entry || !previous) return;
    lastTextEditRef.current = null;
    const currentCues = projectNow.subtitles[selectedClipId] ?? [];
    const currentInserts = projectNow.inserts?.[selectedClipId] ?? [];
    entry.future.push({
      cues: cloneCues(currentCues),
      inserts: cloneInserts(currentInserts),
    });
    if (entry.future.length > MAX_UNDO_HISTORY) {
      entry.future.splice(0, entry.future.length - MAX_UNDO_HISTORY);
    }
    applyHistorySnapshot(selectedClipId, previous);
  }, [applyHistorySnapshot, selectedClipId]);

  const handleRedo = useCallback(() => {
    const projectNow = useProjectStore.getState().project;
    if (!projectNow || !selectedClipId) return;
    const key = `${projectNow.id}:${selectedClipId}`;
    const entry = historyRef.current.get(key);
    const next = entry?.future.pop();
    if (!entry || !next) return;
    lastTextEditRef.current = null;
    const currentCues = projectNow.subtitles[selectedClipId] ?? [];
    const currentInserts = projectNow.inserts?.[selectedClipId] ?? [];
    entry.past.push({
      cues: cloneCues(currentCues),
      inserts: cloneInserts(currentInserts),
    });
    if (entry.past.length > MAX_UNDO_HISTORY) {
      entry.past.splice(0, entry.past.length - MAX_UNDO_HISTORY);
    }
    applyHistorySnapshot(selectedClipId, next);
  }, [applyHistorySnapshot, selectedClipId]);

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
  const activeCue = useMemo(() => {
    const pool = filter === "unchecked" ? visibleCues.map((entry) => entry.cue) : cues;
    return pool.find((cue) => cue.id === activeCueId) ?? pool[0] ?? null;
  }, [activeCueId, cues, filter, visibleCues]);
  const activeCueKey = activeCue?.id ?? null;
  const playingCueId = useMemo(() => {
    if (!playing) return null;
    return cues.find((cue) => playhead >= cue.start - 0.001 && playhead < cue.end)?.id ?? null;
  }, [cues, playhead, playing]);
  const { canSplitAtPlayhead, canSetStartToPlayhead, canSetEndToPlayhead } = useMemo(() => {
    if (!activeCue) {
      return {
        canSplitAtPlayhead: false,
        canSetStartToPlayhead: false,
        canSetEndToPlayhead: false,
      };
    }
    const sorted = [...cues].sort((a, b) => a.start - b.start);
    const idx = sorted.findIndex((item) => item.id === activeCue.id);
    const prevCue = idx > 0 ? sorted[idx - 1] : null;
    const nextCue = idx >= 0 && idx + 1 < sorted.length ? sorted[idx + 1] : null;
    const lowerBound = prevCue ? prevCue.end + NEIGHBOUR_GAP : 0;
    const upperBound = nextCue ? nextCue.start - NEIGHBOUR_GAP : clipDuration;
    return {
      canSplitAtPlayhead:
        activeCue.end - activeCue.start >= MIN_SPLITTABLE_DURATION - 0.001 &&
        playhead >= activeCue.start + MIN_CUE_SECONDS - 0.001 &&
        playhead <= activeCue.end - MIN_CUE_SECONDS + 0.001,
      canSetStartToPlayhead:
        playhead >= lowerBound - 0.001 &&
        playhead <= activeCue.end - MIN_CUE_SECONDS + 0.001 &&
        lowerBound <= activeCue.end - MIN_CUE_SECONDS + 0.001,
      canSetEndToPlayhead:
        playhead >= activeCue.start + MIN_CUE_SECONDS - 0.001 &&
        playhead <= upperBound + 0.001 &&
        activeCue.start + MIN_CUE_SECONDS - 0.001 <= upperBound,
    };
  }, [activeCue, clipDuration, cues, playhead]);
  const arabicPassages = useMemo(
    () =>
      cues.filter(
        (cue) => cue.arabic.trim() && !cue.thai.trim() && (cue.source || cue.originalText),
      ),
    [cues],
  );
  const verifiedArabicCount = arabicPassages.filter((cue) => cue.source === "quran").length;
  const unreviewedArabicCount = arabicPassages.filter((cue) => !cue.reviewed).length;
  const unreviewedVerifiedArabicCount = arabicPassages.filter(
    (cue) => cue.source === "quran" && !cue.reviewed,
  ).length;

  /* Seed the cue list from the transcript the first time a clip is opened.
     Raw transcript segments are not subtitle lines: rebuild them into readable
     lines, and auto-heal a track saved by the old one-cue-per-segment seeding. */
  useEffect(() => {
    const current = useProjectStore.getState().project;
    if (!current || approvedClips.length === 0) return;
    const segments = current.transcript?.segments ?? [];
    if (!segments.length) return;

    // Seed all approved clips that don't yet have a saved track (check hasOwnProperty
    // so an intentionally emptied track `[]` is never silently re-seeded).
    const patch: Record<string, SubtitleCue[]> = {};
    for (const clip of approvedClips) {
      if (Object.prototype.hasOwnProperty.call(current.subtitles, clip.id)) continue;
      const seeded = buildCuesFromTranscript(segments, {
        clipStart: clip.start,
        clipEnd: clip.end,
        maxCharsPerLine,
        maxLines,
        arabicMaxCharsPerLine,
      });
      if (seeded.length) patch[clip.id] = seeded;
    }
    if (Object.keys(patch).length > 0) {
      setSubtitlesBatch(patch);
      if (selectedClip && patch[selectedClip.id]) return;
    }

    if (!selectedClip) return;
    if (!Object.prototype.hasOwnProperty.call(current.subtitles, selectedClip.id)) return;
    const existing = current.subtitles[selectedClip.id] ?? [];
    if (existing.length === 0) return;

    const flatten = (list: SubtitleCue[]) =>
      list
        .map((cue) => `${cue.arabic}${cue.thai}`)
        .join("")
        .replace(/\s+/g, "");

    const isBrokenTrack =
      looksLikeBrokenBoundaryTrack(existing) &&
      !existing.some((cue) => cue.reviewed) &&
      !manualEditClipsRef.current.has(selectedClip.id);
    const isFragmentTrack = !isBrokenTrack && looksLikeFragmentSeed(existing);
    if (!isBrokenTrack && !isFragmentTrack) return;

    const key = `${selectedClip.id}:${existing.length}:${isBrokenTrack ? "broken" : "fragment"}`;
    if (healedSeedRef.current === key) return;
    healedSeedRef.current = key;

    const rebuilt = buildCuesFromTranscript(segments, {
      clipStart: selectedClip.start,
      clipEnd: selectedClip.end,
      maxCharsPerLine,
      maxLines,
      arabicMaxCharsPerLine,
    });
    if (!rebuilt.length) return;

    // Auto-heal broken 0.05s sliver tracks unconditionally when unreviewed (clean
    // slicing may skip a grazed out-of-clip segment so text lengths differ);
    // fragment tracks still require identical flattened text.
    if (isBrokenTrack || flatten(existing) === flatten(rebuilt)) {
      setSubtitles(selectedClip.id, rebuilt);
      toast("Subtitle lines rebuilt", {
        description: `Merged ${existing.length} ${
          isBrokenTrack ? "broken lines" : "transcript fragments"
        } into ${rebuilt.length} readable line${rebuilt.length === 1 ? "" : "s"}.`,
      });
    }
  }, [
    approvedClips,
    arabicMaxCharsPerLine,
    maxCharsPerLine,
    maxLines,
    project?.id,
    project?.transcript,
    project?.transcriptId,
    selectedClip,
    setSubtitles,
    setSubtitlesBatch,
  ]);

  /**
   * Detect a saved track that was generated before word-safe cuts (or by a
   * different rule) even when it no longer looks like a sliver seed: the cue
   * text still matches the transcript, has actual mid-word Thai cuts, and the
   * cue boundaries do not match the word-stream rebuild.
   */
  useEffect(() => {
    if (!selectedClip) {
      setRebuildHint(false);
      return;
    }
    if (manualEditClipsRef.current.has(selectedClip.id)) {
      setRebuildHint(false);
      return;
    }
    const current = useProjectStore.getState().project;
    const existing = current?.subtitles[selectedClip.id] ?? [];
    const segments = current?.transcript?.segments ?? [];
    if (
      !existing.length ||
      !segments.length ||
      existing.some((cue) => cue.reviewed || cue.edited)
    ) {
      setRebuildHint(false);
      return;
    }
    if (looksLikeBrokenBoundaryTrack(existing) || looksLikeFragmentSeed(existing)) {
      // The auto-heal above owns these cases.
      setRebuildHint(false);
      return;
    }
    if (!hasMidWordCut(existing)) {
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

  /** Explicit reset/rebuild back to the transcript-derived default cues. */
  const handleRebuild = useCallback(
    (mode: "reset" | "rebuild" = "rebuild") => {
      if (!selectedClip) return;
      const segments = project?.transcript?.segments ?? [];
      if (!segments.length) return;
      const latest = useProjectStore.getState().project?.subtitles[selectedClip.id] ?? [];
      const rebuilt = buildCuesFromTranscript(segments, {
        clipStart: selectedClip.start,
        clipEnd: selectedClip.end,
        maxCharsPerLine,
        maxLines,
        arabicMaxCharsPerLine,
      });
      if (mode === "rebuild" && !rebuilt.length) return;
      pushHistory(selectedClip.id, latest);
      manualEditClipsRef.current.delete(selectedClip.id);
      seekKeyRef.current = `${selectedClip.id}:${rebuilt[0]?.id ?? "empty"}`;
      setSubtitles(selectedClip.id, rebuilt);
      healedSeedRef.current = `${selectedClip.id}:${rebuilt.length}`;
      setRebuildHint(false);
      setActiveCueId(rebuilt[0]?.id ?? null);
      monitorRef.current?.pause();
      monitorRef.current?.seekTo(selectedClip.start + (rebuilt[0]?.start ?? 0) + 0.05);
      setPlayhead(rebuilt[0]?.start ?? 0);
      if (mode === "reset") {
        toast.success(L("Subtitles reset to default"), {
          description: `${rebuilt.length} line${rebuilt.length === 1 ? "" : "s"} restored from the transcript.`,
        });
      } else {
        toast.success("Subtitle lines rebuilt", {
          description: `${rebuilt.length} readable line${rebuilt.length === 1 ? "" : "s"} from the transcript.`,
        });
      }
    },
    [
      arabicMaxCharsPerLine,
      maxCharsPerLine,
      maxLines,
      project?.transcript?.segments,
      pushHistory,
      selectedClip,
      setSubtitles,
    ],
  );

  /** Mark every corpus-verified Qur'an passage in this clip as reviewed. */
  const approveAllVerifiedArabic = () => {
    if (!selectedClipId) return;
    const latest = useProjectStore.getState().project?.subtitles[selectedClipId] ?? [];
    const verified = latest.filter((cue) => cue.source === "quran" && !cue.reviewed);
    if (!verified.length) return;
    pushHistory(selectedClipId, latest);
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
    pushHistory(selectedClipId, latest);
    manualEditClipsRef.current.add(selectedClipId);
    setRebuildHint(false);
    setSubtitles(
      selectedClipId,
      latest.map((item) =>
        item.id === cueId
          ? {
              ...item,
              arabic: "",
              thai: wrapSubtitleText(original, maxCharsPerLine),
              source: undefined,
              reference: undefined,
              confidence: undefined,
              originalText: undefined,
              translation: undefined,
              reviewed: false,
              edited: true,
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
    lastTextEditRef.current = null;
    setActiveCueId(null);
    setSelectedInsertId(null);
    setInsertPopoverOpen(false);
    setPlayhead(0);
    setPlaying(false);
    setRate(1);
    setRibbonZoom(1);
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
  const overlap = stylesOverlap(styles.arabic, styles.thai, maxLines, 1);

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

  const playClipContinuous = useCallback(
    (fromSeconds?: number, restart = false) => {
      if (!selectedClip || clipDuration <= 0) return;
      const base = fromSeconds ?? (playhead >= clipDuration - 0.05 ? 0 : playhead);
      const from = clamp(base, 0, Math.max(0, clipDuration));
      setOverlayMode("playhead");
      monitorRef.current?.playRange(
        selectedClip.start + from,
        selectedClip.start + clipDuration,
        restart,
      );
    },
    [clipDuration, playhead, selectedClip],
  );

  const playCue = useCallback(
    (cue: SubtitleCue) => {
      setActiveCueId(cue.id);
      if (!selectedClip) return;
      if (continuousPlay) {
        const resumeInside =
          activeCue?.id === cue.id &&
          playhead >= cue.start - 0.05 &&
          playhead < cue.end - 0.05;
        playClipContinuous(resumeInside ? playhead : cue.start, !resumeInside);
        return;
      }
      setOverlayMode("cue");
      monitorRef.current?.playRange(selectedClip.start + cue.start, selectedClip.start + cue.end);
    },
    [activeCue?.id, continuousPlay, playClipContinuous, playhead, selectedClip],
  );

  const selectCue = useCallback(
    (cue: SubtitleCue) => {
      setActiveCueId(cue.id);
      setOverlayMode("cue");
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
    if (continuousPlay) {
      playClipContinuous();
      return;
    }
    if (activeCue) playCue(activeCue);
  }, [activeCue, continuousPlay, playClipContinuous, playCue, playing]);

  const toggleContinuousPlay = useCallback(() => {
    const next = !continuousPlay;
    setContinuousPlay(next);
    if (playing && selectedClip) {
      if (next) {
        setOverlayMode("playhead");
        monitorRef.current?.setRangeEnd(selectedClip.start + clipDuration);
      } else if (activeCue) {
        monitorRef.current?.setRangeEnd(selectedClip.start + activeCue.end);
      } else {
        monitorRef.current?.pause();
      }
    }
  }, [activeCue, clipDuration, continuousPlay, playing, selectedClip]);

  const applyRate = useCallback((next: number) => {
    setRate(next);
    monitorRef.current?.setPlaybackRate(next);
  }, []);

  const shuttle = useCallback(
    (direction: -1 | 1) => {
      const current = monitorRef.current?.getPlaybackRate() ?? rate;
      if (direction === 1) {
        if (continuousPlay) playClipContinuous();
        else if (activeCue) playCue(activeCue);
        const faster =
          SHUTTLE_RATES.find((entry) => entry > current + 0.001) ??
          SHUTTLE_RATES[SHUTTLE_RATES.length - 1];
        applyRate(faster);
        return;
      }
      const slower = [...SHUTTLE_RATES].reverse().find((entry) => entry < current - 0.001);
      if (slower === undefined) {
        monitorRef.current?.seekBy(-2, true);
        return;
      }
      if (continuousPlay) playClipContinuous();
      else if (activeCue) playCue(activeCue);
      applyRate(slower);
    },
    [activeCue, applyRate, continuousPlay, playClipContinuous, playCue, rate],
  );

  const pauseShuttle = useCallback(() => {
    monitorRef.current?.pause();
    applyRate(1);
  }, [applyRate]);

  const moveCue = useCallback(
    (direction: -1 | 1) => {
      const pool = filter === "unchecked" ? visibleCues.map((entry) => entry.cue) : cues;
      if (pool.length === 0) return;
      const index = pool.findIndex((cue) => cue.id === activeCue?.id);
      const target = index < 0 ? pool[0] : pool[index + direction];
      if (target) selectCue(target);
    },
    [activeCue?.id, cues, filter, selectCue, visibleCues],
  );

  /* ------------------------------ editing ------------------------------- */

  const handleCueChange = useCallback(
    (cueId: string, field: CueField, value: string) => {
      if (!selectedClipId) return;
      manualEditClipsRef.current.add(selectedClipId);
      setRebuildHint(false);
      // Store the raw value; Thai wraps on commit (blur/split), not on every
      // keystroke, so typing past the wrap width never jumps the caret.
      const projectNow = useProjectStore.getState().project;
      const latest = projectNow?.subtitles[selectedClipId] ?? [];
      const targetCue = latest.find((cue) => cue.id === cueId);
      if (!targetCue || targetCue[field] === value) return;
      pushHistory(
        selectedClipId,
        latest,
        `${projectNow?.id ?? ""}:${selectedClipId}:${cueId}:${field}`,
      );
      const next = latest.map((cue) => {
        if (cue.id !== cueId) return cue;
        if (field === "arabic" && value !== cue.arabic) {
          return {
            ...cue,
            arabic: value,
            reviewed: false,
            edited: true,
            source: undefined,
            reference: undefined,
            confidence: undefined,
            translation: undefined,
          };
        }
        return { ...cue, [field]: value, reviewed: false, edited: true };
      });
      setSubtitles(selectedClipId, next);
    },
    [pushHistory, selectedClipId, setSubtitles],
  );

  const handleCueBlur = useCallback(
    (cueId: string, field: CueField) => {
      lastTextEditRef.current = null;
      if (!selectedClipId) return;
      const latest = useProjectStore.getState().project?.subtitles[selectedClipId] ?? [];
      let changed = false;
      const next = latest.map((cue) => {
        if (cue.id !== cueId) return cue;
        if (field === "thai") {
          const wrapped = wrapSubtitleText(cue.thai, maxCharsPerLine);
          if (wrapped === cue.thai) return cue;
          changed = true;
          return { ...cue, thai: wrapped };
        }
        const wrapped = wrapArabicText(cue.arabic, arabicMaxCharsPerLine);
        if (wrapped === cue.arabic) return cue;
        changed = true;
        return { ...cue, arabic: wrapped };
      });
      if (changed) setSubtitles(selectedClipId, next);
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
      const targetCue = latest.find((cue) => cue.id === cueId);
      if (!targetCue || Boolean(targetCue.reviewed) === reviewed) return;
      pushHistory(selectedClipId, latest);
      setSubtitles(
        selectedClipId,
        latest.map((cue) => (cue.id === cueId ? { ...cue, reviewed } : cue)),
      );
    },
    [pushHistory, selectedClipId, setSubtitles],
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
      const targetCue = latest.find((cue) => cue.id === cueId);
      if (!targetCue || (targetCue.start === start && targetCue.end === end)) return;
      manualEditClipsRef.current.add(selectedClipId);
      setRebuildHint(false);
      pushHistory(selectedClipId, latest);
      setSubtitles(
        selectedClipId,
        latest.map((cue) => (cue.id === cueId ? { ...cue, start, end, edited: true } : cue)),
      );
      setPlayhead((current) => clamp(current, 0, Math.max(0, clipDuration)));
    },
    [clipDuration, pushHistory, selectedClipId, setSubtitles],
  );

  const updateCuePair = useCallback(
    (leftId: string, leftEnd: number, rightId: string, rightStart: number) => {
      if (!selectedClipId) return;
      const latest = useProjectStore.getState().project?.subtitles[selectedClipId] ?? [];
      const leftCue = latest.find((cue) => cue.id === leftId);
      const rightCue = latest.find((cue) => cue.id === rightId);
      if (!leftCue || !rightCue) return;
      if (leftCue.end === leftEnd && rightCue.start === rightStart) return;
      manualEditClipsRef.current.add(selectedClipId);
      setRebuildHint(false);
      pushHistory(selectedClipId, latest);
      setSubtitles(
        selectedClipId,
        latest.map((cue) => {
          if (cue.id === leftId) return { ...cue, end: leftEnd, edited: true };
          if (cue.id === rightId) return { ...cue, start: rightStart, edited: true };
          return cue;
        }),
      );
      setPlayhead((current) => clamp(current, 0, Math.max(0, clipDuration)));
    },
    [clipDuration, pushHistory, selectedClipId, setSubtitles],
  );

  /* -------------------------- insert footage --------------------------- */

  // Probe insert files in the desktop runtime so moved/deleted files flag cleanly.
  useEffect(() => {
    if (!isTauriRuntime() || inserts.length === 0) {
      setMissingInsertIds(new Set());
      return;
    }
    let cancelled = false;
    void (async () => {
      const next = new Set<string>();
      for (const item of inserts) {
        if (/^(https?:|data:|blob:)/i.test(item.path)) continue;
        const src = toMediaSrc(item.path);
        if (!src) continue;
        const probe = await probeMediaSrc(src);
        if (!probe.ok && probe.status !== null) {
          next.add(item.id);
        }
      }
      if (!cancelled) setMissingInsertIds(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [inserts]);

  const addInsertMediaPicks = useCallback(
    async (picks: InsertMediaPick[]) => {
      if (!selectedClipId || !selectedClip || picks.length === 0) return;
      const projectNow = useProjectStore.getState().project;
      if (!projectNow) return;
      const latestCues = projectNow.subtitles[selectedClipId] ?? [];
      const latestInserts = projectNow.inserts?.[selectedClipId] ?? [];
      const working = cloneInserts(latestInserts);
      const added: MediaInsert[] = [];
      let anyTrimmed = false;

      for (const pick of picks) {
        let meta: { duration: number | null; width: number | null; height: number | null };
        try {
          meta = await probeInsertMedia(pick.path, pick.kind);
        } catch (error) {
          toast.error("Could not load media", {
            description: `${pick.name}: ${error instanceof Error ? error.message : String(error)}`,
          });
          continue;
        }

        const placement = resolveInsertPlacement({
          existing: working,
          clipDuration,
          playhead,
          kind: pick.kind,
          sourceDuration: meta.duration,
        });

        if (!placement.ok) {
          if (placement.reason === "too-long") {
            toast.error("Video is too long for this clip", {
              description: `${pick.name} is ${formatClock(placement.sourceDuration ?? 0, true)}, which exceeds this ${formatClock(placement.clipDuration ?? clipDuration, true)} clip.`,
            });
          } else if (placement.reason === "invalid-duration") {
            toast.error("Could not read video duration", { description: pick.name });
          } else {
            toast.error("No room on the insert track", {
              description: "Shorten or move an existing insert block first.",
            });
          }
          continue;
        }

        if (placement.trimmedToFit) anyTrimmed = true;
        const created: MediaInsert = {
          id: crypto.randomUUID(),
          kind: pick.kind,
          path: pick.path,
          name: pick.name,
          start: placement.start,
          end: placement.end,
          sourceStart: placement.sourceStart,
          sourceDuration: meta.duration,
          rect: { ...DEFAULT_INSERT_RECT },
          fit: pick.kind === "video" ? "cover" : "blur-fill",
          muted: true,
          fade: 0,
          naturalWidth: meta.width,
          naturalHeight: meta.height,
        };
        working.push(created);
        working.sort((a, b) => a.start - b.start || a.end - b.end);
        added.push(created);
      }

      if (added.length === 0) return;
      const last = added[added.length - 1];
      pushHistory(selectedClipId, latestCues, undefined, latestInserts);
      setInserts(selectedClipId, working);
      setSelectedInsertId(last.id);
      monitorRef.current?.pause();
      setOverlayMode("playhead");
      const previewAt = Math.min(last.end - 0.01, last.start + 0.02);
      monitorRef.current?.seekTo(clipStart + previewAt);
      setPlayhead(Math.max(0, previewAt));

      if (anyTrimmed) {
        toast.info("Video shortened to fit available gap", {
          description: "Drag the edges or free up space on the insert track to extend it.",
        });
      }
    },
    [clipDuration, clipStart, playhead, pushHistory, selectedClip, selectedClipId, setInserts],
  );

  const handleBrowseInsertMedia = useCallback(async () => {
    const picks = await openInsertMediaFiles();
    if (picks.length > 0) {
      await addInsertMediaPicks(picks);
    }
  }, [addInsertMediaPicks]);

  const handleDropInsertFiles = useCallback(
    async (fileList: FileList) => {
      const picks: InsertMediaPick[] = [];
      for (const file of Array.from(fileList)) {
        const path = (file as File & { path?: string }).path ?? null;
        let kind = classifyInsertFile(file.name);
        if (!kind) {
          if (file.type.startsWith("image/")) kind = "image";
          else if (file.type.startsWith("video/")) kind = "video";
        }
        if (!kind) continue;
        picks.push({
          path: path ?? URL.createObjectURL(file),
          name: file.name || (kind === "image" ? "image.png" : "video.mp4"),
          kind,
        });
      }
      if (picks.length === 0) {
        toast.error("Unsupported media type", {
          description: "Drop PNG, JPG, WebP images or MP4, MOV, MKV, WebM videos.",
        });
        return;
      }
      await addInsertMediaPicks(picks);
    },
    [addInsertMediaPicks],
  );

  const updateInsertTiming = useCallback(
    (insertId: string, patch: Pick<MediaInsert, "start" | "end" | "sourceStart">) => {
      if (!selectedClipId) return;
      const projectNow = useProjectStore.getState().project;
      const latestCues = projectNow?.subtitles[selectedClipId] ?? [];
      const latestInserts = projectNow?.inserts?.[selectedClipId] ?? [];
      const target = latestInserts.find((item) => item.id === insertId);
      if (!target) return;
      if (
        target.start === patch.start &&
        target.end === patch.end &&
        target.sourceStart === patch.sourceStart
      ) {
        return;
      }
      pushHistory(selectedClipId, latestCues, undefined, latestInserts);
      setInserts(
        selectedClipId,
        latestInserts
          .map((item) => (item.id === insertId ? { ...item, ...patch } : item))
          .sort((a, b) => a.start - b.start || a.end - b.end),
      );
      setPlayhead((current) => clamp(current, 0, Math.max(0, clipDuration)));
    },
    [clipDuration, pushHistory, selectedClipId, setInserts],
  );

  const updateInsertRect = useCallback(
    (insertId: string, rect: InsertRect) => {
      if (!selectedClipId) return;
      const projectNow = useProjectStore.getState().project;
      const latestCues = projectNow?.subtitles[selectedClipId] ?? [];
      const latestInserts = projectNow?.inserts?.[selectedClipId] ?? [];
      if (!latestInserts.some((item) => item.id === insertId)) return;
      pushHistory(selectedClipId, latestCues, undefined, latestInserts);
      setInserts(
        selectedClipId,
        latestInserts.map((item) => (item.id === insertId ? { ...item, rect } : item)),
      );
    },
    [pushHistory, selectedClipId, setInserts],
  );

  const updateInsertMeta = useCallback(
    (insertId: string, patch: Partial<Pick<MediaInsert, "fit" | "fade" | "rect">>) => {
      if (!selectedClipId) return;
      const projectNow = useProjectStore.getState().project;
      const latestCues = projectNow?.subtitles[selectedClipId] ?? [];
      const latestInserts = projectNow?.inserts?.[selectedClipId] ?? [];
      if (!latestInserts.some((item) => item.id === insertId)) return;
      pushHistory(selectedClipId, latestCues, undefined, latestInserts);
      setInserts(
        selectedClipId,
        latestInserts.map((item) => (item.id === insertId ? { ...item, ...patch } : item)),
      );
    },
    [pushHistory, selectedClipId, setInserts],
  );

  const matchInsertToActiveCue = useCallback(
    (insertId: string) => {
      if (!selectedClipId || !activeCue) return;
      const projectNow = useProjectStore.getState().project;
      const latestCues = projectNow?.subtitles[selectedClipId] ?? [];
      const latestInserts = projectNow?.inserts?.[selectedClipId] ?? [];
      const sorted = [...latestInserts].sort((a, b) => a.start - b.start || a.end - b.end);
      const index = sorted.findIndex((item) => item.id === insertId);
      if (index < 0) return;
      const target = sorted[index];
      const prev = index > 0 ? sorted[index - 1] : null;
      const next = index + 1 < sorted.length ? sorted[index + 1] : null;
      const lower = prev ? prev.end + 0.02 : 0;
      const upper = next ? next.start - 0.02 : clipDuration;
      const start = clamp(activeCue.start, lower, Math.max(lower, upper - 0.2));
      const maxEndForVideo =
        target.kind === "video" && target.sourceDuration !== null
          ? start + Math.max(0, target.sourceDuration - target.sourceStart)
          : upper;
      const end = clamp(activeCue.end, start + 0.2, Math.min(upper, maxEndForVideo));
      if (end - start < 0.2) {
        toast.error("No room to match this subtitle line", {
          description: "Adjacent insert footage blocks this time range.",
        });
        return;
      }
      pushHistory(selectedClipId, latestCues, undefined, latestInserts);
      setInserts(
        selectedClipId,
        latestInserts
          .map((item) => (item.id === insertId ? { ...item, start, end } : item))
          .sort((a, b) => a.start - b.start || a.end - b.end),
      );
      monitorRef.current?.pause();
      setOverlayMode("playhead");
      monitorRef.current?.seekTo(clipStart + start + 0.02);
      setPlayhead(start + 0.02);
    },
    [activeCue, clipDuration, clipStart, pushHistory, selectedClipId, setInserts],
  );

  const replaceInsertFile = useCallback(
    async (insertId: string) => {
      if (!selectedClipId) return;
      const picks = await openInsertMediaFiles();
      const pick = picks[0];
      if (!pick) return;
      let meta: { duration: number | null; width: number | null; height: number | null };
      try {
        meta = await probeInsertMedia(pick.path, pick.kind);
      } catch (error) {
        toast.error("Could not load media", {
          description: `${pick.name}: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }
      if (
        pick.kind === "video" &&
        (meta.duration === null || meta.duration > clipDuration + 0.001)
      ) {
        toast.error("Video is too long for this clip", {
          description: `${pick.name} cannot replace this insert because it is longer than the clip.`,
        });
        return;
      }
      const projectNow = useProjectStore.getState().project;
      const latestCues = projectNow?.subtitles[selectedClipId] ?? [];
      const latestInserts = projectNow?.inserts?.[selectedClipId] ?? [];
      const target = latestInserts.find((item) => item.id === insertId);
      if (!target) return;
      const end =
        pick.kind === "video" && meta.duration !== null
          ? Math.min(target.end, target.start + meta.duration)
          : target.end;
      pushHistory(selectedClipId, latestCues, undefined, latestInserts);
      setInserts(
        selectedClipId,
        latestInserts.map((item) =>
          item.id === insertId
            ? {
                ...item,
                kind: pick.kind,
                path: pick.path,
                name: pick.name,
                sourceStart: 0,
                sourceDuration: meta.duration,
                end,
                naturalWidth: meta.width,
                naturalHeight: meta.height,
              }
            : item,
        ),
      );
    },
    [clipDuration, pushHistory, selectedClipId, setInserts],
  );

  const deleteInsert = useCallback(
    (insertId: string) => {
      if (!selectedClipId) return;
      const projectNow = useProjectStore.getState().project;
      const owningProjectId = projectNow?.id ?? null;
      const latestCues = projectNow?.subtitles[selectedClipId] ?? [];
      const latestInserts = projectNow?.inserts?.[selectedClipId] ?? [];
      const removed = latestInserts.find((item) => item.id === insertId);
      if (!removed) return;
      const next = latestInserts.filter((item) => item.id !== insertId);
      pushHistory(selectedClipId, latestCues, undefined, latestInserts);
      setInserts(selectedClipId, next);
      setInsertPopoverOpen(false);
      setSelectedInsertId((prev) => (prev === insertId ? null : prev));

      toast("Insert removed", {
        description: removed.name,
        action: {
          label: "Undo",
          onClick: () => {
            const current = useProjectStore.getState().project;
            if (!owningProjectId || current?.id !== owningProjectId) return;
            const list = current.inserts?.[selectedClipId] ?? [];
            if (list.some((item) => item.id === removed.id)) return;
            useProjectStore
              .getState()
              .setInserts(
                selectedClipId,
                [...list, removed].sort((a, b) => a.start - b.start || a.end - b.end),
              );
            setSelectedInsertId(removed.id);
          },
        },
      });
    },
    [pushHistory, selectedClipId, setInserts],
  );

  // Native file drag-drop when Step 3 is active without modal overlays.
  useEffect(() => {
    if (!selectedClipId || settingsOpen || configStep !== null) return;
    return subscribeNativeDrops({
      onEnter: () => setInsertDragOver(true),
      onLeave: () => setInsertDragOver(false),
      onDrop: (paths) => {
        setInsertDragOver(false);
        const picks: InsertMediaPick[] = [];
        for (const path of paths) {
          const kind = classifyInsertFile(path);
          if (kind) {
            picks.push({ path, name: path.split(/[\\/]/).pop() || path, kind });
          }
        }
        if (picks.length === 0) {
          toast.error("Unsupported media type", {
            description: "Drop PNG, JPG, WebP images or MP4, MOV, MKV, WebM videos.",
          });
          return;
        }
        void addInsertMediaPicks(picks);
      },
    });
  }, [addInsertMediaPicks, configStep, selectedClipId, settingsOpen]);

  // Literal Ctrl+V paste for copied Explorer files or screenshots/images.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (settingsOpen || configStep !== null || !selectedClipId || clipDuration <= 0) return;
      if (
        document.querySelector(
          '[data-slot="dialog-content"][data-state="open"], [data-vaul-drawer][data-state="open"], [data-slot="popover-content"][data-state="open"], [data-slot="select-content"][data-state="open"]',
        )
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      const inTextInput = Boolean(
        target &&
          (target.isContentEditable ||
            ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)),
      );
      if (inTextInput) return;
      const activeEl = document.activeElement as HTMLElement | null;
      if (
        activeEl &&
        (activeEl.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(activeEl.tagName))
      ) {
        return;
      }

      const projectId = useProjectStore.getState().project?.id ?? "default";
      const items = Array.from(event.clipboardData?.items ?? []);
      const files = Array.from(event.clipboardData?.files ?? []);

      const blobs: File[] = [];
      for (const item of items) {
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f) blobs.push(f);
        }
      }
      for (const file of files) {
        if (!blobs.some((b) => b.name === file.name && b.size === file.size && b.type === file.type)) {
          blobs.push(file);
        }
      }

      if (blobs.length > 0) {
        event.preventDefault();
        void (async () => {
          const picks: InsertMediaPick[] = [];
          for (const blob of blobs) {
            const diskPath = (blob as File & { path?: string }).path;
            if (diskPath) {
              const kind = classifyInsertFile(diskPath);
              if (kind) {
                picks.push({ path: diskPath, name: blob.name || diskPath, kind });
                continue;
              }
            }
            if (blob.type.startsWith("image/") || classifyInsertFile(blob.name) === "image") {
              try {
                const saved = await saveClipboardImage(projectId, blob, blob.name);
                if (saved) picks.push(saved);
              } catch (error) {
                toast.error("Could not paste image", {
                  description: error instanceof Error ? error.message : String(error),
                });
              }
            } else if (blob.type.startsWith("video/") || classifyInsertFile(blob.name) === "video") {
              picks.push({
                path: URL.createObjectURL(blob),
                name: blob.name || "pasted-video.mp4",
                kind: "video",
              });
            }
          }
          if (picks.length > 0) {
            await addInsertMediaPicks(picks);
          } else {
            toast.error("Nothing supported to paste", {
              description: "Copy an image, screenshot, or video file first.",
            });
          }
        })();
        return;
      }

      if (isTauriRuntime()) {
        void (async () => {
          const paths = await readClipboardFilePaths();
          const picks: InsertMediaPick[] = [];
          for (const path of paths) {
            const kind = classifyInsertFile(path);
            if (kind) {
              picks.push({ path, name: path.split(/[\\/]/).pop() || path, kind });
            }
          }
          if (picks.length > 0) {
            await addInsertMediaPicks(picks);
          }
        })();
      }
    };

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addInsertMediaPicks, clipDuration, configStep, selectedClipId, settingsOpen]);

  /**
   * Ctrl+Enter (or the Split button) cuts the line at the textarea caret: the
   * edited line is cut where the cursor sits, the other language line is cut at
   * a safe word boundary, and the time range follows the speech cascade.
   */
  const handleSplit = useCallback(
    (
      cueId: string,
      field: CueField,
      cursor: number,
      explicitTime?: number | null,
    ) => {
      if (!selectedClipId) return;
      setRebuildHint(false);
      const projectNow = useProjectStore.getState().project;
      const latest = projectNow?.subtitles[selectedClipId] ?? [];
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

      const editedFirst = unwrapLines(edited.slice(0, offset));
      const editedSecond = unwrapLines(edited.slice(offset));
      if (!editedFirst || !editedSecond) {
        toast.error("Both halves need text", {
          description: "Move the cursor away from the edge of the line and try again.",
        });
        return;
      }

      const firstWeight = spokenWeight(editedFirst, field);
      const secondWeight = spokenWeight(editedSecond, field);
      const ratio = firstWeight / Math.max(1, firstWeight + secondWeight);
      const other = field === "arabic" ? cue.thai : cue.arabic;
      // The counterpart is cut at a word boundary, never at a character ratio:
      // a proportional slice severs Thai word clusters and pulls Arabic Harakat
      // away from their letters. A pair with no safe break (one long Arabic
      // word) is refused instead of being mutilated.
      const otherOffset = other.trim()
        ? splitAtWordBoundary(other, ratio, field === "arabic" ? "thai" : "arabic")
        : 0;
      const otherFirst = unwrapLines(other.slice(0, otherOffset));
      const otherSecond = unwrapLines(other.slice(otherOffset));
      if (other.trim() && (!otherFirst || !otherSecond)) {
        toast.error("Can't split this pair of lines here", {
          description:
            "The other language has no word break near the cursor. Move the cursor and try again.",
        });
        return;
      }

      const duration = cue.end - cue.start;
      if (duration < MIN_SPLITTABLE_DURATION - 0.001) {
        toast.error("This line is too short to split", {
          description: "Make the surrounding lines longer first.",
        });
        return;
      }

      const timing = resolveSplitTiming({
        cueStart: cue.start,
        cueEnd: cue.end,
        clipStart,
        lectureDuration: projectNow?.duration ?? null,
        field,
        firstText: editedFirst,
        secondText: editedSecond,
        segments: projectNow?.transcript?.segments ?? null,
        peaks: projectNow?.transcript?.peaks ?? null,
        explicitTime,
      });
      if (!timing) {
        toast.error("This line is too short to split", {
          description: "Make the surrounding lines longer first.",
        });
        return;
      }

      const first: SubtitleCue = {
        ...cue,
        id: crypto.randomUUID(),
        end: timing.firstEnd,
        arabic: wrapArabicText(
          field === "arabic" ? editedFirst : otherFirst,
          arabicMaxCharsPerLine,
        ),
        thai: wrapSubtitleText(
          field === "thai" ? editedFirst : otherFirst,
          maxCharsPerLine,
        ),
        source: undefined,
        reference: undefined,
        confidence: undefined,
        originalText: undefined,
        translation: undefined,
        reviewed: false,
        edited: true,
      };
      const second: SubtitleCue = {
        ...cue,
        id: crypto.randomUUID(),
        start: timing.secondStart,
        arabic: wrapArabicText(
          field === "arabic" ? editedSecond : otherSecond,
          arabicMaxCharsPerLine,
        ),
        thai: wrapSubtitleText(
          field === "thai" ? editedSecond : otherSecond,
          maxCharsPerLine,
        ),
        source: undefined,
        reference: undefined,
        confidence: undefined,
        originalText: undefined,
        translation: undefined,
        reviewed: false,
        edited: true,
      };

      const index = latest.findIndex((item) => item.id === cueId);
      const next = [...latest];
      next.splice(index, 1, first, second);
      manualEditClipsRef.current.add(selectedClipId);
      caretRef.current = null;
      if (index === 0) {
        // Splitting line 0 gives it a fresh id; keep the park key synced so
        // editing the split does not jump the monitor back to start.
        seekKeyRef.current = `${selectedClipId}:${next[0]?.id ?? "empty"}`;
      }
      pushHistory(selectedClipId, latest);
      setSubtitles(selectedClipId, next);
      setActiveCueId(second.id);
      setOverlayMode("cue");
      monitorRef.current?.pause();
      const seekOffset = Math.min(0.02, Math.max(0, (second.end - second.start) * 0.1));
      monitorRef.current?.seekTo((selectedClip?.start ?? 0) + second.start + seekOffset);
      setPlayhead(second.start + seekOffset);

      const methodLabel =
        timing.method === "playhead"
          ? "at playhead"
          : timing.method === "words" || timing.method === "segments"
            ? "matched to speech"
            : timing.method === "peaks"
              ? "snapped to pause"
              : "estimated";
      toast.success("Line split", {
        description: `Cut at ${formatClock(timing.mid - cue.start, true)} (${methodLabel}) · ${editedFirst.length} / ${editedSecond.length} characters.`,
      });
    },
    [
      arabicMaxCharsPerLine,
      clipStart,
      maxCharsPerLine,
      pushHistory,
      selectedClip,
      selectedClipId,
      setSubtitles,
    ],
  );

  /** Split the active line at the live textarea cursor, last caret, or midpoint. */
  const splitCue = useCallback(
    (cue: SubtitleCue) => {
      const row = listRef.current?.querySelector<HTMLElement>(
        `[data-cue-row="${cue.id}"]`,
      );
      const activeEl = document.activeElement;
      if (row && activeEl instanceof HTMLTextAreaElement && row.contains(activeEl)) {
        const activeField: CueField = activeEl.lang === "ar" ? "arabic" : "thai";
        const liveText = activeEl.value;
        const liveOffset = activeEl.selectionStart ?? 0;
        if (liveText.trim() && liveOffset > 0 && liveOffset < liveText.length) {
          handleSplit(cue.id, activeField, liveOffset);
          return;
        }
      }

      const caret = caretRef.current;
      const caretFieldValid =
        caret &&
        caret.cueId === cue.id &&
        cue[caret.field].trim().length > 0 &&
        caret.offset > 0 &&
        caret.offset < cue[caret.field].length;
      const preferred: CueField = caretFieldValid
        ? caret.field
        : cue.thai.trim()
          ? "thai"
          : "arabic";
      const text = cue[preferred];
      const offset = caretFieldValid
        ? caret.offset
        : splitAtWordBoundary(text, 0.5, preferred) || Math.floor(text.length / 2);
      handleSplit(cue.id, preferred, offset);
    },
    [handleSplit],
  );

  /** Split the active line right at the video playhead timestamp. */
  const handleSplitAtPlayhead = useCallback(
    (cue: SubtitleCue) => {
      if (!selectedClipId) return;
      if (cue.end - cue.start < MIN_SPLITTABLE_DURATION - 0.001) {
        toast.error("This line is too short to split", {
          description: "Make the surrounding lines longer first.",
        });
        return;
      }
      if (
        playhead < cue.start + MIN_CUE_SECONDS - 0.001 ||
        playhead > cue.end - MIN_CUE_SECONDS + 0.001
      ) {
        toast.error("Move the playhead inside this line first", {
          description: "Drag the top ruler on the subtitle track where the next line starts.",
        });
        return;
      }
      const row = listRef.current?.querySelector<HTMLElement>(
        `[data-cue-row="${cue.id}"]`,
      );
      const activeEl = document.activeElement;
      let preferred: CueField | null = null;
      let offset = 0;
      if (row && activeEl instanceof HTMLTextAreaElement && row.contains(activeEl)) {
        const activeField: CueField = activeEl.lang === "ar" ? "arabic" : "thai";
        const pos = activeEl.selectionStart ?? 0;
        if (activeEl.value.trim() && pos > 0 && pos < activeEl.value.length) {
          preferred = activeField;
          offset = pos;
        }
      }
      if (!preferred) {
        const caret = caretRef.current;
        if (
          caret &&
          caret.cueId === cue.id &&
          cue[caret.field].trim().length > 0 &&
          caret.offset > 0 &&
          caret.offset < cue[caret.field].length
        ) {
          preferred = caret.field;
          offset = caret.offset;
        }
      }
      if (!preferred) {
        preferred = cue.thai.trim() ? "thai" : "arabic";
        const text = cue[preferred];
        if (!text.trim()) {
          toast.error("This line has no text to split");
          return;
        }
        offset = resolveTextSplitOffsetForTime({
          cueStart: cue.start,
          cueEnd: cue.end,
          clipStart,
          playhead,
          field: preferred,
          text,
          segments: useProjectStore.getState().project?.transcript?.segments ?? null,
        });
      }
      handleSplit(cue.id, preferred, offset, playhead);
    },
    [clipStart, handleSplit, playhead, selectedClipId],
  );

  const handleSetEdgeToPlayhead = useCallback(
    (cue: SubtitleCue, edge: "start" | "end") => {
      if (!selectedClipId) return;
      const latest = useProjectStore.getState().project?.subtitles[selectedClipId] ?? [];
      const sorted = [...latest].sort((a, b) => a.start - b.start);
      const index = sorted.findIndex((item) => item.id === cue.id);
      if (index < 0) return;
      const prev = index > 0 ? sorted[index - 1] : null;
      const next = index + 1 < sorted.length ? sorted[index + 1] : null;
      const lowerBound = prev ? prev.end + NEIGHBOUR_GAP : 0;
      const upperBound = next ? next.start - NEIGHBOUR_GAP : clipDuration;
      const target = roundTime(playhead);

      if (edge === "start") {
        const maxStart = roundTime(cue.end - MIN_CUE_SECONDS);
        if (lowerBound > maxStart + 0.001) return;
        const nextStart = clamp(target, roundTime(lowerBound), maxStart);
        updateCueTime(cue.id, nextStart, cue.end);
        return;
      }
      const minEnd = roundTime(cue.start + MIN_CUE_SECONDS);
      if (minEnd > upperBound + 0.001) return;
      const nextEnd = clamp(target, minEnd, roundTime(upperBound));
      updateCueTime(cue.id, cue.start, nextEnd);
    },
    [clipDuration, playhead, selectedClipId, updateCueTime],
  );

  const handleMerge = useCallback(
    (cueId: string) => {
      if (!selectedClipId) return;
      manualEditClipsRef.current.add(selectedClipId);
      setRebuildHint(false);
      const latest = useProjectStore.getState().project?.subtitles[selectedClipId] ?? [];
      const index = latest.findIndex((cue) => cue.id === cueId);
      const cue = latest[index];
      const following = latest[index + 1];
      if (!cue || !following) return;

      const arabic = wrapArabicText(
        joinMergedText(cue.arabic, following.arabic, "arabic"),
        arabicMaxCharsPerLine,
      );
      const thai = wrapSubtitleText(
        joinMergedText(cue.thai, following.thai, "thai"),
        maxCharsPerLine,
      );
      const merged: SubtitleCue = {
        ...cue,
        end: following.end,
        arabic,
        thai,
        source: undefined,
        reference: undefined,
        confidence: undefined,
        originalText: undefined,
        translation: undefined,
        reviewed: false,
        edited: true,
      };
      const next = latest
        .filter((item) => item.id !== following.id)
        .map((item) => (item.id === cue.id ? merged : item));
      pushHistory(selectedClipId, latest);
      setSubtitles(selectedClipId, next);
      setActiveCueId(merged.id);
      toast.success("Lines merged", {
        description: `One line now covers ${formatClock(merged.end - merged.start, true)}.`,
      });
    },
    [arabicMaxCharsPerLine, maxCharsPerLine, pushHistory, selectedClipId, setSubtitles],
  );

  const handleDelete = useCallback(
    (cueId: string) => {
      if (!selectedClipId) return;
      manualEditClipsRef.current.add(selectedClipId);
      setRebuildHint(false);
      const currentProject = useProjectStore.getState().project;
      const owningProjectId = currentProject?.id ?? null;
      const latest = currentProject?.subtitles[selectedClipId] ?? [];
      const index = latest.findIndex((cue) => cue.id === cueId);
      const removed = latest[index];
      if (!removed) return;

      const next = latest.filter((cue) => cue.id !== cueId);
      pushHistory(selectedClipId, latest);
      setSubtitles(selectedClipId, next);
      const fallback = next[Math.min(index, next.length - 1)] ?? null;
      setActiveCueId(fallback?.id ?? null);

      const postDeleteIds = next.map((cue) => cue.id).join("\u0000");
      toast("Line deleted", {
        description: "The subtitle line was removed from this clip.",
        action: {
          label: "Undo",
          onClick: () => {
            const current = useProjectStore.getState().project;
            if (!owningProjectId || current?.id !== owningProjectId) return;
            const list = current.subtitles[selectedClipId] ?? [];
            if (list.some((cue) => cue.id === removed.id)) return;
            const sameClipOpen =
              (current.selectedClipId ?? approvedClips[0]?.id ?? null) === selectedClipId;
            if (
              sameClipOpen &&
              list.map((cue) => cue.id).join("\u0000") === postDeleteIds
            ) {
              handleUndo();
              setActiveCueId(removed.id);
              return;
            }
            if (sameClipOpen) {
              pushHistory(selectedClipId, list);
            }
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
    [approvedClips, handleUndo, pushHistory, selectedClipId, setSubtitles],
  );

  const handleAdd = useCallback(() => {
    if (!selectedClipId || !selectedClip) return;
    manualEditClipsRef.current.add(selectedClipId);
    setRebuildHint(false);
    const latest = useProjectStore.getState().project?.subtitles[selectedClipId] ?? [];
    const sorted = [...latest].sort((a, b) => a.start - b.start);
    const findFreeGap = (): { start: number; end: number } | null => {
      const candidates: Array<{ start: number; end: number }> = [];
      let cursor = 0;
      for (const cue of sorted) {
        if (cue.start - cursor >= 0.25) {
          candidates.push({ start: cursor, end: cue.start });
        }
        cursor = Math.max(cursor, cue.end);
      }
      if (clipDuration - cursor >= 0.25) {
        candidates.push({ start: cursor, end: clipDuration });
      }
      const containing = candidates.find((g) => playhead >= g.start && playhead <= g.end);
      if (containing) {
        const s = Math.max(playhead, containing.start);
        if (containing.end - s >= 0.25) {
          return { start: s, end: Math.min(s + 2.5, containing.end) };
        }
      }
      const nextGap = candidates.find((g) => g.start >= playhead) ?? candidates[0] ?? null;
      if (!nextGap) return null;
      return { start: nextGap.start, end: Math.min(nextGap.start + 2.5, nextGap.end) };
    };
    const slot = findFreeGap();
    if (!slot || slot.end - slot.start < 0.25) {
      toast.error("No room for a new line here", {
        description: "Move the playhead, or shorten a neighbouring line first.",
      });
      return;
    }
    const { start, end } = slot;
    const cue: SubtitleCue = {
      id: crypto.randomUUID(),
      start: Math.round(start * 100) / 100,
      end: Math.round(end * 100) / 100,
      arabic: "",
      thai: "",
      reviewed: false,
    };
    pushHistory(selectedClipId, latest);
    setSubtitles(
      selectedClipId,
      [...latest, cue].sort((a, b) => a.start - b.start),
    );
    setActiveCueId(cue.id);
  }, [clipDuration, playhead, pushHistory, selectedClip, selectedClipId, setSubtitles]);

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
      // Capture the owning session and clip now: the reply may land after a switch.
      const projectId = useProjectStore.getState().project?.id;
      const clipId = selectedClipId;
      const result = await verifyArabic({
        arabic_text: arabicText,
        context_thai: cue.thai.replace(/\n/g, " "),
        provider: null,
      });

      if (result.source === "unmatched" || result.source === "needs_model") {
        if (clipId && projectId) {
          deliverTaskResult(projectId, {
            kind: "verify",
            clipId,
            lines: [
              {
                cueId: cue.id,
                source: result.source,
                reference: null,
                confidence: null,
              },
            ],
          });
        }
        if (announce) {
          toast.info("Not in the Qur'an corpus", {
            description:
              result.notes ||
              "Only Qur'an verses are checked offline. Review non-Qur'anic Arabic manually.",
          });
        }
        return "unmatched";
      }

      if (clipId && projectId) {
        // Route by project id: a session switch mid-check must not write into
        // whatever project happens to be open when the reply lands.
        deliverTaskResult(projectId, {
          kind: "verify",
          clipId,
          lines: [
            {
              cueId: cue.id,
              arabic: result.verified_text
                ? wrapArabicText(result.verified_text, arabicMaxCharsPerLine)
                : cue.arabic,
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
    [arabicMaxCharsPerLine, selectedClipId],
  );

  const handleVerify = useCallback(
    async (cue: SubtitleCue) => {
      setVerifyingIds((prev) => new Set(prev).add(cue.id));
      try {
        await verifyOne(cue);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== "empty") {
          toast.error("Verification failed", { description: message });
        }
      } finally {
        setVerifyingIds((prev) => {
          const next = new Set(prev);
          next.delete(cue.id);
          return next;
        });
      }
    },
    [verifyOne],
  );

  const handleVerifyAll = useCallback(async () => {
    if (!selectedClipId) return;
    const projectId = useProjectStore.getState().project?.id;
    if (!projectId) return;
    const clipId = selectedClipId;
    const alreadyRunning = useJobStore
      .getState()
      .jobs.some(
        (job) =>
          job.kind === "verify" &&
          job.projectId === projectId &&
          job.clipId === clipId &&
          job.status === "running",
      );
    if (alreadyRunning) return;
    const targets = (useProjectStore.getState().project?.subtitles[clipId] ?? []).filter(
      (cue) => cue.arabic.trim().length > 0,
    );
    if (!targets.length) return;

    const BATCH = 64;
    type VerifiedLine = {
      cueId: string;
      arabic?: string;
      source?: string;
      reference?: string | null;
      confidence?: number | null;
    };
    let corrected = 0;
    let failed = 0;
    let checked = 0;
    let corpus = 0;
    let unmatched = 0;

    useJobStore.getState().startTask({
      kind: "verify",
      projectId,
      clipId,
      label: "Checking Arabic",
      run: async (signal, hooks) => {
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
                chunkLines.push({
                  cueId: cue.id,
                  source: line.source,
                  reference: null,
                  confidence: null,
                });
                continue;
              }
              if (line.source === "quran") corpus += 1;
              if (line.correction_applied) corrected += 1;
              if (line.verified_text) {
                chunkLines.push({
                  cueId: cue.id,
                  arabic: wrapArabicText(line.verified_text, arabicMaxCharsPerLine),
                  source: line.source,
                  reference: line.reference ?? undefined,
                  confidence: line.confidence ?? undefined,
                });
              }
            }
            if (chunkLines.length) {
              deliverTaskResult(projectId, { kind: "verify", clipId, lines: chunkLines });
            }
            checked += chunk.length;
          } catch {
            if (signal.aborted) break;
            failed += chunk.length;
          }
          hooks.setProgress(Math.min(targets.length, offset + chunk.length), targets.length);
        }
        // Chunks already deliver via deliverTaskResult (or queue if inactive), so
        // never re-apply the whole batch at completion and clobber newer edits.
        return null;
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
  }, [arabicMaxCharsPerLine, selectedClipId]);

  /* ------------------------------ keyboard ----------------------------- */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (settingsOpen || configStep !== null) return;
      if (
        document.querySelector(
          '[data-slot="dialog-content"][data-state="open"], [data-vaul-drawer][data-state="open"], [data-slot="popover-content"][data-state="open"], [data-slot="select-content"][data-state="open"]',
        )
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      const inTextInput = Boolean(
        target &&
          (target.isContentEditable ||
            ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)),
      );
      if (inTextInput) return;

      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === "enter" && event.shiftKey && activeCue) {
          event.preventDefault();
          handleSplitAtPlayhead(activeCue);
          return;
        }
        if (key === "z" && !event.shiftKey) {
          event.preventDefault();
          handleUndo();
          return;
        }
        if (key === "y" || (key === "z" && event.shiftKey)) {
          event.preventDefault();
          handleRedo();
          return;
        }
        return;
      }

      if (
        target &&
        target.closest(
          'button, a, summary, [role="button"], [role="slider"], [role="separator"], [role="switch"], [role="tab"]',
        )
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === "Escape") {
        if (selectedInsertId) {
          event.preventDefault();
          setSelectedInsertId(null);
          return;
        }
        if (previewFocus && !event.defaultPrevented) {
          event.preventDefault();
          setPreviewFocus(false);
          return;
        }
      }

      if ((event.key === "Delete" || event.key === "Backspace") && selectedInsertId) {
        event.preventDefault();
        deleteInsert(selectedInsertId);
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
    configStep,
    deleteInsert,
    handleRedo,
    handleSplitAtPlayhead,
    handleUndo,
    moveCue,
    nextUnchecked,
    pauseShuttle,
    previewFocus,
    selectCue,
    selectedInsertId,
    setReviewed,
    settingsOpen,
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
          {subtitleOnly
            ? L("Upload and transcribe your clip on Step 1 to start editing subtitles.")
            : "Approve clips in Find Clips first — each approved clip gets its own bilingual subtitle track."}
        </p>
        <Button className="mt-1" size="sm" onClick={() => setStep(subtitleOnly ? 1 : 2)}>
          {subtitleOnly ? L("Back to upload") : L("Back to clip discovery")}
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
              {(project.transcript?.language || language).toUpperCase()}
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

      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1"
        disabled={previewFocus || settingsOpen || configStep !== null}
        resizeTargetMinimumSize={{ fine: 8, coarse: 16 }}
        defaultLayout={defaultLayout}
        onLayoutChanged={(_layout, meta) => {
          if (!meta.isUserInteraction) return;
          try {
            window.localStorage.setItem(
              STEP3_LAYOUT_STORAGE_KEY,
              JSON.stringify(meta.requestedLayout),
            );
          } catch {
            /* Ignore storage quota errors. */
          }
        }}
      >
        {/* ------------------------------ lines ------------------------------ */}
        <ResizablePanel
          id={STEP3_LINES_PANEL_ID}
          minSize={STEP3_LINES_MIN_PX}
          className="flex min-h-0 min-w-0 flex-col"
          style={{ overflow: "hidden" }}
        >
          {previewFocus ? null : (
            <section className="flex h-full min-h-0 min-w-0 flex-col">
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
                  onClick={() => setResetDialogMode("rebuild")}
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
                      onClick={() => {
                        if (verifyJob) useJobStore.getState().cancelJob(verifyJob.id);
                      }}
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

            <div className="mr-1 min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
              <div ref={listRef} className="min-w-0 space-y-2 py-3 pl-3 pr-2">
                {cues.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
                    <ScanText className="size-5 text-muted-foreground" />
                    <p className="text-xs font-medium text-foreground">
                      {L("No subtitle lines for this clip")}
                    </p>
                    <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
                      {subtitleOnly
                        ? L(
                            "No speech was found in this clip. Re-transcribe on Step 1, or add a line where the playhead sits.",
                          )
                        : "The transcript has no speech inside this clip. Widen the cut in Find Clips, or add a line where the playhead sits."}
                    </p>
                    <div className="mt-1 flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setStep(subtitleOnly ? 1 : 2)}
                      >
                        {subtitleOnly ? L("Back to upload") : "Adjust clip"}
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
                  visibleCues.map(({ cue, index }) => {
                    const isActive = activeCue?.id === cue.id;
                    return (
                      <SubtitleCueRow
                        key={cue.id}
                        cue={cue}
                        index={index}
                        active={isActive}
                        hasFollowing={
                          Boolean(cues[index + 1]) &&
                          (filter === "all" || !cues[index + 1]?.reviewed)
                        }
                        canPlay={canPlay}
                        verifyingThis={verifyingIds.has(cue.id)}
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
                        canSplitAtPlayhead={isActive && canSplitAtPlayhead}
                        canSetStartToPlayhead={isActive && canSetStartToPlayhead}
                        canSetEndToPlayhead={isActive && canSetEndToPlayhead}
                        onSplitAtPlayhead={handleSplitAtPlayhead}
                        onSetEdgeToPlayhead={handleSetEdgeToPlayhead}
                        onMerge={handleMerge}
                        onDelete={handleDelete}
                      />
                    );
                  })
                )}
              </div>
            </div>
          </section>
          )}
        </ResizablePanel>

        <ResizableHandle
          id="step3-split"
          withHandle
          disabled={previewFocus || settingsOpen || configStep !== null}
          aria-label={L("Resize subtitle editor and preview")}
          title={L("Drag to resize · Double-click to reset")}
        />

        {/* ----------------------------- monitor ----------------------------- */}
        <ResizablePanel
          id={STEP3_PREVIEW_PANEL_ID}
          defaultSize={STEP3_PREVIEW_DEFAULT_PX}
          minSize={STEP3_PREVIEW_MIN_PX}
          className="flex min-h-0 min-w-0 flex-col"
          style={{ overflow: "hidden" }}
        >
          <section
            className={cn(
              "flex h-full min-h-0 min-w-0 flex-col",
              previewFocus
                ? "fixed inset-x-0 bottom-0 top-[var(--titlebar-height)] z-40 border-0 bg-background p-3"
                : undefined,
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
          <ResizablePanelGroup
            orientation="vertical"
            className="min-h-0 flex-1"
            disabled={settingsOpen || configStep !== null}
            resizeTargetMinimumSize={{ fine: 8, coarse: 16 }}
            defaultLayout={defaultPreviewSplit}
            onLayoutChanged={(_layout, meta) => {
              if (!meta.isUserInteraction) return;
              try {
                window.localStorage.setItem(
                  STEP3_PREVIEW_SPLIT_STORAGE_KEY,
                  JSON.stringify(meta.requestedLayout),
                );
              } catch {
                /* Ignore storage quota errors. */
              }
            }}
          >
            <ResizablePanel
              id={STEP3_MONITOR_PANE_ID}
              minSize={STEP3_MONITOR_MIN_PX}
              className="flex min-h-0 flex-col gap-1.5 px-3 pt-1.5 pb-1"
              style={{ overflow: "hidden" }}
            >
              {/* Output shape sits above the picture it changes: the editor
                  frames the clip while looking at the frame. */}
              <div className="flex shrink-0 flex-wrap items-start gap-2">
                <div className="min-w-[136px] flex-1 space-y-0.5">
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
                <div className="min-w-[136px] flex-1 space-y-0.5">
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
                <p className="shrink-0 text-[10px] leading-tight text-muted-foreground">
                  16:9 uses the whole frame, so framing applies to 9:16 only.
                </p>
              )}

              <SubtitleMonitor
                ref={monitorRef}
                resolution={resolution}
                framing={framing}
                sourcePath={project.sourcePath}
                clipStart={clipStart}
                clipEnd={selectedClip.end}
                cues={cues}
                selectedCueId={activeCue?.id ?? null}
                overlayMode={overlayMode}
                playhead={playhead}
                styles={styles}
                safeZone={safeZone}
                muted={muted}
                interactive
                offsets={{
                  arabic: arabicSettings.verticalOffset,
                  thai: thaiSettings.verticalOffset,
                }}
                onNudgeLine={nudgeMonitorLine}
                inserts={inserts}
                selectedInsertId={selectedInsertId}
                onSelectInsert={setSelectedInsertId}
                onCommitInsertRect={updateInsertRect}
                onTimeUpdate={handleMonitorTime}
                onPlayingChange={setPlaying}
                onTogglePlay={togglePlay}
              />
            </ResizablePanel>

            <ResizableHandle
              id="step3-timeline-split"
              withHandle
              disabled={settingsOpen || configStep !== null}
              aria-label={L("Resize preview and timeline")}
              title={L("Drag to resize · Double-click to reset")}
            />

            <ResizablePanel
              id={STEP3_TIMELINE_PANE_ID}
              defaultSize={STEP3_TIMELINE_DEFAULT_PX}
              minSize={STEP3_TIMELINE_MIN_PX}
              className="flex min-h-0 flex-col gap-1 px-3 pt-1 pb-1.5"
              style={{ overflow: "hidden" }}
            >
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-1">
                <div className="flex min-w-0 items-center gap-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={L("Undo")}
                    title={`${L("Undo")} (Ctrl+Z)`}
                    disabled={!canUndo}
                    onClick={handleUndo}
                  >
                    <Undo2 className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={L("Redo")}
                    title={`${L("Redo")} (Ctrl+Y)`}
                    disabled={!canRedo}
                    onClick={handleRedo}
                  >
                    <Redo2 className="size-3.5" />
                  </Button>
                  {clipDuration > 0 ? (
                    <>
                      <Separator orientation="vertical" className="mx-0.5 h-3.5" />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Zoom out subtitle track"
                        title="Zoom out timeline (or scroll down over tracks)"
                        disabled={ribbonZoom <= 1.001}
                        onClick={() => {
                          const prev = [...CUE_RIBBON_ZOOM_LEVELS]
                            .reverse()
                            .find((level) => level < ribbonZoom - 0.05);
                          setRibbonZoom(prev ?? 1);
                        }}
                      >
                        <ZoomOut className="size-3" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="px-1 text-[11px] tabular-nums text-muted-foreground"
                        aria-label="Reset subtitle track zoom"
                        title="Reset timeline zoom"
                        disabled={ribbonZoom <= 1.001}
                        onClick={() => setRibbonZoom(1)}
                      >
                        {Number.isInteger(ribbonZoom) ? ribbonZoom : ribbonZoom.toFixed(1)}×
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Zoom in subtitle track"
                        title="Zoom in timeline (or scroll up over tracks)"
                        disabled={
                          ribbonZoom >=
                          CUE_RIBBON_ZOOM_LEVELS[CUE_RIBBON_ZOOM_LEVELS.length - 1] - 0.01
                        }
                        onClick={() => {
                          const next = CUE_RIBBON_ZOOM_LEVELS.find(
                            (level) => level > ribbonZoom + 0.05,
                          );
                          setRibbonZoom(
                            next ?? CUE_RIBBON_ZOOM_LEVELS[CUE_RIBBON_ZOOM_LEVELS.length - 1],
                          );
                        }}
                      >
                        <ZoomIn className="size-3" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        aria-label={L("Add media")}
                        title="Add image or video insert (or drag & drop / Ctrl+V)"
                        className="ml-0.5 gap-1 px-1.5 text-[11px]"
                        onClick={() => void handleBrowseInsertMedia()}
                      >
                        <ImagePlus className="size-3" />
                        {L("Media")}
                      </Button>
                      {selectedInsert ? (
                        <Popover open={insertPopoverOpen} onOpenChange={setInsertPopoverOpen}>
                          <PopoverTrigger asChild>
                            <Button
                              type="button"
                              variant="secondary"
                              size="xs"
                              aria-label={L("Edit selected insert")}
                              className="max-w-[62px] gap-1 px-1.5 text-[11px]"
                            >
                              {selectedInsert.kind === "video" ? (
                                <Film className="size-3 shrink-0" />
                              ) : (
                                <ImageIcon className="size-3 shrink-0" />
                              )}
                              <span className="truncate">{selectedInsert.name}</span>
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent align="start" side="top" className="w-80 space-y-2.5">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <p className="truncate text-xs font-medium text-foreground">
                                  {selectedInsert.name}
                                </p>
                                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground">
                                  <span className="font-mono">
                                    <TimeFlow value={selectedInsert.start} hundredths /> →{" "}
                                    <TimeFlow value={selectedInsert.end} hundredths />
                                  </span>
                                  <span>·</span>
                                  <NumberFlow
                                    value={Math.max(
                                      0,
                                      Math.round((selectedInsert.end - selectedInsert.start) * 10) /
                                        10,
                                    )}
                                    suffix="s"
                                    locales="en-US"
                                    format={{ maximumFractionDigits: 1 }}
                                  />
                                  {selectedInsert.kind === "video" &&
                                  selectedInsert.sourceDuration !== null ? (
                                    <span className="text-[10px] text-muted-foreground/80">
                                      (in {selectedInsert.sourceStart.toFixed(1)}s /{" "}
                                      {selectedInsert.sourceDuration.toFixed(1)}s)
                                    </span>
                                  ) : null}
                                </div>
                              </div>
                              <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                onClick={() => void replaceInsertFile(selectedInsert.id)}
                              >
                                {L("Replace")}
                              </Button>
                            </div>

                            {missingInsertIds.has(selectedInsert.id) ? (
                              <p className="flex items-center gap-1.5 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
                                <AlertTriangle className="size-3.5 shrink-0" />
                                File not found on disk. Click Replace to reconnect it.
                              </p>
                            ) : null}

                            <div className="space-y-1">
                              <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                                Frame fit
                              </p>
                              <SegmentedToggle<InsertFit>
                                label="Insert frame fit"
                                value={selectedInsert.fit}
                                options={[
                                  { value: "cover", label: "Fill", hint: "Crop to fill box" },
                                  {
                                    value: "blur-fill",
                                    label: "Blur fill",
                                    hint: "Blurred edges around whole frame",
                                  },
                                  { value: "contain", label: "Fit", hint: "Show whole image/PNG" },
                                ]}
                                onChange={(fit) => updateInsertMeta(selectedInsert.id, { fit })}
                              />
                            </div>

                            <div className="flex items-center justify-between gap-2">
                              <span className="flex items-center gap-1.5 text-xs text-foreground">
                                <Sparkles className="size-3 text-muted-foreground" />
                                Subtle fade (0.25s)
                              </span>
                              <Switch
                                checked={(selectedInsert.fade ?? 0) > 0}
                                aria-label="Subtle fade"
                                onCheckedChange={(checked) =>
                                  updateInsertMeta(selectedInsert.id, { fade: checked ? 0.25 : 0 })
                                }
                              />
                            </div>

                            <div className="flex flex-wrap items-center gap-1 pt-0.5">
                              <Button
                                type="button"
                                size="xs"
                                variant="outline"
                                disabled={!activeCue}
                                onClick={() => matchInsertToActiveCue(selectedInsert.id)}
                              >
                                {L("Match subtitle")}
                              </Button>
                              <Button
                                type="button"
                                size="xs"
                                variant="outline"
                                disabled={isFullFrameRect(selectedInsert.rect)}
                                onClick={() =>
                                  updateInsertMeta(selectedInsert.id, {
                                    rect: { ...DEFAULT_INSERT_RECT },
                                  })
                                }
                              >
                                {L("Reset full frame")}
                              </Button>
                              <Button
                                type="button"
                                size="xs"
                                variant="ghost"
                                className="ml-auto gap-1 text-destructive"
                                onClick={() => deleteInsert(selectedInsert.id)}
                              >
                                <Trash2 className="size-3" />
                                Delete
                              </Button>
                            </div>
                          </PopoverContent>
                        </Popover>
                      ) : null}
                    </>
                  ) : null}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-label={L("Reset subtitles")}
                  className="gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                  title={L("Reset subtitles to default")}
                  disabled={(project.transcript?.segments.length ?? 0) === 0}
                  onClick={() => setResetDialogMode("reset")}
                >
                  <RotateCcw className="size-3" />
                  {L("Reset")}
                </Button>
              </div>

              <TimelineTracks
                cues={cues}
                inserts={inserts}
                duration={clipDuration}
                selectedCueId={activeCue?.id ?? null}
                playingCueId={playingCueId}
                selectedInsertId={selectedInsertId}
                playhead={playhead}
                zoom={ribbonZoom}
                missingInsertIds={missingInsertIds}
                insertDragOver={insertDragOver}
                onZoomChange={setRibbonZoom}
                onSelectCue={(cueId) => {
                  const cue = cues.find((item) => item.id === cueId);
                  if (cue) selectCue(cue);
                }}
                onSelectCueOnly={(cueId) => {
                  setActiveCueId(cueId);
                }}
                onSelectInsert={setSelectedInsertId}
                onSeek={(seconds) => {
                  monitorRef.current?.pause();
                  setOverlayMode("playhead");
                  monitorRef.current?.seekTo(clipStart + seconds);
                  setPlayhead(seconds);
                }}
                onScrubEdge={(seconds) => {
                  monitorRef.current?.pause();
                  setOverlayMode("playhead");
                  monitorRef.current?.seekTo(clipStart + seconds);
                  setPlayhead(seconds);
                }}
                onChangeCueTime={updateCueTime}
                onChangeCuePair={updateCuePair}
                onChangeInsert={updateInsertTiming}
                onDropInsertFiles={(files) => void handleDropInsertFiles(files)}
              />

              <div className="flex shrink-0 flex-wrap items-center gap-x-1 gap-y-1">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={
                    playing
                      ? L("Pause")
                      : continuousPlay
                        ? L("Play continuously")
                        : "Play the selected line"
                  }
                  disabled={!canPlay || clipDuration <= 0 || (!continuousPlay && !activeCue)}
                  onClick={togglePlay}
                >
                  {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                </Button>
                <Button
                  variant={continuousPlay ? "default" : "outline"}
                  size="xs"
                  aria-pressed={continuousPlay}
                  title={
                    continuousPlay
                      ? L("Continuous playback on — plays without stopping at subtitle block ends")
                      : L("Play continuously without stopping at the selected subtitle block's end")
                  }
                  className="gap-1 text-[11px]"
                  disabled={clipDuration <= 0}
                  onClick={toggleContinuousPlay}
                >
                  <Play className={cn("size-3", continuousPlay && "fill-current")} />
                  {L("Play clip")}
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
                      locales="en-US"
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
            </ResizablePanel>
          </ResizablePanelGroup>

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
                      <div className="flex items-center gap-1">
                        <Badge variant="outline" className="text-[9px] text-status-warning">
                          Modified
                        </Badge>
                        {activePreset ? (
                          <Button
                            variant="ghost"
                            size="xs"
                            className="h-5 px-1.5 text-[10px]"
                            onClick={() => applyPreset(activePreset.id)}
                          >
                            {L("Reset")}
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <Select
                      value={activePresetId ?? "__custom__"}
                      onValueChange={(value) => {
                        if (value !== "__custom__") applyPreset(value);
                      }}
                    >
                      <SelectTrigger className="h-8 flex-1 text-xs" aria-label="Subtitle style">
                        <SelectValue placeholder={L("Custom style")} />
                      </SelectTrigger>
                      <SelectContent>
                        {!activePresetId ? (
                          <SelectItem value="__custom__" disabled>
                            {L("Custom style")}
                          </SelectItem>
                        ) : null}
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
        </ResizablePanel>
      </ResizablePanelGroup>

      <Dialog
        open={resetDialogMode !== null}
        onOpenChange={(open) => {
          if (!open) setResetDialogMode(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {resetDialogMode === "reset"
                ? L("Reset subtitles to default?")
                : "Rebuild subtitle lines?"}
            </DialogTitle>
            <DialogDescription>
              {resetDialogMode === "reset"
                ? `This restores this clip's ${cues.length} subtitle line${cues.length === 1 ? "" : "s"} back to the default lines created when the clip was approved. You can undo this change.`
                : `This replaces the ${cues.length} line${cues.length === 1 ? "" : "s"} in this clip with lines rebuilt from the transcript. Text edits and check marks in this clip will be lost.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setResetDialogMode(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                const mode = resetDialogMode ?? "rebuild";
                setResetDialogMode(null);
                handleRebuild(mode);
              }}
            >
              {resetDialogMode === "reset" ? L("Reset subtitles") : L("Rebuild lines")}
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
            {arabicPassages.map((cue) => {
              const cuePlaying = playing && activeCue?.id === cue.id;
              return (
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
                      <TimeFlow value={cue.start} hundredths />
                      <span aria-hidden>→</span>
                      <TimeFlow value={cue.end} hundredths />
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
                      onClick={() => {
                        if (cuePlaying) monitorRef.current?.pause();
                        else playCue(cue);
                      }}
                    >
                      {cuePlaying ? <Pause className="size-3" /> : <Play className="size-3" />}
                      {cuePlaying ? L("Pause") : L("Play")}
                    </Button>
                    <Button
                      size="xs"
                      variant={cue.reviewed ? "secondary" : "outline"}
                      className="gap-1"
                      aria-pressed={Boolean(cue.reviewed)}
                      onClick={() => setReviewed(cue.id, !cue.reviewed)}
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
              );
            })}
          </div>

          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setArabicReviewOpen(false)}>
              Close
            </Button>
            {unreviewedVerifiedArabicCount > 0 ? (
              <Button size="sm" onClick={approveAllVerifiedArabic}>
                Approve {unreviewedVerifiedArabicCount} verified
              </Button>
            ) : verifiedArabicCount > 0 ? (
              <Button size="sm" variant="secondary" disabled>
                All {verifiedArabicCount} verified approved
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
          <Button variant="ghost" size="sm" onClick={() => setStep(subtitleOnly ? 1 : 2)}>
            {subtitleOnly ? L("Back to upload") : L("Back to clip discovery")}
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

import { L } from "@/lib/i18n";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import NumberFlow from "@number-flow/react";
import { toast } from "sonner";
import {
  ArrowRight,
  Captions,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  Clock3,
  FileAudio,
  FileVideo2,
  FolderSearch,
  Languages,
  ListVideo,
  Loader2,
  RefreshCw,
  Scissors,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { cn } from "cn";

import { AiActivityLine } from "@/components/AiActivityLine";
import { TimeFlow } from "@/components/TimeFlow";
import { InlineError } from "@/components/InlineError";
import { VideoPlayer, type VideoPlayerHandle } from "@/components/VideoPlayer";
import { WaveformBar } from "@/components/WaveformBar";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ImportClipsDialog } from "@/components/ImportClipsDialog";
import { discoverClips, type ClipExemplar } from "@/lib/api";
import { aiRouteFor } from "@/lib/aiActivity";
import {
  applyCutBuffer,
  MIN_RENDERABLE_CLIP_SECONDS,
  normalizeSpeechRange,
} from "@/lib/clipMath";
import { toMediaSrc } from "@/lib/media";
import { relinkLecture } from "@/lib/sourceLink";
import { clamp, formatClock } from "@/lib/format";
import { proposalToClip } from "@/lib/importClips";
import type { ProjectClip, ProjectData } from "@/lib/projectTypes";
import { buildProviderFor, describeProviderGap } from "@/lib/providers";
import { coerceToRange, NUMERIC_LIMITS } from "@/lib/settingsLimits";
import { useAiActivityStore } from "@/store/aiActivityStore";
import { useJobStore, useTaskJob } from "@/store/jobStore";
import { useProjectStore } from "@/store/projectStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";

type DiscoveryMode = "initial" | "reroll" | "replace";
type CutEdge = "start" | "end";

/** Playback-rate ladder for the J/K/L shuttle (1× = normal speed). */
const SHUTTLE_RATES = [0.25, 0.5, 1, 1.5, 2, 3, 4] as const;

/** Plain ←/→ seek step in Step 2. Edge trims keep the finer configured step. */
const PLAYHEAD_STEP_SECONDS = 1;

/**
 * Smallest speech window an edge nudge may leave behind. The real render floor
 * is `MIN_RENDERABLE_CLIP_SECONDS` on the padded cut; this only keeps the raw
 * speech pair ordered while the operator drags an edge quickly.
 */
const MIN_SPEECH_WINDOW = 0.05;

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

function excerptFor(project: ProjectData, clip: ProjectClip): string {
  const segments = project.transcript?.segments ?? [];
  const text = segments
    .filter((segment) => segment.start >= clip.start - 0.05 && segment.end <= clip.end + 0.05)
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join(" ");
  return text.slice(0, 600);
}

function exemplar(clip: ProjectClip, project: ProjectData): ClipExemplar {
  return {
    start: clip.start,
    end: clip.end,
    title: clip.title,
    text: excerptFor(project, clip),
  };
}

/**
 * Positive examples: only clips the editor approved.
 *
 * Negative examples: only clips the editor explicitly discarded. Labelling
 * every unreviewed proposal as "rejected" poisoned the re-roll feedback — the
 * AI was told to avoid moments the editor had never judged, while the clip they
 * actually threw away was gone from the project entirely.
 */
function approvedExemplarsFor(project: ProjectData): ClipExemplar[] {
  return project.clips
    .filter((clip) => clip.approved)
    .map((clip) => exemplar(clip, project));
}

function rejectedExemplarsFor(project: ProjectData): ClipExemplar[] {
  return (project.trashedClips ?? []).map((clip) => exemplar(clip, project));
}

/** Titles of the other clips whose exported range overlaps this one. */
function collidingTitles(clip: ProjectClip, clips: ProjectClip[]): string[] {
  return clips
    .filter(
      (other) =>
        other.id !== clip.id && other.start < clip.end && other.end > clip.start,
    )
    .map((other) => other.title);
}

/* -------------------------------------------------------------------------- */
/* Local components                                                            */
/* -------------------------------------------------------------------------- */

function ClipCard({
  clip,
  index,
  selected,
  collisions,
  onSelect,
  onApprove,
  onRemove,
}: {
  clip: ProjectClip;
  index: number;
  selected: boolean;
  /** Titles of the other clips this one collides with; empty when it is clear. */
  collisions: string[];
  onSelect: () => void;
  onApprove: () => void;
  onRemove: () => void;
}) {
  return (
    <li
      className={cn(
        "rounded-lg border bg-card/40 transition-colors",
        selected ? "border-ring/50 bg-accent/25" : "border-border",
      )}
    >
      <Button
        variant="ghost"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        aria-label={`${clip.title}, ${formatClock(clip.start)} to ${formatClock(clip.end)}, ${
          clip.approved ? "approved" : "not approved"
        }${collisions.length > 0 ? `, overlaps ${collisions.join(", ")}` : ""}`}
        className="flex-col items-stretch h-auto w-full justify-start gap-0 whitespace-normal rounded-none px-3 pb-1.5 pt-2.5 text-left font-normal hover:bg-transparent focus-visible:ring-[3px] focus-visible:ring-ring/40"
      >
        <div className="flex w-full items-start gap-2">
          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-secondary/60 text-[10px] tabular-nums text-muted-foreground">
            {index + 1}
          </span>
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-[13px] font-medium leading-snug text-foreground">
              {clip.title}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] tabular-nums text-muted-foreground">
              <TimeFlow value={clip.start} />
              <span className="text-muted-foreground/60">→</span>
              <TimeFlow value={clip.end} />
              <span className="text-muted-foreground/50">·</span>
              <NumberFlow
                value={clip.end - clip.start}
                suffix="s"
                format={{ maximumFractionDigits: 1 }}
              />
            </div>
          </div>
          {clip.approved ? <Check className="mt-0.5 size-4 shrink-0 text-foreground/80" /> : null}
        </div>
        {clip.rationale ? (
          <p className="mt-1.5 line-clamp-2 pl-7 text-xs leading-relaxed text-muted-foreground">
            {clip.rationale}
          </p>
        ) : null}
      </Button>

      {collisions.length > 0 ? (
        <p className="px-3 pb-1 pl-10 text-[11px] leading-relaxed text-status-warning">
          Overlaps: {collisions.join(", ")}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-1 px-2.5 pb-2 pt-0.5">
        <Button
          variant={clip.approved ? "secondary" : "outline"}
          size="xs"
          className="gap-1"
          aria-pressed={clip.approved}
          onClick={onApprove}
        >
          <Check className="size-3" />
          {clip.approved ? "Approved" : "Approve"}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove ${clip.title}`}
          onClick={onRemove}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </li>
  );
}

function StepEmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-card/40">
        <Icon className="size-4 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">{description}</p>
      <div className="mt-1">{action}</div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Step 2                                                                      */
/* -------------------------------------------------------------------------- */

export function Step2Discovery() {
  const project = useProjectStore((state) => state.project);
  const setStep = useProjectStore((state) => state.setStep);
  const approveClip = useProjectStore((state) => state.approveClip);
  const removeClip = useProjectStore((state) => state.removeClip);
  const selectClip = useProjectStore((state) => state.selectClip);

  const editor = useSettingsStore((state) => state.editor);
  const updateEditor = useSettingsStore((state) => state.updateEditor);
  const aiEntries = useAiActivityStore((state) => state.entries);
  const activeDiscovery =
    aiEntries.find((entry) => entry.task === "clip-finding" && entry.status === "running") ??
    aiEntries.find((entry) => entry.task === "clip-finding");

  // The search lives in `jobStore`, so switching steps or sessions never
  // aborts it and its proposals still reach the session that started it.
  const discoveryJob = useTaskJob("discovery", project?.id ?? null);
  const status: "idle" | "running" | "error" =
    discoveryJob?.status === "running"
      ? "running"
      : discoveryJob?.status === "error"
        ? "error"
        : "idle";
  const error = discoveryJob?.status === "error" ? discoveryJob.error : null;
  const discoveryPct = discoveryJob?.progress
    ? Math.round((discoveryJob.progress.done / Math.max(1, discoveryJob.progress.total)) * 100)
    : null;
  const [refinement, setRefinement] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [replaceConfirmOpen, setReplaceConfirmOpen] = useState(false);
  const [bufferDraft, setBufferDraft] = useState(editor.cutBufferSeconds);
  const [buttonStepDraft, setButtonStepDraft] = useState(String(editor.edgeButtonStepSeconds));
  const [keyStepDraft, setKeyStepDraft] = useState(String(editor.edgeKeyStepSeconds));
  const [playhead, setPlayhead] = useState(0);
  const [shuttleRate, setShuttleRate] = useState(1);

  const videoRef = useRef<VideoPlayerHandle>(null);
  const playheadRef = useRef(0);
  const lastProjectIdRef = useRef<string | null>(project?.id ?? null);

  useEffect(() => {
    playheadRef.current = playhead;
  }, [playhead]);

  const handleTimeUpdate = useCallback((seconds: number) => {
    playheadRef.current = seconds;
    setPlayhead(seconds);
  }, []);

  const clips = project?.clips ?? [];
  const approvedClips = useMemo(() => clips.filter((clip) => clip.approved), [clips]);
  const approvedCount = approvedClips.length;
  const unapprovedCount = clips.length - approvedCount;
  const selected = clips.find((clip) => clip.id === project?.selectedClipId) ?? clips[0] ?? null;
  const selectedIndex = selected ? clips.findIndex((clip) => clip.id === selected.id) : -1;
  const duration = project?.duration ?? 0;
  const videoSrc = useMemo(() => toMediaSrc(project?.sourcePath), [project?.sourcePath]);
  const sourceMissing = useProjectStore((state) => state.sourceStatus === "missing");

  // Switching projects resets the *view* only: refinement text and playhead
  // belong to the session that was on screen. A discovery call that is still
  // running keeps going and files its proposals into its own project.
  useEffect(() => {
    const nextId = project?.id ?? null;
    if (lastProjectIdRef.current === nextId) return;
    lastProjectIdRef.current = nextId;
    setRefinement("");
    setReplaceConfirmOpen(false);
    setPlayhead(0);
    playheadRef.current = 0;
  }, [project?.id]);

  useEffect(() => {
    setBufferDraft(editor.cutBufferSeconds);
  }, [editor.cutBufferSeconds]);

  useEffect(() => {
    setButtonStepDraft(String(editor.edgeButtonStepSeconds));
    setKeyStepDraft(String(editor.edgeKeyStepSeconds));
  }, [editor.edgeButtonStepSeconds, editor.edgeKeyStepSeconds]);

  useEffect(() => {
    if (!project) return;
    if (project.clips.length === 0) {
      if (project.selectedClipId != null) selectClip(null);
      return;
    }
    if (!project.clips.some((clip) => clip.id === project.selectedClipId)) {
      selectClip(project.clips[0].id);
    }
  }, [project, selectClip]);

  const selectedId = selected?.id ?? null;
  useEffect(() => {
    if (!selected) return;
    setPlayhead(selected.start);
    playheadRef.current = selected.start;
    videoRef.current?.seekTo(selected.start);
    // A new clip starts at normal speed; the shuttle re-applies on demand.
    videoRef.current?.setPlaybackRate(1);
    setShuttleRate(1);
  }, [selectedId]);

  // Re-apply the cut buffer whenever the editor default changes, so trimming
  // stays reversible: the raw speech bounds are never overwritten.
  useEffect(() => {
    const current = useProjectStore.getState().project;
    if (!current || current.clips.length === 0) return;
    const context = {
      duration: current.duration,
      buffer: editor.cutBufferSeconds,
      autoPad: editor.autoPad,
    };
    const next = current.clips.map((clip) => {
      const range = applyCutBuffer(clip.speechStart, clip.speechEnd, context);
      if (
        Math.abs(range.start - clip.start) < 0.0005 &&
        Math.abs(range.end - clip.end) < 0.0005
      ) {
        return clip;
      }
      return { ...clip, start: range.start, end: range.end };
    });
    if (next.some((clip, index) => clip !== current.clips[index])) {
      useProjectStore.getState().setClips(next);
    }
  }, [editor.cutBufferSeconds, editor.autoPad, project?.id]);

  const runDiscovery = useCallback(async (mode: DiscoveryMode, note: string) => {
    const current = useProjectStore.getState().project;
    if (!current?.transcriptId) {
      toast.error(L("Transcript missing"), { description: "Run the lecture through Step 1 first." });
      return;
    }
    if (!current.transcript || current.transcript.segments.length === 0) {
      // Whisper may legitimately return no segments for silent audio; searching
      // an empty transcript would only burn an LLM call and confuse the editor.
      toast.error("No speech detected", {
        description:
          "We couldn't find any speech in this lecture. Check the audio, then transcribe again on Step 1.",
      });
      return;
    }
    const settings = useSettingsStore.getState();
    // The provider belongs to the action it unblocks: transcription no longer
    // checks this, so clicking Start is where a missing connection is reported.
    // Clip finding is a writing-model job, so a missing model blocks the run.
    const providerGap = describeProviderGap(settings);
    if (providerGap) {
      toast.error("Clip finding isn't set up yet", {
        description: `Add ${providerGap} in the Find Clips configuration or AI connection settings, then try again.`,
      });
      if (providerGap.includes("AI model")) useUiStore.getState().openConfig(2);
      else useUiStore.getState().openSettings("connection");
      return;
    }
    const replaceAll = mode === "replace";
    const approvedRanges = current.clips
      .filter((clip) => clip.approved)
      .map((clip) => ({ start: clip.start, end: clip.end }));
    const projectId = current.id;
    const transcriptId = current.transcriptId;
    const duration = current.duration;

    useJobStore.getState().startTask({
      kind: "discovery",
      projectId,
      label: replaceAll ? L("Starting over with new clips") : L("Finding clips"),
      run: async (signal, hooks) => {
        const activityId = useAiActivityStore
          .getState()
          .start(aiRouteFor(settings, "clip-finding"));
        try {
          const result = await discoverClips(
            {
              transcript_id: transcriptId,
              base_prompt: current.basePrompt,
              session_guide: current.sessionGuide.trim() || undefined,
              refinement_note: note.trim(),
              excluded_ranges: replaceAll ? [] : approvedRanges,
              language: settings.editor.language || "th",
              provider: buildProviderFor(settings),
              // A re-roll keeps approved clips out of the next search and feeds
              // the kept/passed clips back as feedback.
              approved_exemplars: replaceAll ? [] : approvedExemplarsFor(current),
              rejected_exemplars: replaceAll ? [] : rejectedExemplarsFor(current),
            },
            {
              signal,
              onProgress: (event) => {
                hooks.setStage(event.label || null, {
                  done: Math.round(event.progress * 100),
                  total: 100,
                });
              },
            },
          );
          // Report the writing model that produced the proposals.
          useAiActivityStore
            .getState()
            .finish(activityId, "done", result.model || undefined);
          const latestSettings = useSettingsStore.getState();
          const proposals = result.clips
            .map((proposal, index) =>
              proposalToClip(
                proposal,
                index,
                duration,
                latestSettings.editor.cutBufferSeconds,
                latestSettings.editor.autoPad,
              ),
            )
            .filter((clip): clip is ProjectClip => clip !== null);
          return {
            kind: "discovery" as const,
            proposals,
            replaceAll,
          };
        } catch (caught) {
          useAiActivityStore
            .getState()
            .finish(activityId, signal.aborted ? "cancelled" : "failed");
          throw caught;
        }
      },
      onSuccess: (payload) => {
        if (payload?.kind !== "discovery") return;
        if (note.trim()) setRefinement("");
        const count = payload.proposals.length;
        if (count === 0) {
          // A re-roll that finds nothing leaves the deck untouched, so this is
          // a "nothing more" outcome rather than a silent success.
          toast(L("No new clips found"), {
            description: replaceAll
              ? "The search returned nothing, so your current clips are unchanged. Try different instructions, then search again."
              : "Your current clips are unchanged. Try different instructions, then search again.",
          });
          return;
        }
        toast.success(
          mode === "replace"
            ? "Started over with new clips"
            : mode === "reroll"
              ? L("Search complete")
              : L("Clip proposals ready"),
          {
            description:
              mode === "reroll"
                ? `${count} new clip${count === 1 ? "" : "s"} — approved clips kept; unapproved clips replaced`
                : `${count} new clip${count === 1 ? "" : "s"}`,
          },
        );
      },
      onError: (message) => {
        toast.error("Clip discovery failed", { description: message });
      },
      onCancel: () => toast(L("Discovery cancelled")),
    });
  }, []);

  /**
   * Move the preview playhead and keep the video in sync. The playhead is
   * always clamped to the selected clip, so a waveform click, an arrow key or
   * an edge snap can never park it outside the cut.
   */
  const seekPlayhead = useCallback((seconds: number) => {
    if (!Number.isFinite(seconds)) return;
    const current = useProjectStore.getState().project;
    const clip =
      current?.clips.find((item) => item.id === current.selectedClipId) ?? current?.clips[0];
    const lower = clip?.start ?? 0;
    const upper = clip?.end ?? Math.max(lower, seconds);
    const next = clamp(seconds, lower, Math.max(lower, upper));
    playheadRef.current = next;
    setPlayhead(next);
    videoRef.current?.seekTo(next);
  }, []);

  /**
   * Move one edge of the selected clip by `delta` seconds: a negative value
   * moves it earlier (grow the start, trim the end), a positive value moves it
   * later (trim the start, grow the end). The raw speech bounds stay the
   * source of truth and the cut is recomputed through the current buffer so
   * every edge change remains reversible.
   *
   * A front-edge change parks the playhead on the new in-point (you are
   * auditioning the new opening). A back-edge change leaves the playhead
   * alone unless the new out-point passes it, in which case it is clamped so
   * the cursor never sits outside the clip.
   */
  const adjustEdge = useCallback((edge: CutEdge, delta: number) => {
    const current = useProjectStore.getState().project;
    if (!current) return;
    const clip =
      current.clips.find((item) => item.id === current.selectedClipId) ?? current.clips[0];
    if (!clip) return;
    const settings = useSettingsStore.getState();
    // A fast drag or a repeated key press can ask for a start past the end (or
    // the reverse). Clamp to a small positive speech window *before* the cut is
    // derived, so an inverted pair can never reach the store as a negative
    // duration; the renderable floor below still guards the final cut.
    const nextSpeechStart =
      edge === "start"
        ? Math.min(clip.speechStart + delta, clip.speechEnd - MIN_SPEECH_WINDOW)
        : clip.speechStart;
    const nextSpeechEnd =
      edge === "end"
        ? Math.max(clip.speechEnd + delta, clip.speechStart + MIN_SPEECH_WINDOW)
        : clip.speechEnd;
    const cut = applyCutBuffer(nextSpeechStart, nextSpeechEnd, {
      duration: current.duration,
      buffer: settings.editor.cutBufferSeconds,
      autoPad: settings.editor.autoPad,
    });
    // The render floor applies to the final cut, not the speech bounds: with
    // auto-pad on, a valid 0.5 s cut can have degenerate speech bounds.
    if (cut.end - cut.start < MIN_RENDERABLE_CLIP_SECONDS) {
      toast.error("Clip is too short to render — minimum 0.5 s.");
      return;
    }
    // User-driven edge changes keep the exact step: no 1 s AI-proposal minimum.
    const normalized = normalizeSpeechRange(nextSpeechStart, nextSpeechEnd, current.duration, 0);
    if (!normalized) return;
    useProjectStore.getState().updateClip(clip.id, {
      speechStart: normalized.start,
      speechEnd: normalized.end,
      start: cut.start,
      end: cut.end,
    });
    if (edge === "start") {
      seekPlayhead(cut.start);
    } else if (playheadRef.current > cut.end) {
      seekPlayhead(cut.end);
    }
  }, [seekPlayhead]);

  const applyShuttleRate = useCallback((next: number) => {
    const clamped = Math.min(4, Math.max(0.25, next));
    setShuttleRate(clamped);
    videoRef.current?.setPlaybackRate(clamped);
  }, []);

  /**
   * J/K/L playback-rate shuttle: L plays and steps the rate up, J steps it down
   * (and rewinds once it is already at the slowest step), K pauses at 1×.
   */
  const shuttle = useCallback(
    (direction: -1 | 1) => {
      const video = videoRef.current;
      if (!video) return;
      const current = video.getPlaybackRate();
      if (direction === 1) {
        video.playClip();
        const faster =
          SHUTTLE_RATES.find((rate) => rate > current + 0.001) ??
          SHUTTLE_RATES[SHUTTLE_RATES.length - 1];
        applyShuttleRate(faster);
        return;
      }
      const slower = [...SHUTTLE_RATES]
        .reverse()
        .find((rate) => rate < current - 0.001);
      if (slower === undefined) {
        // Already at the slowest step: rewind instead of slowing down further.
        video.seekBy(-5);
        return;
      }
      video.playClip();
      applyShuttleRate(slower);
    },
    [applyShuttleRate],
  );

  const pauseShuttle = useCallback(() => {
    videoRef.current?.pause();
    applyShuttleRate(1);
  }, [applyShuttleRate]);

  const buttonStep = editor.edgeButtonStepSeconds;
  const keyStep = editor.edgeShareStep ? editor.edgeButtonStepSeconds : editor.edgeKeyStepSeconds;

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
      if (event.metaKey || event.ctrlKey) return;

      const shift = event.shiftKey;
      const alt = event.altKey;

      switch (event.key) {
        case " ":
          if (shift || alt) break;
          event.preventDefault();
          videoRef.current?.togglePlay();
          break;
        case "j":
        case "J":
          if (shift || alt) break;
          event.preventDefault();
          shuttle(-1);
          break;
        case "k":
        case "K":
          if (shift || alt) break;
          event.preventDefault();
          pauseShuttle();
          break;
        case "l":
        case "L":
          if (shift || alt) break;
          event.preventDefault();
          shuttle(1);
          break;
        case "ArrowLeft":
          // Shift owns the cut-in edge, Alt owns the cut-out edge; a plain
          // arrow moves the playhead. Both modifiers together are ignored.
          if (shift && alt) break;
          event.preventDefault();
          if (shift) adjustEdge("start", -keyStep);
          else if (alt) adjustEdge("end", -keyStep);
          else seekPlayhead(playheadRef.current - PLAYHEAD_STEP_SECONDS);
          break;
        case "ArrowRight":
          if (shift && alt) break;
          event.preventDefault();
          if (shift) adjustEdge("start", keyStep);
          else if (alt) adjustEdge("end", keyStep);
          else seekPlayhead(playheadRef.current + PLAYHEAD_STEP_SECONDS);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [adjustEdge, keyStep, pauseShuttle, seekPlayhead, shuttle]);

  function handleApprove(clip: ProjectClip) {
    approveClip(clip.id, !clip.approved);
  }

  function handleRemove(clip: ProjectClip) {
    removeClip(clip.id);
    toast(L("Clip removed"), { description: clip.title });
  }

  function moveSelection(direction: -1 | 1) {
    if (!selected) return;
    const next = clips[selectedIndex + direction];
    if (next) selectClip(next.id);
  }

  function beginSearch() {
    void runDiscovery(clips.length > 0 ? "reroll" : "initial", refinement);
  }

  function startSearch() {
    if (status === "running") return;
    if (clips.length > 0 && unapprovedCount > 0) {
      setReplaceConfirmOpen(true);
      return;
    }
    beginSearch();
  }

  function handleRetry() {
    startSearch();
  }

  function commitEdgeStep(which: "button" | "key") {
    const draft = which === "button" ? buttonStepDraft : keyStepDraft;
    const raw = draft.trim() === "" ? Number.NaN : Number(draft);
    const limit = which === "button" ? "edgeButtonStepSeconds" : "edgeKeyStepSeconds";
    const fallback =
      which === "button" ? editor.edgeButtonStepSeconds : editor.edgeKeyStepSeconds;
    if (!Number.isFinite(raw) || raw <= 0) {
      toast.error("Step size needs a positive number", {
        description: `Use a value from ${NUMERIC_LIMITS[limit].min} to ${NUMERIC_LIMITS[limit].max} seconds.`,
      });
      setDraftForStep(which, fallback);
      return;
    }
    const step = coerceToRange(raw, fallback, NUMERIC_LIMITS[limit]);
    if (which === "button") {
      updateEditor(
        editor.edgeShareStep
          ? { edgeButtonStepSeconds: step, edgeKeyStepSeconds: step }
          : { edgeButtonStepSeconds: step },
      );
      if (editor.edgeShareStep) setKeyStepDraft(String(step));
    } else {
      updateEditor({ edgeKeyStepSeconds: step });
    }
    setDraftForStep(which, step);
  }

  function setDraftForStep(which: "button" | "key", value: number) {
    if (which === "button") setButtonStepDraft(String(value));
    else setKeyStepDraft(String(value));
  }

  if (!project) {
    return (
      <StepEmptyState
        icon={FolderSearch}
        title={L("No project open")}
        description="Create or resume a lecture on Step 1 to start finding clips."
        action={<Button onClick={() => setStep(1)}>{L("Go to Step 1")}</Button>}
      />
    );
  }

  if (!project.transcript || !project.transcriptId) {
    return (
      <StepEmptyState
        icon={FileAudio}
        title={L("Transcript missing")}
        description="Add the lecture on Step 1 first — we'll transcribe it and then find clips."
        action={<Button onClick={() => setStep(1)}>{L("Back to upload")}</Button>}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex shrink-0 flex-wrap items-end justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 space-y-0.5">
          <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Step 2 of 4 · Review &amp; find more
          </p>
          <div className="flex min-w-0 items-baseline gap-2">
            <h1 className="text-base font-medium text-foreground">{L("Find clips")}</h1>
            <span className="truncate text-[11px] text-muted-foreground">{project.name}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Clock3 className="size-3.5" />
            <TimeFlow value={project.duration ?? 0} />
          </span>
          <span className="flex items-center gap-1">
            <Languages className="size-3.5" />
            {project.transcript.language?.toUpperCase() ?? "AUTO"}
          </span>
          <span className="flex items-center gap-1">
            <Captions className="size-3.5" />
            {project.transcript.segments.length} segments
          </span>
          {sourceMissing ? (
            <Button variant="ghost" size="xs" onClick={() => void relinkLecture()}>
              {L("Re-link")}
            </Button>
          ) : null}
          <Button variant="ghost" size="xs" onClick={() => setStep(1)}>
            {L("Change lecture")}
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(340px,42%)_minmax(0,1fr)]">
        {/* Left: proposed clips + refinement loop ------------------------------ */}
        <section className="flex min-h-0 flex-col border-r border-border">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <div className="flex items-center gap-2">
              <h2 className="text-[13px] font-medium text-foreground">{L("Proposed clips")}</h2>
              <Badge variant="outline" className="text-[10px] tabular-nums">
                {clips.length}
              </Badge>
            </div>
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <CheckCircle2 className="size-3.5" />
              {approvedCount} approved
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            {error ? (
              <InlineError
                className="mb-2"
                title={L("Clip finding failed")}
                action={
                  <>
                    <Button variant="outline" size="xs" onClick={handleRetry}>
                      {L("Retry")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="text-destructive"
                      onClick={() => setStep(1)}
                    >
                      {L("Re-transcribe")}
                    </Button>
                  </>
                }
              >
                {error}
              </InlineError>
            ) : null}

            {status === "running" && clips.length > 0 ? (
              <div className="mb-2 space-y-1.5">
                <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  {discoveryJob?.stageLabel || L("Looking for more moments…")}
                </p>
                {discoveryPct !== null ? (
                  <div className="flex items-center gap-2">
                    <Progress value={discoveryPct} className="h-1" />
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      <NumberFlow
                        value={discoveryPct}
                        suffix="%"
                        format={{ maximumFractionDigits: 0 }}
                      />
                    </span>
                  </div>
                ) : null}
                {activeDiscovery ? <AiActivityLine entry={activeDiscovery} /> : null}
              </div>
            ) : null}

            {status === "running" && clips.length === 0 ? (
              <div className="space-y-2" aria-busy="true">
                {[0, 1, 2].map((index) => (
                  <div
                    key={index}
                    className="h-[104px] animate-pulse rounded-lg border border-border bg-card/40"
                  />
                ))}
                <p className="pt-1 text-center text-[11px] text-muted-foreground">
                  {discoveryJob?.stageLabel ||
                    L("Reading the transcript for self-contained moments…")}
                </p>
                {discoveryPct !== null ? (
                  <div className="mx-auto flex max-w-xs items-center gap-2">
                    <Progress value={discoveryPct} className="h-1" />
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      <NumberFlow
                        value={discoveryPct}
                        suffix="%"
                        format={{ maximumFractionDigits: 0 }}
                      />
                    </span>
                  </div>
                ) : null}
                {activeDiscovery ? (
                  <AiActivityLine entry={activeDiscovery} className="justify-center" />
                ) : null}
              </div>
            ) : clips.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                <ListVideo className="size-5 text-muted-foreground" />
                <p className="text-xs font-medium text-foreground">{L("No clips proposed yet")}</p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Let the AI search the transcript for moments — or add a note about what to look
                  for and try again.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-1 gap-1.5"
                  disabled={status === "running"}
                  onClick={startSearch}
                >
                  {status === "running" ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3.5" />
                  )}
                  {L("Find clips")}
                </Button>
              </div>
            ) : (
              <ul className="space-y-2" aria-busy={status === "running"}>
                {clips.map((clip, index) => (
                  <ClipCard
                    key={clip.id}
                    clip={clip}
                    index={index}
                    selected={clip.id === selected?.id}
                    collisions={collidingTitles(clip, clips)}
                    onSelect={() => selectClip(clip.id)}
                    onApprove={() => handleApprove(clip)}
                    onRemove={() => handleRemove(clip)}
                  />
                ))}
              </ul>
            )}
          </div>

          <div className="shrink-0 space-y-2 border-t border-border bg-card/20 px-3 py-3">
            <div className="space-y-1">
              <Label htmlFor="refinement-note" className="text-[11px] font-medium text-foreground/90">
                {L("Additional instructions for this search")}
              </Label>
              <Textarea
                id="refinement-note"
                value={refinement}
                onChange={(event) => setRefinement(event.target.value)}
                rows={2}
                placeholder="Search the second half for shorter 60-second reminders"
                className="resize-y text-xs leading-relaxed"
                disabled={status === "running"}
              />
            </div>

            <div className="flex gap-2">
              <Button
                className="flex-[85] gap-2"
                size="sm"
                disabled={status === "running"}
                onClick={startSearch}
              >
                {status === "running" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                {status === "running"
                  ? L("Looking for more moments…")
                  : clips.length === 0
                    ? L("Find clips")
                    : L("Search again (keeps approved)")}
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-[15] px-0"
                    disabled={status === "running" || !project?.transcriptId}
                    onClick={() => setImportOpen(true)}
                    aria-label={L("Import clips from chat")}
                  >
                    <ClipboardPaste className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {L("Import clips from chat")}
                </TooltipContent>
              </Tooltip>
            </div>
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                {clips.length === 0
                  ? L("Approve clips to keep them out of the next search.")
                  : approvedCount > 0
                    ? `${approvedCount} approved clip${
                        approvedCount === 1 ? "" : "s"
                      } will be kept. Unapproved clips are replaced only when new clips arrive; an empty result changes nothing.`
                    : "Unapproved clips are replaced only when new clips arrive; an empty result changes nothing."}
              </p>
              {status === "running" ? (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => useJobStore.getState().cancelKind("discovery", project?.id ?? null)}
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          </div>
        </section>

        {/* Right: preview, waveform and trim ---------------------------------- */}
        <section className="flex min-h-0 flex-col">
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                {selected ? `Clip ${selectedIndex + 1} of ${clips.length}` : L("No clip selected")}
              </span>
              <span className="truncate text-[13px] font-medium text-foreground">
                {selected?.title ?? L("Select a clip to preview")}
              </span>
              {selected?.approved ? (
                <Badge variant="secondary" className="shrink-0 text-[10px]">
                  Approved
                </Badge>
              ) : null}
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Previous clip"
                disabled={!selected || selectedIndex <= 0}
                onClick={() => moveSelection(-1)}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Next clip"
                disabled={!selected || selectedIndex >= clips.length - 1}
                onClick={() => moveSelection(1)}
              >
                <ChevronRight className="size-4" />
              </Button>
              <Button
                variant={selected?.approved ? "secondary" : "outline"}
                size="xs"
                className="gap-1"
                disabled={!selected}
                onClick={() => selected && handleApprove(selected)}
              >
                <Check className="size-3" />
                {selected?.approved ? "Approved" : "Approve"}
              </Button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {/* Collapse the player to a compact placeholder when there is no
                video (NG source path), so the waveform + trim controls sit
                above the fold on shorter windows. No visual flourish. */}
            {videoSrc ? (
              <div className="aspect-video w-full overflow-hidden rounded-lg border border-border bg-black">
                <VideoPlayer
                  ref={videoRef}
                  src={videoSrc}
                  clipStart={selected?.start ?? 0}
                  clipEnd={selected?.end ?? 0}
                  onTimeUpdate={handleTimeUpdate}
                />
              </div>
            ) : (
              <div className="flex h-24 w-full items-center justify-center gap-2 rounded-lg border border-border bg-card/30">
                <FileVideo2 className="size-4 text-muted-foreground" />
                <span className="text-[11px] text-muted-foreground">{L("No video preview available")}</span>
              </div>
            )}

            <div className="mt-3 rounded-lg border border-border bg-card/30 p-3">
              <WaveformBar
                peaks={project.transcript?.peaks ?? null}
                duration={duration}
                clipStart={selected?.start ?? 0}
                clipEnd={selected?.end ?? 0}
                playhead={playhead}
                onSeek={seekPlayhead}
                onExpand={(edge) => adjustEdge(edge, edge === "start" ? -buttonStep : buttonStep)}
                onCollapse={(edge) => adjustEdge(edge, edge === "start" ? buttonStep : -buttonStep)}
              />
            </div>

            {selected ? (
              <div className="mt-3 space-y-2">
                <div className="rounded-md border border-border bg-card/30 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <Clock3 className="size-3.5 text-muted-foreground" />
                      <span className="text-xs font-medium text-foreground">{L("Edge step size")}</span>
                    </div>
                    <Switch
                      checked={editor.edgeShareStep}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          updateEditor({
                            edgeShareStep: true,
                            edgeKeyStepSeconds: editor.edgeButtonStepSeconds,
                          });
                          setKeyStepDraft(String(editor.edgeButtonStepSeconds));
                        } else {
                          updateEditor({ edgeShareStep: false });
                        }
                      }}
                      aria-label="Use the same step for buttons and keys"
                    />
                  </div>
                  <div className="mt-2 flex items-end gap-2">
                    <div className="min-w-0 flex-1 space-y-1">
                      <Label htmlFor="edge-button-step" className="text-[10px] text-muted-foreground">
                        Buttons (s)
                      </Label>
                      <Input
                        id="edge-button-step"
                        type="number"
                        inputMode="decimal"
                        min={NUMERIC_LIMITS.edgeButtonStepSeconds.min}
                        max={NUMERIC_LIMITS.edgeButtonStepSeconds.max}
                        step={NUMERIC_LIMITS.edgeButtonStepSeconds.step}
                        value={buttonStepDraft}
                        onChange={(event) => setButtonStepDraft(event.target.value)}
                        onBlur={() => commitEdgeStep("button")}
                        className="h-8 text-xs"
                      />
                    </div>
                    <div className="min-w-0 flex-1 space-y-1">
                      <Label htmlFor="edge-key-step" className="text-[10px] text-muted-foreground">
                        Keyboard (s)
                      </Label>
                      <Input
                        id="edge-key-step"
                        type="number"
                        inputMode="decimal"
                        min={NUMERIC_LIMITS.edgeKeyStepSeconds.min}
                        max={NUMERIC_LIMITS.edgeKeyStepSeconds.max}
                        step={NUMERIC_LIMITS.edgeKeyStepSeconds.step}
                        value={keyStepDraft}
                        onChange={(event) => setKeyStepDraft(event.target.value)}
                        onBlur={() => commitEdgeStep("key")}
                        disabled={editor.edgeShareStep}
                        className="h-8 text-xs"
                      />
                    </div>
                  </div>
                  <p className="mt-1.5 text-[10px] text-muted-foreground">
                    {editor.edgeShareStep
                      ? "Buttons and keys use the same step."
                      : "Set one step for the waveform buttons and one for the shortcuts."}
                  </p>
                </div>

                <div className="rounded-md border border-border bg-card/30 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <Scissors className="size-3.5 text-muted-foreground" />
                      <span className="text-xs font-medium text-foreground">
                        {L("Auto-pad cut buffer")}
                      </span>
                    </div>
                    <Switch
                      checked={editor.autoPad}
                      onCheckedChange={(checked) => updateEditor({ autoPad: checked })}
                      aria-label={L("Auto-pad cut buffer")}
                    />
                  </div>
                  <div className="mt-2 flex items-center gap-3">
                    <Slider
                      value={[bufferDraft]}
                      min={0}
                      max={NUMERIC_LIMITS.cutBufferSeconds.max}
                      step={0.05}
                      onValueChange={([value]) => setBufferDraft(value)}
                      onValueCommit={(values) => {
                        const value = values[0];
                        if (typeof value === "number") {
                          updateEditor({ cutBufferSeconds: value });
                        }
                      }}
                      disabled={!editor.autoPad}
                      aria-label="Cut buffer in seconds"
                    />
                    <span className="w-12 shrink-0 text-right text-xs tabular-nums text-foreground/90">
                      <NumberFlow
                        value={bufferDraft}
                        suffix="s"
                        format={{ maximumFractionDigits: 2 }}
                      />
                    </span>
                  </div>
                  <p className="mt-1.5 text-[10px] tabular-nums leading-relaxed text-muted-foreground">
                    speech <TimeFlow value={selected.speechStart} tenths /> →{" "}
                    <TimeFlow value={selected.speechEnd} tenths /> · cut{" "}
                    <TimeFlow value={selected.start} tenths /> →{" "}
                    <TimeFlow value={selected.end} tenths />
                  </p>
                </div>

                <p className="text-[10px] leading-relaxed text-muted-foreground">
                  Space play/pause · ←/→ move {PLAYHEAD_STEP_SECONDS} s · K pause · L faster (
                  <NumberFlow
                    value={shuttleRate}
                    suffix="×"
                    format={{ maximumFractionDigits: 2 }}
                  />
                  ) · J slower, then rewind · Shift+← grow in / Shift+→ trim in · Alt+← trim out /
                  Alt+→ grow out · {keyStep} s per edge key press
                </p>
              </div>
            ) : (
              <div className="mt-3 flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border px-6 py-10 text-center">
                <Scissors className="size-4 text-muted-foreground" />
                <p className="text-xs text-muted-foreground">{L("Select a clip to preview and trim it.")}</p>
              </div>
            )}
          </div>
        </section>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border bg-card/20 px-4 py-2.5">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <CheckCircle2 className="size-3.5" />
          {approvedCount > 0
            ? `${approvedCount} of ${clips.length} clips approved`
            : "Approve at least one clip to continue"}
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => setStep(1)}>
            {L("Back to upload")}
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            disabled={approvedCount === 0}
            onClick={() => setStep(3)}
          >
            {L("Continue to subtitles")}
            <ArrowRight className="size-3.5" />
          </Button>
        </div>
      </footer>

      <AlertDialog open={replaceConfirmOpen} onOpenChange={setReplaceConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{L("Replace unapproved clips?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {`This search keeps your ${approvedCount} approved clip${
                approvedCount === 1 ? "" : "s"
              }. If new clips are found, ${unapprovedCount} unapproved clip${
                unapprovedCount === 1 ? "" : "s"
              } will be replaced. Trims and subtitle edits on those clips will be lost. If nothing new is found, your current clips remain unchanged.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="outline">{L("Cancel")}</Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button onClick={beginSearch}>{L("Search and replace")}</Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ImportClipsDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}

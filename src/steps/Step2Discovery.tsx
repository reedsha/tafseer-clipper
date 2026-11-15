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
  AlertTriangle,
  ArrowRight,
  Captions,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileAudio,
  FileVideo2,
  FolderSearch,
  Languages,
  ListVideo,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Scissors,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { cn } from "cn";

import { TimeFlow } from "@/components/TimeFlow";
import { VideoPlayer, type VideoPlayerHandle } from "@/components/VideoPlayer";
import { WaveformBar } from "@/components/WaveformBar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { discoverClips, type ClipProposal, type ProviderOverride } from "@/lib/api";
import {
  applyCutBuffer,
  MIN_RENDERABLE_CLIP_SECONDS,
  normalizeSpeechRange,
  rangesOverlap,
  speechFromCut,
} from "@/lib/clipMath";
import { toMediaSrc } from "@/lib/media";
import { formatClock } from "@/lib/format";
import type { ProjectClip } from "@/lib/projectTypes";
import { useProjectStore } from "@/store/projectStore";
import { useSettingsStore, type SettingsState } from "@/store/settingsStore";

type DiscoveryMode = "initial" | "reroll";
type CutEdge = "start" | "end";

/** Playback-rate ladder for the J/K/L shuttle (1× = normal speed). */
const SHUTTLE_RATES = [0.25, 0.5, 1, 1.5, 2, 3, 4] as const;

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

function buildProvider(settings: SettingsState): ProviderOverride | null {
  if (settings.analysisMode === "local") {
    return {
      base_url: settings.ollama.baseUrl || null,
      api_key: "",
      model: settings.ollama.model || null,
      timeout: settings.cloud.timeout || null,
    };
  }
  return {
    base_url: settings.cloud.baseUrl || null,
    api_key: settings.cloud.apiKey || null,
    model: settings.cloud.reasoningModel || null,
    timeout: settings.cloud.timeout || null,
  };
}

function proposalToClip(
  proposal: ClipProposal,
  index: number,
  duration: number | null,
  buffer: number,
  autoPad: boolean,
): ProjectClip | null {
  const speech = normalizeSpeechRange(proposal.start, proposal.end, duration);
  if (!speech) return null;
  const cut = applyCutBuffer(speech.start, speech.end, { duration, buffer, autoPad });
  return {
    id: crypto.randomUUID(),
    title: proposal.title.trim() || `Clip ${index + 1}`,
    rationale: proposal.rationale.trim(),
    start: cut.start,
    end: cut.end,
    speechStart: speech.start,
    speechEnd: speech.end,
    approved: false,
    createdAt: Date.now(),
  };
}

/* -------------------------------------------------------------------------- */
/* Local components                                                            */
/* -------------------------------------------------------------------------- */

function ClipCard({
  clip,
  index,
  selected,
  onSelect,
  onApprove,
  onRemove,
}: {
  clip: ProjectClip;
  index: number;
  selected: boolean;
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
        }`}
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
          <p className="mt-1.5 line-clamp-2 pl-7 text-[11px] leading-relaxed text-muted-foreground">
            {clip.rationale}
          </p>
        ) : null}
      </Button>

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

function TrimRow({
  label,
  value,
  speechValue,
  active,
  onActivate,
  onNudge,
}: {
  label: string;
  value: number;
  speechValue: number;
  active: boolean;
  onActivate: () => void;
  onNudge: (delta: number) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={active}
      aria-label={`${label} trim controls`}
      onClick={onActivate}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onActivate();
        }
      }}
      className={cn(
        "cursor-default rounded-md border px-2.5 py-2 transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
        active ? "border-ring/40 bg-accent/25" : "border-border bg-card/30",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </span>
        <TimeFlow value={value} tenths className="text-xs font-medium text-foreground" />
      </div>
      <div className="mt-1.5 flex items-center gap-1">
        <Button
          variant="outline"
          size="icon-xs"
          aria-label={`Nudge ${label} back 0.2 seconds`}
          onClick={(event) => {
            event.stopPropagation();
            onNudge(-0.2);
          }}
        >
          <Minus className="size-3" />
        </Button>
        <span className="flex-1 text-center text-[10px] text-muted-foreground">0.2 s</span>
        <Button
          variant="outline"
          size="icon-xs"
          aria-label={`Nudge ${label} forward 0.2 seconds`}
          onClick={(event) => {
            event.stopPropagation();
            onNudge(0.2);
          }}
        >
          <Plus className="size-3" />
        </Button>
      </div>
      <p className="mt-1 text-[10px] tabular-nums text-muted-foreground/70">
        speech <TimeFlow value={speechValue} tenths />
      </p>
    </div>
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

  const [status, setStatus] = useState<"idle" | "running" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [refinement, setRefinement] = useState("");
  const [activeEdge, setActiveEdge] = useState<CutEdge>("start");
  const [bufferDraft, setBufferDraft] = useState(editor.cutBufferSeconds);
  const [playhead, setPlayhead] = useState(0);
  const [shuttleRate, setShuttleRate] = useState(1);

  const videoRef = useRef<VideoPlayerHandle>(null);
  const requestRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const autoRunKeyRef = useRef<string | null>(null);
  const lastProjectIdRef = useRef<string | null>(project?.id ?? null);

  const clips = project?.clips ?? [];
  const approvedClips = useMemo(() => clips.filter((clip) => clip.approved), [clips]);
  const approvedCount = approvedClips.length;
  const selected = clips.find((clip) => clip.id === project?.selectedClipId) ?? clips[0] ?? null;
  const selectedIndex = selected ? clips.findIndex((clip) => clip.id === selected.id) : -1;
  const duration = project?.duration ?? 0;
  const audioSrc = useMemo(() => toMediaSrc(project?.audioPath), [project?.audioPath]);
  const videoSrc = useMemo(() => toMediaSrc(project?.sourcePath), [project?.sourcePath]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Switching projects while a discovery call is in flight must not apply the
  // old proposals to the newly opened lecture. The id ref also keeps React
  // StrictMode's double effect setup from aborting the first auto-discovery.
  useEffect(() => {
    const nextId = project?.id ?? null;
    if (lastProjectIdRef.current === nextId) return;
    lastProjectIdRef.current = nextId;
    requestRef.current?.abort();
    requestRef.current = null;
    setStatus("idle");
    setError(null);
    setRefinement("");
    setPlayhead(0);
  }, [project?.id]);

  useEffect(() => {
    setBufferDraft(editor.cutBufferSeconds);
  }, [editor.cutBufferSeconds]);

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
      toast.error("Transcript missing", { description: "Run the lecture through Step 1 first." });
      return;
    }
    if (!current.transcript || current.transcript.segments.length === 0) {
      // Whisper may legitimately return no segments for silent audio; searching
      // an empty transcript would only burn an LLM call and confuse the editor.
      toast.error("Whisper found no speech", {
        description:
          "The transcript has no segments, so there is nothing to search. Re-transcribe the lecture on Step 1 or check the audio.",
      });
      return;
    }
    const settings = useSettingsStore.getState();
    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    setStatus("running");
    setError(null);

    try {
      const approvedRanges = current.clips
        .filter((clip) => clip.approved)
        .map((clip) => ({ start: clip.start, end: clip.end }));

      const result = await discoverClips(
        {
          transcript_id: current.transcriptId,
          base_prompt: current.basePrompt,
          session_guide: current.sessionGuide,
          refinement_note: note.trim(),
          excluded_ranges: approvedRanges,
          max_clips: current.discovery.maxClips,
          min_duration: current.discovery.minDuration,
          max_duration: current.discovery.maxDuration,
          language: settings.editor.language || "th",
          provider: buildProvider(settings),
        },
        { signal: controller.signal },
      );

      if (!mountedRef.current || requestRef.current !== controller) return;

      const latest = useProjectStore.getState().project;
      if (!latest) return;
      const latestSettings = useSettingsStore.getState();
      const approved = latest.clips.filter((clip) => clip.approved);
      const proposals = result.clips
        .map((proposal, index) =>
          proposalToClip(
            proposal,
            index,
            latest.duration,
            latestSettings.editor.cutBufferSeconds,
            latestSettings.editor.autoPad,
          ),
        )
        .filter((clip): clip is ProjectClip => clip !== null)
        .filter(
          (clip) =>
            !approved.some((kept) =>
              rangesOverlap(clip.start, clip.end, kept.start, kept.end),
            ),
        );

      const merged = [...approved, ...proposals].sort((a, b) => a.start - b.start);
      useProjectStore.getState().setClips(merged);
      if (note.trim()) setRefinement("");

      toast.success(mode === "reroll" ? "Re-roll complete" : "Clip proposals ready", {
        description: `${proposals.length} new clip${proposals.length === 1 ? "" : "s"}${
          result.excluded_ranges_applied > 0
            ? ` · ${result.excluded_ranges_applied} approved interval${
                result.excluded_ranges_applied === 1 ? "" : "s"
              } locked`
            : ""
        } · ${result.model}`,
      });
      if (proposals.length === 0) {
        toast("No new clips", {
          description: "Add a refinement note and re-run on the unapproved parts.",
        });
      }
      setStatus("idle");
    } catch (caught) {
      if (!mountedRef.current || requestRef.current !== controller) return;
      if (controller.signal.aborted) {
        // The editor aborted the request (Cancel button / new run); the old
        // silent return left no trace that the run had stopped.
        setStatus("idle");
        toast("Discovery cancelled");
        return;
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      setStatus("error");
      setError(message);
      toast.error("Clip discovery failed", { description: message });
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!project?.transcriptId || project.clips.length > 0) return;
    const key = `${project.id}:${project.transcriptId}`;
    if (autoRunKeyRef.current === key) return;
    autoRunKeyRef.current = key;
    void runDiscovery("initial", "");
  }, [project?.id, project?.transcriptId, project?.clips.length, runDiscovery]);

  const nudgeEdge = useCallback((edge: CutEdge, delta: number) => {
    const current = useProjectStore.getState().project;
    if (!current) return;
    const clip =
      current.clips.find((item) => item.id === current.selectedClipId) ?? current.clips[0];
    if (!clip) return;
    const settings = useSettingsStore.getState();
    const nextSpeechStart = edge === "start" ? clip.speechStart + delta : clip.speechStart;
    const nextSpeechEnd = edge === "end" ? clip.speechEnd + delta : clip.speechEnd;
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
    // User-driven nudges keep the drag exact: no 1 s AI-proposal minimum.
    const normalized = normalizeSpeechRange(nextSpeechStart, nextSpeechEnd, current.duration, 0);
    if (!normalized) return;
    useProjectStore.getState().updateClip(clip.id, {
      speechStart: normalized.start,
      speechEnd: normalized.end,
      start: cut.start,
      end: cut.end,
    });
  }, []);

  const handleTrimCommit = useCallback((range: { start: number; end: number }) => {
    const current = useProjectStore.getState().project;
    if (!current) return;
    const clip =
      current.clips.find((item) => item.id === current.selectedClipId) ?? current.clips[0];
    if (!clip) return;
    const settings = useSettingsStore.getState();
    const context = {
      duration: current.duration,
      buffer: settings.editor.cutBufferSeconds,
      autoPad: settings.editor.autoPad,
    };
    // The render floor applies to the dragged cut; rejecting silently was the
    // old bug (drag below 1 s + 2×buffer did nothing with zero feedback).
    if (range.end - range.start < MIN_RENDERABLE_CLIP_SECONDS) {
      toast.error("Clip is too short to render — minimum 0.5 s.");
      return;
    }
    const speech = speechFromCut(range.start, range.end, context);
    // User-driven trims keep the drag exact: no 1 s AI-proposal minimum (with
    // auto-pad on, a 0.5 s cut has ~0 s of speech inside it).
    const normalized = normalizeSpeechRange(speech.start, speech.end, current.duration, 0);
    if (!normalized) return;
    const cut = applyCutBuffer(normalized.start, normalized.end, context);
    useProjectStore.getState().updateClip(clip.id, {
      speechStart: normalized.start,
      speechEnd: normalized.end,
      start: cut.start,
      end: cut.end,
    });
  }, []);

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

      switch (event.key) {
        case " ":
          event.preventDefault();
          videoRef.current?.togglePlay();
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
          nudgeEdge(activeEdge, -0.2);
          break;
        case "ArrowRight":
          event.preventDefault();
          nudgeEdge(activeEdge, 0.2);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeEdge, nudgeEdge, pauseShuttle, shuttle]);

  function handleApprove(clip: ProjectClip) {
    approveClip(clip.id, !clip.approved);
  }

  function handleRemove(clip: ProjectClip) {
    removeClip(clip.id);
    toast("Clip removed", { description: clip.title });
  }

  function moveSelection(direction: -1 | 1) {
    if (!selected) return;
    const next = clips[selectedIndex + direction];
    if (next) selectClip(next.id);
  }

  function handleRetry() {
    void runDiscovery(approvedCount > 0 ? "reroll" : "initial", refinement);
  }

  if (!project) {
    return (
      <StepEmptyState
        icon={FolderSearch}
        title="No project open"
        description="Create or resume a lecture on Step 1 to start finding clips."
        action={<Button onClick={() => setStep(1)}>Go to Step 1</Button>}
      />
    );
  }

  if (!project.transcript || !project.transcriptId) {
    return (
      <StepEmptyState
        icon={FileAudio}
        title="Transcript missing"
        description="This project has no transcript yet. Upload the lecture on Step 1 so the sidecar can extract audio and run Whisper first."
        action={<Button onClick={() => setStep(1)}>Back to upload</Button>}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex shrink-0 flex-wrap items-end justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 space-y-0.5">
          <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Step 2 of 4 · Keep &amp; re-roll
          </p>
          <div className="flex min-w-0 items-baseline gap-2">
            <h1 className="text-base font-medium text-foreground">Find clips</h1>
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
          <Button variant="ghost" size="xs" onClick={() => setStep(1)}>
            Change lecture
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(340px,42%)_minmax(0,1fr)]">
        {/* Left: proposed clips + refinement loop ------------------------------ */}
        <section className="flex min-h-0 flex-col border-r border-border">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <div className="flex items-center gap-2">
              <h2 className="text-[13px] font-medium text-foreground">Proposed clips</h2>
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
              <div className="mb-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[11px] leading-relaxed text-destructive">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="font-medium">Discovery failed</p>
                  <p className="break-words">{error}</p>
                  <div className="flex flex-wrap gap-1.5 pt-0.5">
                    <Button variant="outline" size="xs" onClick={handleRetry}>
                      Retry
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="text-destructive"
                      onClick={() => setStep(1)}
                    >
                      Re-transcribe
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}

            {status === "running" && clips.length > 0 ? (
              <p className="mb-2 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                Searching the unclaimed segments…
              </p>
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
                  Searching the transcript for self-contained moments…
                </p>
              </div>
            ) : clips.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                <ListVideo className="size-5 text-muted-foreground" />
                <p className="text-xs font-medium text-foreground">No clips proposed yet</p>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Run discovery to let the reasoning model search the transcript, or add a
                  refinement note and try again.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-1 gap-1.5"
                  disabled={status === "running"}
                  onClick={() =>
                    void runDiscovery(approvedCount > 0 ? "reroll" : "initial", refinement)
                  }
                >
                  {status === "running" ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3.5" />
                  )}
                  Find clips
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
                    onSelect={() => selectClip(clip.id)}
                    onApprove={() => handleApprove(clip)}
                    onRemove={() => handleRemove(clip)}
                  />
                ))}
              </ul>
            )}
          </div>

          <div className="shrink-0 space-y-2 border-t border-border bg-card/20 px-3 py-3">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="refinement-note" className="text-[11px] font-medium text-foreground/90">
                Refinement note
              </Label>
              <span className="text-[10px] text-muted-foreground">applies to the next search</span>
            </div>
            <Textarea
              id="refinement-note"
              value={refinement}
              onChange={(event) => setRefinement(event.target.value)}
              rows={2}
              placeholder="Search the second half for shorter 60-second reminders"
              className="resize-y text-xs leading-relaxed"
              disabled={status === "running"}
            />
            <Button
              className="w-full gap-2"
              size="sm"
              disabled={status === "running"}
              onClick={() =>
                void runDiscovery(approvedCount > 0 ? "reroll" : "initial", refinement)
              }
            >
              {status === "running" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {status === "running"
                ? "Searching unclaimed segments…"
                : approvedCount > 0
                  ? "Re-run AI on unapproved parts"
                  : "Find clips"}
            </Button>
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                {approvedCount > 0
                  ? `${approvedCount} approved interval${approvedCount === 1 ? "" : "s"} locked out of the next search.`
                  : "Approve clips to lock them out of the next re-roll."}
              </p>
              {status === "running" ? (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => requestRef.current?.abort()}
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
                {selected ? `Clip ${selectedIndex + 1} of ${clips.length}` : "No clip selected"}
              </span>
              <span className="truncate text-[13px] font-medium text-foreground">
                {selected?.title ?? "Select a clip to preview"}
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
                  onTimeUpdate={setPlayhead}
                />
              </div>
            ) : (
              <div className="flex h-24 w-full items-center justify-center gap-2 rounded-lg border border-border bg-card/30">
                <FileVideo2 className="size-4 text-muted-foreground" />
                <span className="text-[11px] text-muted-foreground">No video preview available</span>
              </div>
            )}

            <div className="mt-3 rounded-lg border border-border bg-card/30 p-3">
              <WaveformBar
                audioUrl={audioSrc}
                peaks={project.transcript?.peaks ?? null}
                duration={duration}
                clipStart={selected?.start ?? 0}
                clipEnd={selected?.end ?? 0}
                playhead={playhead}
                onSeek={(seconds) => {
                  setPlayhead(seconds);
                  videoRef.current?.seekTo(seconds);
                }}
                onTrimCommit={handleTrimCommit}
              />
            </div>

            {selected ? (
              <div className="mt-3 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <TrimRow
                    label="Cut in"
                    value={selected.start}
                    speechValue={selected.speechStart}
                    active={activeEdge === "start"}
                    onActivate={() => setActiveEdge("start")}
                    onNudge={(delta) => {
                      setActiveEdge("start");
                      nudgeEdge("start", delta);
                    }}
                  />
                  <TrimRow
                    label="Cut out"
                    value={selected.end}
                    speechValue={selected.speechEnd}
                    active={activeEdge === "end"}
                    onActivate={() => setActiveEdge("end")}
                    onNudge={(delta) => {
                      setActiveEdge("end");
                      nudgeEdge("end", delta);
                    }}
                  />
                </div>

                <div className="rounded-md border border-border bg-card/30 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <Scissors className="size-3.5 text-muted-foreground" />
                      <span className="text-xs font-medium text-foreground">
                        Auto-pad cut buffer
                      </span>
                    </div>
                    <Switch
                      checked={editor.autoPad}
                      onCheckedChange={(checked) => updateEditor({ autoPad: checked })}
                      aria-label="Auto-pad cut buffer"
                    />
                  </div>
                  <div className="mt-2 flex items-center gap-3">
                    <Slider
                      value={[bufferDraft]}
                      min={0}
                      max={1}
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
                  Space play/pause · K pause · L faster (
                  <NumberFlow
                    value={shuttleRate}
                    suffix="×"
                    format={{ maximumFractionDigits: 2 }}
                  />
                  ) · J slower, then rewind · ←/→ nudge{" "}
                  {activeEdge === "start" ? "cut in" : "cut out"} 0.2 s
                </p>
              </div>
            ) : (
              <div className="mt-3 flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border px-6 py-10 text-center">
                <Scissors className="size-4 text-muted-foreground" />
                <p className="text-xs text-muted-foreground">Select a clip to preview and trim it.</p>
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
            Back to upload
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            disabled={approvedCount === 0}
            onClick={() => setStep(3)}
          >
            Continue to subtitles
            <ArrowRight className="size-3.5" />
          </Button>
        </div>
      </footer>
    </div>
  );
}

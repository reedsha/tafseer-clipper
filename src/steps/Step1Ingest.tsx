import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import NumberFlow from "@number-flow/react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Captions,
  CheckCircle2,
  ChevronRight,
  FileVideo2,
  FolderOpen,
  Info,
  Loader2,
  Settings2,
} from "lucide-react";
import { cn } from "cn";

import { PromptDrawer } from "@/components/PromptDrawer";
import { GpuInlineHint } from "@/components/GpuAcceleration";
import { RecentProjectsBar } from "@/components/RecentProjectsBar";
import { SegmentedToggle } from "@/components/SegmentedToggle";
import { SidecarStatusDot } from "@/components/SidecarStatusDot";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { extractAndTranscribe, SIDECAR_URL } from "@/lib/api";
import { describeAcceleration } from "@/lib/acceleration";
import { formatBytes, formatClock, stripExtension } from "@/lib/format";
import {
  LECTURE_EXTENSIONS,
  fileFromDrop,
  hasLectureExtension,
  openLectureFile,
  subscribeNativeDrops,
} from "@/lib/media";
import { DEFAULT_DISCOVERY_SETTINGS, type ProjectData, type TranscriptData } from "@/lib/projectTypes";
import { openProjectFile } from "@/lib/projectFile";
import { describeProviderGap } from "@/lib/providers";
import { useProjectStore } from "@/store/projectStore";
import { useSettingsStore, type EngineMode } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";

/* -------------------------------------------------------------------------- */
/* Step 1                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One sentence for the provider-gap warning, shared by the inline Step 1
 * warning and the pre-flight toast so the two can never drift back into
 * contradictory copy ("clip discovery needs the key" while blocking
 * transcription).
 */
function analysisGapMessage(gap: string): string {
  return `Topic analysis (Step 2) needs ${gap}. Transcribing now would produce a transcript Step 2 can't search, so it's blocked until this is set.`;
}

export function Step1Ingest() {
  const project = useProjectStore((state) => state.project);
  const recentProjects = useProjectStore((state) => state.recentProjects);
  const lastProjectId = useProjectStore((state) => state.lastProjectId);
  const resumeRecent = useProjectStore((state) => state.resumeRecent);
  const setStep = useProjectStore((state) => state.setStep);

  const transcriptionMode = useSettingsStore((state) => state.transcriptionMode);
  const analysisMode = useSettingsStore((state) => state.analysisMode);
  const cloud = useSettingsStore((state) => state.cloud);
  const cloudStt = useSettingsStore((state) => state.cloudStt);
  const ollama = useSettingsStore((state) => state.ollama);
  const whisper = useSettingsStore((state) => state.whisper);
  const promptPresets = useSettingsStore((state) => state.promptPresets);
  const sidecar = useSettingsStore((state) => state.sidecar);
  const setTranscriptionMode = useSettingsStore((state) => state.setTranscriptionMode);
  const setAnalysisMode = useSettingsStore((state) => state.setAnalysisMode);
  const refreshHealth = useSettingsStore((state) => state.refreshHealth);

  const openSettings = useUiStore((state) => state.openSettings);
  const setRecentOpen = useUiStore((state) => state.setRecentOpen);

  const [dragging, setDragging] = useState(false);
  const [browserFile, setBrowserFile] = useState<{ name: string; size: number } | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [pendingReplace, setPendingReplace] = useState<{ path: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  // A project switch (resume/open/replace) must not let an in-flight
  // transcription land in the wrong project.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setError(null);
    const current = useProjectStore.getState().project;
    if (current?.sourcePath || current?.transcript) setBrowserFile(null);
  }, [project?.id]);

  useEffect(() => {
    if (!busy) return;
    const startedAt = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => {
      setElapsed((Date.now() - startedAt) / 1000);
    }, 250);
    return () => window.clearInterval(timer);
  }, [busy]);

  const activePreset = useMemo(
    () =>
      project?.promptPresetId != null
        ? (promptPresets.find((preset) => preset.id === project.promptPresetId) ?? null)
        : null,
    [project?.promptPresetId, promptPresets],
  );

  const presetValue = activePreset
    ? activePreset.id
    : project?.basePrompt.trim()
      ? "custom"
      : "default";
  const promptBadge = activePreset ? "Preset" : project?.basePrompt.trim() ? "Custom" : "Default";
  const discovery = project?.discovery ?? DEFAULT_DISCOVERY_SETTINGS;
  const promptPreview =
    project?.basePrompt.trim() ||
    activePreset?.prompt ||
    "The sidecar's built-in editorial policy will be used.";

  /** Vendor-neutral acceleration state derived from GET /health. */
  const acceleration = describeAcceleration(sidecar.health);

  const transcriptionDetail =
    transcriptionMode === "local"
      ? `faster-whisper ${whisper.model} · ${whisper.computeType}${
          sidecar.health ? (acceleration.transcription === "gpu" ? " · GPU" : " · CPU") : ""
        }`
      : `Cloud STT · ${cloudStt.model || "model not set"}${
          cloudStt.baseUrl ? "" : " · endpoint missing"
        }`;

  const analysisDetail =
    analysisMode === "cloud"
      ? `${cloud.reasoningModel || "reasoning model not set"} · ${
          cloud.apiKey ? "key saved" : "no API key"
        }`
      : `Ollama · ${ollama.model || "model not set"}`;

  /** Missing provider field that would block Step 2 discovery, if any. */
  const analysisGap =
    analysisMode === "cloud"
      ? describeProviderGap({ analysisMode, ollama, cloud }, "reasoning")
      : null;

  const ensureProject = useCallback((): ProjectData => {
    const current = useProjectStore.getState().project;
    if (current) return current;
    return useProjectStore.getState().createProject();
  }, []);

  const stagePath = useCallback((path: string, displayName?: string) => {
    if (busyRef.current) return;
    const sourceFileName = displayName?.trim() || path.split(/[\\/]/).pop() || path;
    if (!hasLectureExtension(sourceFileName) && !hasLectureExtension(path)) {
      toast.error("Unsupported file", { description: "Choose an MP4, MOV or MKV lecture." });
      return;
    }

    const current = useProjectStore.getState().project;
    if (current && (current.transcript || current.clips.length > 0)) {
      setPendingReplace({ path, name: sourceFileName });
      return;
    }

    const name = stripExtension(sourceFileName);
    if (current) {
      useProjectStore.getState().updateProject({
        sourcePath: path,
        sourceFileName,
        name,
        audioPath: null,
        transcriptId: null,
        transcript: null,
        duration: null,
        clips: [],
        selectedClipId: null,
        // A new lecture must not inherit cue tracks keyed by the old clip ids.
        subtitles: {},
        step: 1,
      });
    } else {
      useProjectStore.getState().createProject({ sourcePath: path, sourceFileName, name });
    }
    setBrowserFile(null);
    setError(null);
    toast.success("Lecture ready", { description: sourceFileName });
  }, []);

  const handleBrowserFile = useCallback(
    (file: File) => {
      if (busyRef.current) return;
      if (!hasLectureExtension(file.name)) {
        toast.error("Unsupported file", { description: "Choose an MP4, MOV or MKV lecture." });
        return;
      }
      const maybePath = (file as File & { path?: string }).path;
      if (maybePath) {
        stagePath(maybePath, file.name);
        return;
      }
      if (useProjectStore.getState().project?.sourcePath) {
        toast.error("Desktop shell required", {
          description:
            "The open lecture already has a file path. Drop the replacement from Explorer inside the desktop app.",
        });
        return;
      }
      if (useProjectStore.getState().project?.transcript) {
        toast.error("Replace the lecture first", {
          description:
            "This project already has a transcript. Use Replace lecture in the desktop shell to start a new one.",
        });
        return;
      }
      setBrowserFile({ name: file.name, size: file.size });
      setError(null);
      toast("File selected", {
        description:
          "The browser cannot expose an absolute path. Launch the desktop shell to transcribe it.",
      });
    },
    [stagePath],
  );

  useEffect(() => {
    const unsubscribe = subscribeNativeDrops({
      onEnter: () => setDragging(true),
      onLeave: () => setDragging(false),
      onDrop: (paths) => {
        setDragging(false);
        const path = paths.find((candidate) => hasLectureExtension(candidate));
        if (!path) {
          if (paths.length > 0) {
            toast.error("Unsupported file", { description: "Drop an MP4, MOV or MKV lecture." });
          }
          return;
        }
        stagePath(path);
      },
    });
    return unsubscribe;
  }, [stagePath]);

  async function handleBrowse() {
    if (busy) return;
    try {
      const result = await openLectureFile();
      if (result.cancelled) return;
      if (result.path) {
        stagePath(result.path, result.name ?? undefined);
        return;
      }
      if (result.file) {
        handleBrowserFile(result.file);
        return;
      }
      toast.error("Could not open a lecture", {
        description: `${result.reason ?? "The native file dialog is unavailable in this build."} Drag the lecture from Explorer instead.`,
      });
    } catch (caught) {
      toast.error("Could not open a lecture", {
        description: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    const file = fileFromDrop(event.dataTransfer);
    if (!file) return;
    const maybePath = (file as File & { path?: string }).path;
    if (maybePath) stagePath(maybePath, file.name);
    else handleBrowserFile(file);
  }

  function handleDragEnter(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    if (!busy) setDragging(true);
  }

  function handleDragLeave(event: DragEvent<HTMLElement>) {
    if (event.currentTarget === event.target) setDragging(false);
  }

  function handleDropzoneKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    void handleBrowse();
  }

  function handlePresetChange(value: string) {
    ensureProject();
    const store = useProjectStore.getState();
    if (value === "custom") {
      // The only enabled "custom" entry opens the editor instead of a dead no-op.
      setPromptOpen(true);
      return;
    }
    if (value === "default") {
      store.setBasePrompt("");
      store.setPromptPreset(null);
      store.updateProject({ discovery: { ...DEFAULT_DISCOVERY_SETTINGS } });
      return;
    }
    const preset = promptPresets.find((item) => item.id === value);
    if (!preset) return;
    store.setBasePrompt(preset.prompt);
    store.setPromptPreset(preset.id);
    store.updateProject({
      discovery: {
        minDuration: preset.minDuration,
        maxDuration: preset.maxDuration,
        maxClips: preset.maxClips,
      },
    });
  }

  function handleOpenPrompt() {
    ensureProject();
    setPromptOpen(true);
  }

  function handleGuideChange(value: string) {
    ensureProject();
    useProjectStore.getState().setSessionGuide(value);
  }

  async function handleResume(projectId: string) {
    const resumed = await resumeRecent(projectId);
    if (!resumed) {
      toast.error("Auto-save not found", {
        description:
          "No .tafseer snapshot was found for this lecture on disk or in local storage.",
      });
      return;
    }
    const resumedProject = useProjectStore.getState().project;
    toast.success("Lecture resumed", {
      description: `${resumedProject?.name ?? "Project"} · Step ${resumedProject?.step ?? 1}`,
    });
  }

  async function handleOpenProject() {
    try {
      const opened = await openProjectFile();
      if (!opened) return;
      useProjectStore.getState().openProject(opened);
      toast.success("Project opened", { description: opened.name });
    } catch (caught) {
      toast.error("Could not open project", {
        description: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }

  function handleReplaceConfirm() {
    const pending = pendingReplace;
    setPendingReplace(null);
    if (!pending) return;
    const previous = useProjectStore.getState().project;
    useProjectStore.getState().createProject({
      sourcePath: pending.path,
      sourceFileName: pending.name,
      name: stripExtension(pending.name),
    });
    if (previous) {
      useProjectStore.getState().updateProject({
        basePrompt: previous.basePrompt,
        promptPresetId: previous.promptPresetId,
        sessionGuide: previous.sessionGuide,
        discovery: { ...previous.discovery },
      });
    }
    setBrowserFile(null);
    setError(null);
    toast.success("New lecture ready", { description: pending.name });
  }

  async function handleTranscribe() {
    const current = useProjectStore.getState().project;
    if (!current?.sourcePath) {
      toast.error("Lecture path missing", {
        description:
          "The browser preview cannot read absolute paths. Drop the file from Explorer in the desktop shell.",
      });
      return;
    }

    const settings = useSettingsStore.getState();
    if (settings.transcriptionMode === "cloud" && !settings.cloudStt.baseUrl.trim()) {
      toast.error("Cloud STT is not configured", {
        description: "Set the endpoint, model and API key in Settings → AI Providers.",
      });
      useUiStore.getState().openSettings("providers");
      return;
    }

    // Pre-flight the Step 2 reasoning provider too: without a key/model the
    // discovery call can only fail after the whole lecture has been
    // transcribed, so catch it before Whisper starts.
    const analysisGap = describeProviderGap(settings, "reasoning");
    if (settings.analysisMode === "cloud" && analysisGap) {
      toast.error("Topic analysis is not configured", {
        description: analysisGapMessage(analysisGap),
      });
      useUiStore.getState().openSettings("providers");
      return;
    }

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setBusy(true);
    setError(null);

    try {
      const glossary = Object.fromEntries(
        settings.glossary
          .filter((entry) => entry.enabled && entry.find.trim())
          .map((entry) => [entry.find, entry.replace]),
      );

      const result = await extractAndTranscribe(
        {
          file_path: current.sourcePath,
          use_local_whisper: settings.transcriptionMode === "local",
          initial_prompt: settings.whisper.initialPrompt,
          language: settings.editor.language || null,
          glossary,
          model: settings.transcriptionMode === "local" ? settings.whisper.model : null,
          compute_type:
            settings.transcriptionMode === "local" ? settings.whisper.computeType : null,
          auto_unload: settings.whisper.autoUnload,
          vad_filter: true,
          cloud:
            settings.transcriptionMode === "cloud"
              ? {
                  base_url: settings.cloudStt.baseUrl,
                  api_key: settings.cloudStt.apiKey || null,
                  model: settings.cloudStt.model || "whisper-1",
                  language: settings.editor.language || null,
                }
              : null,
        },
        { signal: controller.signal },
      );

      if (!mountedRef.current || abortRef.current !== controller) return;

      const store = useProjectStore.getState();
      // `peaks` is the additive P2 field on TranscriptData (precomputed
      // waveform peaks from the sidecar). Written through an intersection so
      // this compiles whether or not the domain type has landed yet, and is a
      // plain assignment once it has.
      const transcript: TranscriptData & { peaks?: number[] } = {
        language: result.language,
        languageProbability: result.language_probability,
        segments: result.segments,
      };
      if (result.waveform_peaks?.length) {
        transcript.peaks = result.waveform_peaks;
      }
      store.setTranscript(result.transcript_id, transcript, result.duration);
      store.updateProject({ audioPath: result.audio_path, duration: result.duration });
      store.setStep(2);

      toast.success("Transcript ready", {
        description: `${result.segments.length} segments · ${result.model} · ${result.device}`,
      });
      if (result.vram_unloaded) {
        toast.success("Whisper unloaded from GPU memory");
      }
    } catch (caught) {
      if (!mountedRef.current || abortRef.current !== controller) return;
      if (controller.signal.aborted) {
        toast("Transcription cancelled");
        return;
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      toast.error("Transcription failed", { description: message });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (mountedRef.current) setBusy(false);
    }
  }

  const hasSource = Boolean(
    project?.sourcePath || project?.sourceFileName || project?.transcript,
  );
  const displayName = browserFile?.name ?? project?.sourceFileName ?? null;
  const dropTitle = dragging
    ? "Release to load the lecture"
    : hasSource
      ? project?.transcript
        ? "Transcript ready"
        : "Lecture selected"
      : "Drop a lecture here";
  const dropDescription = dragging
    ? "MP4, MOV or MKV"
    : hasSource
      ? project?.transcript
        ? "The transcript is saved in this project. Continue to clip discovery, or replace the lecture."
        : "Ready for local transcription. Drop another file to replace it."
      : "MP4, MOV or MKV. Long-form Tafseer lectures are expected; audio stays on this machine.";

  return (
    <>
      <div className="h-full overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-8 py-7">
          <header className="flex flex-wrap items-end justify-between gap-3">
            <div className="space-y-1.5">
              <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                Step 1 of 4
              </p>
              <h1 className="text-lg font-medium text-foreground">Ingest a lecture</h1>
              <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
                Drop a long-form Tafseer lecture, pick an editorial preset, then let the sidecar
                extract and transcribe the Thai–Arabic audio.
              </p>
            </div>
            {project ? (
              <Badge variant="outline" className="max-w-64 truncate">
                {project.name}
              </Badge>
            ) : null}
          </header>

          <RecentProjectsBar
            recentProjects={recentProjects}
            lastProjectId={lastProjectId}
            onResume={handleResume}
            onOpenFile={() => void handleOpenProject()}
            onViewAll={() => setRecentOpen(true)}
          />

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(330px,0.75fr)]">
            <div className="space-y-4">
              <section
                role="button"
                tabIndex={busy ? -1 : 0}
                aria-label="Drop a lecture video or browse"
                aria-disabled={busy}
                onClick={() => void handleBrowse()}
                onKeyDown={handleDropzoneKeyDown}
                onDragEnter={handleDragEnter}
                onDragOver={handleDragEnter}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                data-dragging={dragging ? "true" : undefined}
                className={cn(
                  "dropzone-glow group relative isolate flex min-h-[290px] cursor-pointer flex-col items-center justify-center overflow-hidden rounded-xl border border-dashed border-border bg-card/40 px-8 py-9 text-center outline-none transition-[border-color,background-color,box-shadow] duration-300",
                  "hover:border-ring/40 hover:bg-card/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30",
                  dragging && "border-ring/70 bg-accent/25",
                  busy && "pointer-events-none opacity-70",
                )}
              >
                <div
                  className={cn(
                    "flex size-14 items-center justify-center rounded-2xl border border-border bg-secondary/60 shadow-sm transition-transform duration-300",
                    dragging ? "scale-105" : "group-hover:-translate-y-0.5",
                  )}
                >
                  <FileVideo2 className="size-6 text-foreground/80" />
                </div>
                <h2 className="mt-4 text-base font-medium text-foreground">{dropTitle}</h2>
                <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                  {dropDescription}
                </p>

                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="gap-1.5"
                    disabled={busy}
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleBrowse();
                    }}
                  >
                    <FolderOpen className="size-3.5" />
                    Browse files
                  </Button>
                  <div className="flex gap-1">
                    {LECTURE_EXTENSIONS.map((extension) => (
                      <Badge
                        key={extension}
                        variant="outline"
                        className="px-1.5 text-[9px] uppercase tracking-wide"
                      >
                        {extension}
                      </Badge>
                    ))}
                  </div>
                </div>

                {displayName ? (
                  <div className="mt-5 flex w-full max-w-md items-center gap-2 rounded-md border border-border bg-background/50 px-3 py-2 text-left">
                    <FileVideo2 className="size-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-foreground">{displayName}</p>
                      <p className="truncate text-[10px] text-muted-foreground">
                        {project?.sourcePath ??
                          (browserFile
                            ? formatBytes(browserFile.size)
                            : project?.transcript
                              ? "Path unavailable"
                              : "No file path")}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={busy}
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleBrowse();
                      }}
                    >
                      Change
                    </Button>
                  </div>
                ) : null}

                {browserFile ? (
                  <p className="mt-3 flex max-w-md items-start gap-1.5 text-left text-[11px] leading-relaxed text-status-warning">
                    <Info className="mt-0.5 size-3.5 shrink-0" />
                    This browser preview cannot expose the file's absolute path. Launch the desktop
                    shell and drop the same file from Explorer to transcribe it.
                  </p>
                ) : null}
              </section>

              {project?.transcript ? (
                <section className="rounded-lg border border-border bg-card/40 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-1.5">
                        <CheckCircle2 className="size-3.5 text-muted-foreground" />
                        <h2 className="text-[13px] font-medium text-foreground">Transcript ready</h2>
                      </div>
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        {project.transcript.segments.length} segments ·{" "}
                        {formatClock(project.duration ?? 0)} ·{" "}
                        {project.transcript.language?.toUpperCase() ?? "AUTO"}
                      </p>
                    </div>
                    <Badge variant="outline" className="shrink-0">
                      Step 2 next
                    </Badge>
                  </div>
                  <Separator className="my-3" />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" className="gap-1.5" onClick={() => setStep(2)}>
                      Continue to clip discovery
                      <ChevronRight className="size-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void handleBrowse()}>
                      Replace lecture
                    </Button>
                  </div>
                </section>
              ) : busy ? (
                <section className="rounded-lg border border-border bg-card/40 p-4">
                  <div className="flex items-center gap-2">
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    <p className="text-[13px] font-medium text-foreground">
                      Extracting audio and transcribing…
                    </p>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    Whisper runs inside the sidecar. Long lectures can take a few minutes; the
                    editor stays responsive.
                  </p>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <span className="text-xs tabular-nums text-muted-foreground">
                      <NumberFlow
                        value={Math.floor(elapsed)}
                        suffix="s elapsed"
                        format={{ maximumFractionDigits: 0 }}
                      />
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => abortRef.current?.abort()}
                    >
                      Cancel
                    </Button>
                  </div>
                </section>
              ) : (
                <section className="rounded-lg border border-border bg-card/40 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-0.5">
                      <h2 className="text-[13px] font-medium text-foreground">
                        Transcribe the lecture
                      </h2>
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        FFmpeg extracts a 16 kHz WAV, then Whisper or your Cloud STT endpoint
                        transcribes the Thai–Arabic audio. The Thai–Arabic glossary is applied
                        after transcription.
                      </p>
                    </div>
                    <Badge variant="outline" className="shrink-0">
                      {transcriptionMode === "local" ? "Local" : "Cloud"}
                    </Badge>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                    <SidecarStatusDot status={sidecar.status} />
                    <span>
                      {sidecar.status === "online"
                        ? "Sidecar online"
                        : sidecar.status === "checking"
                          ? "Checking sidecar"
                          : sidecar.status === "offline"
                            ? "Sidecar offline"
                            : "Sidecar not checked"}
                    </span>
                    <span className="text-muted-foreground/50">·</span>
                    <span className="truncate">{transcriptionDetail}</span>
                  </div>

                  {sidecar.status === "offline" ? (
                    <div className="mt-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[11px] leading-relaxed text-destructive">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                      <span className="flex-1">
                        {sidecar.error ?? `Start backend.exe on ${SIDECAR_URL}.`}
                      </span>
                      <Button
                        variant="ghost"
                        size="xs"
                        className="h-5 text-destructive"
                        onClick={() => void refreshHealth()}
                      >
                        Retry
                      </Button>
                    </div>
                  ) : null}

                  <Button
                    size="lg"
                    className="mt-3 w-full gap-2"
                    disabled={!project?.sourcePath || busy || Boolean(browserFile)}
                    onClick={() => void handleTranscribe()}
                  >
                    <Captions className="size-4" />
                    Transcribe lecture & find clips
                  </Button>
                  {!project?.sourcePath ? (
                    <p className="mt-1.5 text-[10px] text-muted-foreground">
                      Choose a lecture file first.
                    </p>
                  ) : null}
                </section>
              )}

              {error ? (
                <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] leading-relaxed text-destructive">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <span>{error}</span>
                </div>
              ) : null}
            </div>

            <aside className="space-y-4">
              <section className="rounded-lg border border-border bg-card/40 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-0.5">
                    <h2 className="text-[13px] font-medium text-foreground">Prompt preset</h2>
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      Editorial policy for the clip discovery model.
                    </p>
                  </div>
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {promptBadge}
                  </Badge>
                </div>

                <Select value={presetValue} onValueChange={handlePresetChange}>
                  <SelectTrigger className="mt-3 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Editorial default (sidecar)</SelectItem>
                    {promptPresets.map((preset) => (
                      <SelectItem key={preset.id} value={preset.id}>
                        {preset.name}
                      </SelectItem>
                    ))}
                    {presetValue === "custom" ? (
                      <SelectItem value="custom">Custom prompt (edit…)</SelectItem>
                    ) : null}
                  </SelectContent>
                </Select>

                <p className="mt-2 line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">
                  {promptPreview}
                </p>

                <div className="mt-3 flex items-center justify-between gap-2">
                  <span className="text-[10px] text-muted-foreground">
                    {discovery.minDuration}–{discovery.maxDuration} s · up to {discovery.maxClips}{" "}
                    clips
                  </span>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="gap-1 text-muted-foreground"
                    onClick={handleOpenPrompt}
                  >
                    Edit base prompt
                  </Button>
                </div>
              </section>

              <section className="rounded-lg border border-border bg-card/40 p-4">
                <Label htmlFor="session-guide" className="text-[13px] font-medium text-foreground">
                  Session topic guide
                </Label>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                  Optional notes for this lecture only.
                </p>
                <Textarea
                  id="session-guide"
                  value={project?.sessionGuide ?? ""}
                  onChange={(event) => handleGuideChange(event.target.value)}
                  rows={4}
                  placeholder="Focus on stories of the Prophets and practical rulings; ignore the first 10 minutes of audio checks."
                  className="mt-2 resize-y text-xs leading-relaxed"
                />
              </section>

              <section className="rounded-lg border border-border bg-card/40 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-0.5">
                    <h2 className="text-[13px] font-medium text-foreground">Engines</h2>
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      Routing only; all inference runs in the sidecar.
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Open AI provider settings"
                    onClick={() => openSettings("providers")}
                  >
                    <Settings2 className="size-3.5" />
                  </Button>
                </div>

                <div className="mt-3 space-y-3">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <Label className="text-[11px] text-muted-foreground">Transcription</Label>
                      <span className="min-w-0 truncate text-[10px] text-muted-foreground/80">
                        {transcriptionDetail}
                      </span>
                    </div>
                    <SegmentedToggle<EngineMode>
                      label="Transcription engine"
                      value={transcriptionMode}
                      options={[
                        { value: "local", label: "Local Whisper" },
                        { value: "cloud", label: "Cloud API" },
                      ]}
                      onChange={setTranscriptionMode}
                      disabled={busy}
                    />
                    {transcriptionMode === "local" ? (
                      <div className="space-y-1.5">
                        <p className="text-[10px] leading-relaxed text-muted-foreground/80">
                          First local run downloads the faster-whisper model (~1.5 GB).
                        </p>
                        <GpuInlineHint summary={acceleration} />
                      </div>
                    ) : null}
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <Label className="text-[11px] text-muted-foreground">Topic analysis</Label>
                      <span className="min-w-0 truncate text-[10px] text-muted-foreground/80">
                        {analysisDetail}
                      </span>
                    </div>
                    <SegmentedToggle<EngineMode>
                      label="Topic analysis engine"
                      value={analysisMode}
                      options={[
                        { value: "local", label: "Local Ollama" },
                        { value: "cloud", label: "Cloud API" },
                      ]}
                      onChange={setAnalysisMode}
                      disabled={busy}
                    />
                  </div>
                </div>

                {analysisMode === "cloud" && analysisGap ? (
                  <p className="mt-3 flex items-start gap-1.5 text-[10px] leading-relaxed text-status-warning">
                    <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                    <span className="flex-1">{analysisGapMessage(analysisGap)}</span>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="h-5 shrink-0 text-status-warning"
                      onClick={() => openSettings("providers")}
                    >
                      Fix
                    </Button>
                  </p>
                ) : null}

                <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground/80">
                  API keys, models and the Whisper prompt live in Settings → AI Providers.
                </p>
              </section>
            </aside>
          </div>

          <p className="pb-2 text-center text-[10px] text-muted-foreground/60">
            Audio, transcripts and clips stay on this machine unless Cloud mode is selected.
          </p>
        </div>
      </div>

      <PromptDrawer open={promptOpen} onOpenChange={setPromptOpen} />

      <Dialog
        open={pendingReplace !== null}
        onOpenChange={(open) => {
          if (!open) setPendingReplace(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace the open project?</DialogTitle>
            <DialogDescription>
              {project?.name ?? "The current project"} already has a transcript or clips. Loading{" "}
              {pendingReplace?.name ?? "the new lecture"} starts a fresh project; the current
              auto-save stays in Recent lectures.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPendingReplace(null)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleReplaceConfirm}>
              Replace lecture
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

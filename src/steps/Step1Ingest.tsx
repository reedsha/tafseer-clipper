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
import { InlineError } from "@/components/InlineError";
import { RecentProjectsBar } from "@/components/RecentProjectsBar";
import { SegmentedToggle } from "@/components/SegmentedToggle";
import { SidecarStatusDot, SIDECAR_STATUS_LABEL } from "@/components/SidecarStatusDot";
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
import { extractAndTranscribe } from "@/lib/api";
import { describeAcceleration } from "@/lib/acceleration";
import { buildDiagnostics, copyText } from "@/lib/diagnostics";
import { formatBytes, formatClock, stripExtension } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { relaunchApp } from "@/lib/updater";
import {
  LECTURE_EXTENSIONS,
  fileFromDrop,
  hasLectureExtension,
  openLectureFile,
  subscribeNativeDrops,
} from "@/lib/media";
import { DEFAULT_DISCOVERY_SETTINGS, type ProjectData, type TranscriptData } from "@/lib/projectTypes";
import { openProjectFile } from "@/lib/projectFile";
import { describeProviderGap, whisperModelLabel } from "@/lib/providers";
import { useProjectStore } from "@/store/projectStore";
import { useSettingsStore, type EngineMode, type EngineUiMode } from "@/store/settingsStore";
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
  return `Clip finding needs an AI connection first (${gap}). Set it up and transcription starts right away.`;
}

export function Step1Ingest() {
  const project = useProjectStore((state) => state.project);
  const recentProjects = useProjectStore((state) => state.recentProjects);
  const lastProjectId = useProjectStore((state) => state.lastProjectId);
  const resumeRecent = useProjectStore((state) => state.resumeRecent);
  const setStep = useProjectStore((state) => state.setStep);

  const transcriptionMode = useSettingsStore((state) => state.transcriptionMode);
  const analysisMode = useSettingsStore((state) => state.analysisMode);
  const engineUiMode = useSettingsStore((state) => state.engineUiMode);
  const setEngineUiMode = useSettingsStore((state) => state.setEngineUiMode);
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
  const { t } = useI18n();
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
    "The built-in defaults will be used.";

  /** Vendor-neutral acceleration state derived from GET /health. */
  const acceleration = describeAcceleration(sidecar.health);

  const transcriptionDetail =
    transcriptionMode === "local"
      ? `On this computer${
          sidecar.health ? ` · ${acceleration.transcription === "gpu" ? "GPU" : "CPU"}` : ""
        } · ${whisperModelLabel(whisper.model)}`
      : cloudStt.baseUrl
        ? `Your AI account · ${cloudStt.model || "model not set"}`
        : "Your AI account — not set up";

  const analysisDetail =
    analysisMode === "cloud"
      ? cloud.reasoningModel && cloud.apiKey
        ? `Your AI account · ${cloud.reasoningModel}`
        : "Your AI account — not set up"
      : ollama.model
        ? `This computer · ${ollama.model}`
        : "This computer — no model chosen";

  /** Missing provider field that would block Step 2 discovery, if any. */
  const analysisGap =
    analysisMode === "cloud"
      ? describeProviderGap({ analysisMode, ollama, cloud }, "reasoning")
      : null;

  /** One-line, vendor-neutral description for Automatic mode. */
  const transcriptionSummary =
    transcriptionMode === "local"
      ? `Transcribing on this computer${
          sidecar.health ? ` (${acceleration.transcription === "gpu" ? "GPU" : "CPU"})` : ""
        }`
      : "Transcribing with your AI account";
  const analysisSummary =
    analysisMode === "local"
      ? ollama.model
        ? "clip finding on this computer"
        : "clip finding on this computer — no model chosen"
      : cloud.reasoningModel && cloud.apiKey
        ? "clip finding with your AI account"
        : "clip finding needs an AI connection";
  const automaticSummary = `${transcriptionSummary} · ${analysisSummary}`;

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
      const projectNow = useProjectStore.getState().project;
      if (projectNow?.sourcePath || projectNow?.transcript) {
        toast.error("Please open the Tafseer Clipper desktop app", {
          description: import.meta.env.DEV
            ? "The open lecture already has a file path. Drop the replacement from Explorer inside the desktop app."
            : "Lectures are transcribed in the desktop app.",
        });
        return;
      }
      setBrowserFile({ name: file.name, size: file.size });
      setError(null);
      toast("File selected", {
        description: import.meta.env.DEV
          ? "The browser preview cannot read files from disk. Launch the desktop app to transcribe it."
          : "Please open the Tafseer Clipper desktop app to transcribe this lecture.",
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
        description: "No saved copy of this lecture was found on disk or in local storage.",
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
        description: import.meta.env.DEV
          ? "The browser preview cannot read absolute paths. Drop the file from Explorer in the desktop app."
          : "Choose the lecture again from the desktop app.",
      });
      return;
    }

    const settings = useSettingsStore.getState();
    if (settings.transcriptionMode === "cloud" && !settings.cloudStt.baseUrl.trim()) {
      toast.error("Cloud transcription isn't set up", {
        description: "Set the service, model and API key in Settings → AI.",
      });
      useUiStore.getState().openSettings("providers");
      return;
    }

    // Pre-flight the Step 2 reasoning provider too: without a key/model the
    // discovery call can only fail after the whole lecture has been
    // transcribed, so catch it before Whisper starts.
    const analysisGap = describeProviderGap(settings, "reasoning");
    if (settings.analysisMode === "cloud" && analysisGap) {
      toast.error("Clip finding isn't set up yet", {
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
        description: `${formatClock(result.duration)} of speech transcribed`,
      });
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

  async function handleRestartApp() {
    try {
      await relaunchApp();
    } catch (caught) {
      toast.error("Could not restart", {
        description: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }

  async function handleCopyDiagnostics() {
    try {
      const state = useSettingsStore.getState();
      const bundle = await buildDiagnostics({
        health: state.sidecar.health,
        sidecarStatus: state.sidecar.status,
        sidecarError: state.sidecar.error,
        projectFolder: state.storage.projectFolder,
        lastAutosaveError: useProjectStore.getState().lastAutosaveError,
      });
      const copied = await copyText(bundle);
      if (copied) {
        toast.success("Diagnostics copied", {
          description: "Paste it into your support request. No API keys are included.",
        });
      } else {
        toast.error("Could not copy diagnostics", {
          description: "The clipboard is unavailable in this window.",
        });
      }
    } catch (caught) {
      toast.error("Could not build diagnostics", {
        description: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }

  const hasSource = Boolean(
    project?.sourcePath || project?.sourceFileName || project?.transcript,
  );
  const displayName = browserFile?.name ?? project?.sourceFileName ?? null;
  const dropTitle = dragging
    ? t("step1.drop.dragging")
    : hasSource
      ? project?.transcript
        ? t("step1.drop.transcriptReady")
        : t("step1.drop.selected")
      : t("step1.drop.default");
  const dropDescription = dragging
    ? t("step1.drop.hintDragging")
    : hasSource
      ? project?.transcript
        ? t("step1.drop.hintTranscript")
        : t("step1.drop.hintSelected")
      : t("step1.drop.hintDefault");

  return (
    <>
      <div className="h-full overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-8 py-7">
          <header className="flex flex-wrap items-end justify-between gap-3">
            <div className="space-y-1.5">
              <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                {t("step1.eyebrow")}
              </p>
              <h1 className="text-lg font-medium text-foreground">{t("step1.title")}</h1>
              <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
                {t("step1.subtitle")}
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
                    {t("step1.browse")}
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
                      {t("step1.change")}
                    </Button>
                  </div>
                ) : null}

                {browserFile ? (
                  <p className="mt-3 flex max-w-md items-start gap-1.5 text-left text-xs leading-relaxed text-status-warning">
                    <Info className="mt-0.5 size-3.5 shrink-0" />
                    {import.meta.env.DEV
                      ? "Dev preview: the browser cannot read this file from disk. Drop the same file from Explorer in the desktop app to transcribe it."
                      : "Open the Tafseer Clipper desktop app to transcribe this lecture."}
                  </p>
                ) : null}
              </section>

              {project?.transcript ? (
                <section className="rounded-lg border border-border bg-card/40 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-1.5">
                        <CheckCircle2 className="size-3.5 text-muted-foreground" />
                        <h2 className="text-[13px] font-medium text-foreground">
                          {t("step1.transcript.title")}
                        </h2>
                      </div>
                      <p className="text-xs leading-relaxed text-muted-foreground">
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
                      {t("step1.transcript.continue")}
                      <ChevronRight className="size-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void handleBrowse()}>
                      {t("step1.transcript.replace")}
                    </Button>
                  </div>
                </section>
              ) : busy ? (
                <section className="rounded-lg border border-border bg-card/40 p-4">
                  <div className="flex items-center gap-2">
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    <p className="text-[13px] font-medium text-foreground">
                      {t("step1.busy.title")}
                    </p>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {t("step1.busy.description")}
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
                        {t("step1.transcribe.title")}
                      </h2>
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {t("step1.transcribe.description")}
                      </p>
                    </div>
                    <Badge variant="outline" className="shrink-0">
                      {transcriptionMode === "local" ? "Local" : "Cloud"}
                    </Badge>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                    <SidecarStatusDot status={sidecar.status} />
                    <span>{SIDECAR_STATUS_LABEL[sidecar.status]}</span>
                    <span className="text-muted-foreground/50">·</span>
                    <span className="truncate">{transcriptionDetail}</span>
                  </div>

                  {sidecar.status === "offline" ? (
                    <InlineError
                      className="mt-2"
                      title={t("step1.offline.title")}
                      action={
                        <>
                          <Button
                            variant="ghost"
                            size="xs"
                            className="h-5 text-destructive"
                            onClick={() => void refreshHealth()}
                          >
                            {t("common.retry")}
                          </Button>
                          <Button
                            variant="ghost"
                            size="xs"
                            className="h-5 text-destructive"
                            onClick={() => void handleRestartApp()}
                          >
                            {t("common.restart")}
                          </Button>
                          <Button
                            variant="ghost"
                            size="xs"
                            className="h-5 text-destructive"
                            onClick={() => void handleCopyDiagnostics()}
                          >
                            {t("common.copyDiagnostics")}
                          </Button>
                        </>
                      }
                    >
                      {t("step1.offline.description")}
                    </InlineError>
                  ) : null}

                  <Button
                    size="lg"
                    className="mt-3 w-full gap-2"
                    disabled={!project?.sourcePath || busy || Boolean(browserFile)}
                    onClick={() => void handleTranscribe()}
                  >
                    <Captions className="size-4" />
                    {t("step1.transcribe.cta")}
                  </Button>
                  {!project?.sourcePath ? (
                    <p className="mt-1.5 text-[10px] text-muted-foreground">
                      {t("step1.transcribe.chooseFirst")}
                    </p>
                  ) : null}
                </section>
              )}

              {error ? (
                <InlineError title="Transcription failed">{error}</InlineError>
              ) : null}
            </div>

            <aside className="space-y-4">
              {hasSource ? (
                <>
                  <section className="rounded-lg border border-border bg-card/40 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="space-y-0.5">
                        <h2 className="text-[13px] font-medium text-foreground">Clip brief</h2>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          {t("step1.brief.description")}
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
                        <SelectItem value="default">Built-in default</SelectItem>
                        {promptPresets.map((preset) => (
                          <SelectItem key={preset.id} value={preset.id}>
                            {preset.name}
                          </SelectItem>
                        ))}
                        {presetValue === "custom" ? (
                          <SelectItem value="custom">Edit clip brief…</SelectItem>
                        ) : null}
                      </SelectContent>
                    </Select>

                    <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                      {promptPreview}
                    </p>

                    <div className="mt-3 flex items-center justify-between gap-2">
                      <span className="text-[11px] text-muted-foreground">
                        {discovery.minDuration}–{discovery.maxDuration} s · up to{" "}
                        {discovery.maxClips} clips
                      </span>
                      <Button
                        variant="ghost"
                        size="xs"
                        className="gap-1 text-muted-foreground"
                        onClick={handleOpenPrompt}
                      >
                        {t("step1.brief.edit")}
                      </Button>
                    </div>
                  </section>

                  <section className="rounded-lg border border-border bg-card/40 p-4">
                    <Label
                      htmlFor="session-guide"
                      className="text-[13px] font-medium text-foreground"
                    >
                      {t("step1.guide.title")}
                    </Label>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      {t("step1.guide.description")}
                    </p>
                    <Textarea
                      id="session-guide"
                      value={project?.sessionGuide ?? ""}
                      onChange={(event) => handleGuideChange(event.target.value)}
                      rows={4}
                      placeholder={t("step1.guide.placeholder")}
                      className="mt-2 resize-y text-xs leading-relaxed"
                    />
                  </section>
                </>
              ) : null}

              <section className="rounded-lg border border-border bg-card/40 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="space-y-0.5">
                    <h2 className="text-[13px] font-medium text-foreground">
                      {t("step1.ai.title")}
                    </h2>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {engineUiMode === "automatic"
                        ? t("step1.ai.automaticDescription")
                        : t("step1.ai.advancedDescription")}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <SegmentedToggle<EngineUiMode>
                      label="AI setup mode"
                      value={engineUiMode}
                      options={[
                        { value: "automatic", label: "Automatic" },
                        { value: "advanced", label: "Advanced" },
                      ]}
                      onChange={setEngineUiMode}
                      disabled={busy}
                    />
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Open AI settings"
                      onClick={() => openSettings("providers")}
                    >
                      <Settings2 className="size-3.5" />
                    </Button>
                  </div>
                </div>

                {engineUiMode === "automatic" ? (
                  <div className="mt-3 space-y-2">
                    <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                      <SidecarStatusDot status={sidecar.status} className="mt-1.5" />
                      <span className="flex-1">{automaticSummary}</span>
                    </p>

                    {transcriptionMode === "local" ? (
                      <div className="space-y-1.5">
                        <p className="text-xs leading-relaxed text-muted-foreground/80">
                          {t("step1.ai.downloadNote")}
                        </p>
                        <GpuInlineHint summary={acceleration} />
                      </div>
                    ) : null}

                    {analysisMode === "cloud" && analysisGap ? (
                      <p className="flex items-start gap-1.5 text-xs leading-relaxed text-status-warning">
                        <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                        <span className="flex-1">{analysisGapMessage(analysisGap)}</span>
                      </p>
                    ) : null}

                    <Button
                      variant="ghost"
                      size="xs"
                      className="gap-1 text-muted-foreground"
                      onClick={() => openSettings("providers")}
                    >
                      {t("step1.ai.change")}
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="mt-3 space-y-3">
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <Label className="text-[11px] text-muted-foreground">Transcription</Label>
                          <span className="min-w-0 truncate text-[11px] text-muted-foreground/80">
                            {transcriptionDetail}
                          </span>
                        </div>
                        <SegmentedToggle<EngineMode>
                          label="Transcription engine"
                          value={transcriptionMode}
                          options={[
                            { value: "local", label: "This computer" },
                            { value: "cloud", label: "Your AI account" },
                          ]}
                          onChange={setTranscriptionMode}
                          disabled={busy}
                        />
                        {transcriptionMode === "local" ? (
                          <div className="space-y-1.5">
                            <p className="text-xs leading-relaxed text-muted-foreground/80">
                              {t("step1.ai.downloadNote")}
                            </p>
                            <GpuInlineHint summary={acceleration} />
                          </div>
                        ) : null}
                      </div>

                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <Label className="text-[11px] text-muted-foreground">Topic analysis</Label>
                          <span className="min-w-0 truncate text-[11px] text-muted-foreground/80">
                            {analysisDetail}
                          </span>
                        </div>
                        <SegmentedToggle<EngineMode>
                          label="Topic analysis engine"
                          value={analysisMode}
                          options={[
                            { value: "local", label: "This computer" },
                            { value: "cloud", label: "Your AI account" },
                          ]}
                          onChange={setAnalysisMode}
                          disabled={busy}
                        />
                      </div>
                    </div>

                    {analysisMode === "cloud" && analysisGap ? (
                      <p className="mt-3 flex items-start gap-1.5 text-xs leading-relaxed text-status-warning">
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
                  </>
                )}

                <p className="mt-3 text-xs leading-relaxed text-muted-foreground/80">
                  Connections, models and the transcription prompt live in Settings → AI.
                </p>
              </section>
            </aside>
          </div>

          <p className="pb-2 text-center text-[10px] text-muted-foreground/60">
            {t("step1.privacy")}
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

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import NumberFlow from "@number-flow/react";
import { toast } from "sonner";
import {
  Captions,
  CheckCircle2,
  ChevronRight,
  FileVideo2,
  FolderOpen,
  Info,
  Loader2,
  Pencil,
} from "lucide-react";
import { cn } from "cn";

import { AiActivityLine } from "@/components/AiActivityLine";
import { GpuInlineHint } from "@/components/GpuAcceleration";
import { PromptDrawer } from "@/components/PromptDrawer";
import { InlineError } from "@/components/InlineError";
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
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { extractAndTranscribe } from "@/lib/api";
import { describeAcceleration } from "@/lib/acceleration";
import { aiRouteFor } from "@/lib/aiActivity";
import { buildDiagnostics, copyText } from "@/lib/diagnostics";
import { formatBytes, formatClock, stripExtension } from "@/lib/format";
import { L, useI18n } from "@/lib/i18n";
import { relaunchApp } from "@/lib/updater";
import {
  LECTURE_EXTENSIONS,
  fileFromDrop,
  hasLectureExtension,
  openLectureFile,
  subscribeNativeDrops,
} from "@/lib/media";
import { type TranscriptData } from "@/lib/projectTypes";
import {
  buildDecisionProviderFor,
  buildProviderFor,
  describeSttGap,
  resolveSttConnection,
} from "@/lib/providers";
import { useAiActivityStore } from "@/store/aiActivityStore";
import { useJobStore, useTaskJob } from "@/store/jobStore";
import { useProjectStore } from "@/store/projectStore";
import { useSettingsStore, type EngineMode } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";

/* -------------------------------------------------------------------------- */
/* Step 1                                                                      */
/* -------------------------------------------------------------------------- */

export function Step1Ingest() {
  const project = useProjectStore((state) => state.project);
  const setStep = useProjectStore((state) => state.setStep);

  const transcriptionMode = useSettingsStore((state) => state.transcriptionMode);
  const setTranscriptionMode = useSettingsStore((state) => state.setTranscriptionMode);
  const cloud = useSettingsStore((state) => state.cloud);
  const cloudStt = useSettingsStore((state) => state.cloudStt);
  const whisper = useSettingsStore((state) => state.whisper);
  const updateWhisper = useSettingsStore((state) => state.updateWhisper);
  const sidecar = useSettingsStore((state) => state.sidecar);
  const aiEntries = useAiActivityStore((state) => state.entries);
  const activeTranscription =
    aiEntries.find((entry) => entry.task === "transcription" && entry.status === "running") ??
    aiEntries.find((entry) => entry.task === "transcription");
  const refreshHealth = useSettingsStore((state) => state.refreshHealth);

  /** Where Cloud STT will actually upload: a dedicated speech service, or the
      shared AI connection when no separate one is configured. */
  const sttConnection = resolveSttConnection({ transcriptionMode, cloud, cloudStt });

  const [dragging, setDragging] = useState(false);
  const { t } = useI18n();
  const [browserFile, setBrowserFile] = useState<{ name: string; size: number } | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [pendingReplace, setPendingReplace] = useState<{ path: string; name: string } | null>(null);
  const [elapsed, setElapsed] = useState(0);

  // The job lives in `jobStore`, so switching steps (or sessions) never aborts
  // a transcription and the progress survives a remount.
  const transcribeJob = useTaskJob("transcribe", project?.id ?? null);
  const busy = transcribeJob?.status === "running";
  const error = transcribeJob?.status === "error" ? transcribeJob.error : null;

  const busyRef = useRef(false);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  // A project switch must not leave another session's staged browser file on
  // screen. The running job is untouched; its result is routed to the project
  // that started it by `jobStore`.
  useEffect(() => {
    const current = useProjectStore.getState().project;
    if (current?.sourcePath || current?.transcript) setBrowserFile(null);
  }, [project?.id]);

  useEffect(() => {
    if (!busy || !transcribeJob) {
      setElapsed(0);
      return;
    }
    const startedAt = transcribeJob.startedAt;
    const tick = () => setElapsed((Date.now() - startedAt) / 1000);
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [busy, transcribeJob?.startedAt]);

  /** Vendor-neutral acceleration state derived from GET /health. */
  const acceleration = describeAcceleration(sidecar.health);

  /** Copy label for whichever connection Cloud STT uploads to. */
  const sttServiceLabel = sttConnection.dedicated ? "Speech service" : "Your AI account";

  const transcriptionDetail =
    transcriptionMode === "local"
      ? `On this computer${
          sidecar.health ? ` · ${acceleration.transcription === "gpu" ? "GPU" : "CPU"}` : ""
        } · ${whisper.model.trim() ? whisper.model : "downloads on first transcription"}`
      : sttConnection.baseUrl && (sttConnection.apiKey || sttConnection.dedicated)
        ? `${sttServiceLabel} · ${cloudStt.model || "model not set"}`
        : `${sttServiceLabel} — not set up`;

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
    toast.success("Session ready", { description: sourceFileName });
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
    toast.success("New session ready", { description: pending.name });
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
    if (settings.transcriptionMode === "cloud") {
      const sttGap = describeSttGap(settings);
      if (sttGap) {
        // The model lives in the Upload configuration; the connection lives in
        // Settings. Send the user to whichever screen owns the missing piece.
        const missingModel = sttGap.includes("model");
        toast.error("Cloud transcription isn't set up", {
          description: missingModel
            ? "Choose a speech-to-text model in the Upload configuration."
            : `Add ${sttGap} in Settings, or switch the engine to “This computer”.`,
        });
        if (missingModel) {
          useUiStore.getState().openConfig(1);
        } else {
          useUiStore.getState().openSettings("connection");
        }
        return;
      }
    }

    const route = aiRouteFor(settings, "transcription");
    const glossary = Object.fromEntries(
      settings.glossary
        .filter((entry) => entry.enabled && entry.find.trim())
        .map((entry) => [entry.find, entry.replace]),
    );
    const projectId = current.id;
    const sourcePath = current.sourcePath;

    useJobStore.getState().startTask({
      kind: "transcribe",
      projectId,
      label: "Transcribing lecture",
      run: async (signal) => {
        const activityId = useAiActivityStore.getState().start({
          ...route,
          detail:
            route.backend === "local" && sidecar.health
              ? acceleration.transcription === "gpu"
                ? "GPU"
                : "CPU"
              : undefined,
        });
        try {
          const result = await extractAndTranscribe(
            {
              file_path: sourcePath,
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
                      base_url: sttConnection.baseUrl,
                      api_key: sttConnection.apiKey || null,
                      model: settings.cloudStt.model || "whisper-1",
                      language: settings.editor.language || null,
                    }
                  : null,
              analysis_provider: buildProviderFor(settings),
              decision_provider: buildDecisionProviderFor(settings, "analysis"),
              arabic_model: settings.cloudStt.arabicModel.trim() || null,
              detect_arabic: true,
              group_sentences: true,
            },
            { signal },
          );
          useAiActivityStore.getState().finish(activityId, "done", result.model || undefined);
          // `peaks` is the additive P2 field on TranscriptData (precomputed
          // waveform peaks from the sidecar). Written through an intersection so
          // this compiles whether or not the domain type has landed yet.
          const transcript: TranscriptData & { peaks?: number[] } = {
            language: result.language,
            languageProbability: result.language_probability,
            segments: result.segments,
          };
          if (result.waveform_peaks?.length) {
            transcript.peaks = result.waveform_peaks;
          }
          return {
            kind: "transcribe" as const,
            transcriptId: result.transcript_id,
            transcript,
            duration: result.duration,
            audioPath: result.audio_path,
          };
        } catch (caught) {
          useAiActivityStore
            .getState()
            .finish(activityId, signal.aborted ? "cancelled" : "failed");
          throw caught;
        }
      },
      onSuccess: (payload) => {
        if (payload?.kind !== "transcribe") return;
        toast.success("Transcript ready", {
          description: `${formatClock(payload.duration ?? 0)} of speech transcribed`,
        });
      },
      onError: (message) => {
        toast.error("Transcription failed", { description: message });
      },
      onCancel: () => toast("Transcription cancelled"),
    });
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
                  <div className="mt-2 space-y-1">
                    {activeTranscription ? <AiActivityLine entry={activeTranscription} /> : null}
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {transcriptionMode === "local"
                        ? "Extracting the audio, then transcribing it on this computer. The first run also downloads the AI model, so it can take several minutes; later runs are much faster."
                        : "Extracting the audio, then sending it to your speech service. Nothing else changes while this runs."}
                    </p>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <span className="text-xs tabular-nums text-muted-foreground">
                      <NumberFlow
                        value={elapsed >= 60 ? Math.floor(elapsed / 60) : Math.floor(elapsed)}
                        suffix={elapsed >= 60 ? " min elapsed" : "s elapsed"}
                        format={{ maximumFractionDigits: 0 }}
                      />
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (transcribeJob) useJobStore.getState().cancelJob(transcribeJob.id);
                      }}
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
                  </div>

                  {/* The engine belongs on this screen: a first-run editor with
                      no Cloud connection used to be told to "switch the engine"
                      without any control in sight. */}
                  <SegmentedToggle<EngineMode>
                    label={L("Speech-to-text engine")}
                    value={transcriptionMode}
                    options={[
                      {
                        value: "local",
                        label: L("This computer"),
                        hint: L(
                          "Transcribes on this machine. The first run downloads the AI files.",
                        ),
                      },
                      {
                        value: "cloud",
                        label: L("AI service (cloud)"),
                        hint: L("Sends the lecture audio to your speech service."),
                      },
                    ]}
                    onChange={(mode) => setTranscriptionMode(mode)}
                    disabled={busy}
                    className="mt-3"
                  />

                  <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                    <SidecarStatusDot status={sidecar.status} />
                    <span>{SIDECAR_STATUS_LABEL[sidecar.status]}</span>
                    <span className="text-muted-foreground/50">·</span>
                    <span className="truncate">{transcriptionDetail}</span>
                  </div>

                  {transcriptionMode === "local" ? (
                    <div className="mt-2 space-y-1.5">
                      <p className="text-xs leading-relaxed text-muted-foreground/80">
                        {t("step1.transcribe.downloadNote")}
                      </p>
                      <GpuInlineHint summary={acceleration} />
                    </div>
                  ) : null}

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
              <section className="rounded-lg border border-border bg-card/40 p-4">
                <div className="space-y-0.5">
                  <Label
                    htmlFor="transcription-vocabulary"
                    className="text-[13px] font-medium text-foreground"
                  >
                    Transcription vocabulary hint
                  </Label>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Words the recognizer should expect when a Thai lecture switches to Arabic —
                    for example อัลลอฮฺ, อัลกุรอาน, ซูเราะฮฺ. This is a hint, not a command: it nudges
                    spelling without changing what was said. It applies to both transcription
                    engines when the service accepts a prompt.
                  </p>
                </div>
                <Textarea
                  id="transcription-vocabulary"
                  value={whisper.initialPrompt}
                  onChange={(event) => updateWhisper({ initialPrompt: event.target.value })}
                  rows={5}
                  spellCheck={false}
                  className="mt-2 resize-y font-mono text-xs leading-relaxed"
                />
              </section>

              <section className="rounded-lg border border-border bg-card/40 p-4">
                <div className="space-y-0.5">
                  <h2 className="text-[13px] font-medium text-foreground">
                    {t("step1.brief.title")}
                  </h2>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t("step1.brief.description")}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2 w-full justify-start gap-1.5"
                  onClick={() => setPromptOpen(true)}
                >
                  <Pencil className="size-3.5" />
                  {L("Clip brief & system prompt")}
                </Button>
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
              auto-save stays in Sessions.
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

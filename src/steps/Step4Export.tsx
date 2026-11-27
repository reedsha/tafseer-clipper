import { L } from "@/lib/i18n";
import { useEffect, useMemo, useState } from "react";
import NumberFlow from "@number-flow/react";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Cpu,
  Crop,
  FileVideo2,
  Film,
  FolderOpen,
  Gauge,
  HardDrive,
  MonitorPlay,
  Play,
  RotateCw,
  Square,
  Subtitles,
  Type,
  XCircle,
} from "lucide-react";

import { encodingAvailabilityText } from "@/components/GpuAcceleration";
import { InlineError } from "@/components/InlineError";
import { TimeFlow } from "@/components/TimeFlow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  TEMPLATE_TOKEN_HINTS,
  defaultOutputDirectory,
  fileStem,
  resolveClipFileName,
} from "@/lib/filenameTemplate";
import {
  canRecheckEncoding,
  describeAcceleration,
  encodingUnavailableText,
  isGpuEncodingAvailable,
} from "@/lib/acceleration";
import {
  isTauriRuntime,
  openDirectory,
  openPathInShell,
  probeMediaSrc,
  toMediaSrc,
} from "@/lib/media";
import {
  FRAMING_LABELS,
  isSubtitleOnlyProject,
  type FramingMode,
  type ProjectClip,
  type Resolution,
} from "@/lib/projectTypes";
import { resolveAssStyles, stylesOverlap } from "@/lib/subtitleStyles";
import { useProjectStore } from "@/store/projectStore";
import { IDLE_RENDER_JOB, useRenderStore, type ClipStatus } from "@/store/renderStore";
import { useSettingsStore } from "@/store/settingsStore";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function statusVariant(status: ClipStatus): "secondary" | "outline" | "default" | "destructive" {
  if (status === "done") return "default";
  if (status === "error") return "destructive";
  if (status === "rendering") return "secondary";
  return "outline";
}

function statusLabel(status: ClipStatus): string {
  if (status === "done") return L("Rendered");
  if (status === "error") return L("Failed");
  if (status === "rendering") return L("Rendering");
  if (status === "cancelled") return L("Cancelled");
  return L("Queued");
}

/* -------------------------------------------------------------------------- */
/* Step 4                                                                      */
/* -------------------------------------------------------------------------- */

export function Step4Export() {
  const project = useProjectStore((state) => state.project);
  const updateExportSettings = useProjectStore((state) => state.updateExportSettings);
  const setStep = useProjectStore((state) => state.setStep);
  const subtitleOnly = isSubtitleOnlyProject(project);

  const sidecar = useSettingsStore((state) => state.sidecar);
  const refreshHealth = useSettingsStore((state) => state.refreshHealth);
  const arabicSettings = useSettingsStore((state) => state.arabic);
  const thaiSettings = useSettingsStore((state) => state.thai);

  /** Vendor-neutral acceleration state; hardware names stay in diagnostics. */
  const acceleration = describeAcceleration(sidecar.health);
  const encodingAvailable = isGpuEncodingAvailable(acceleration);
  const [recheckingEncoding, setRecheckingEncoding] = useState(false);

  /** Re-probe the encoder (`/health?refresh=1`), e.g. after a driver update. */
  async function recheckEncoding() {
    if (recheckingEncoding) return;
    setRecheckingEncoding(true);
    try {
      await refreshHealth({ force: true });
    } finally {
      setRecheckingEncoding(false);
    }
  }

  // The batch lives in the render store so navigating between wizard steps
  // never aborts it; this component only renders the job for its own project.
  const storedJob = useRenderStore((state) => state.job);
  const startRender = useRenderStore((state) => state.startRender);
  const cancelRender = useRenderStore((state) => state.cancelRender);
  const job =
    storedJob.projectId === null || storedJob.projectId === project?.id
      ? storedJob
      : IDLE_RENDER_JOB;

  const exportSettings = project?.export ?? null;
  const approvedClips = useMemo(
    () => (project?.clips ?? []).filter((clip) => clip.approved),
    [project?.clips],
  );

  const resolution: Resolution = exportSettings?.resolution ?? "1080x1920";
  const framing: FramingMode = exportSettings?.framing ?? "blur-fill";
  const useNvenc = exportSettings?.useNvenc ?? true;
  const exportSrt = exportSettings?.exportSrt ?? true;
  const template = exportSettings?.filenameTemplate ?? "{LectureName}_Clip{01}_{Title}.mp4";
  const outputDir = exportSettings?.outputDir ?? null;

  /* ------------------------------ styles ------------------------------ */
  const styles = useMemo(
    () =>
      resolveAssStyles(
        resolution,
        {
          font: arabicSettings.fontFamily,
          size: arabicSettings.fontSize,
          primaryColor: arabicSettings.color,
          outline: arabicSettings.outlineWidth,
          bold: arabicSettings.bold,
          lineHeightPad: arabicSettings.lineHeightPad,
          verticalOffset: arabicSettings.verticalOffset,
        },
        {
          font: thaiSettings.fontFamily,
          size: thaiSettings.fontSize,
          primaryColor: thaiSettings.color,
          outline: thaiSettings.outlineWidth,
          bold: thaiSettings.bold,
          lineHeightPad: 1.2,
          verticalOffset: thaiSettings.verticalOffset,
        },
      ),
    [resolution, arabicSettings, thaiSettings],
  );

  const overlap = useMemo(() => stylesOverlap(styles.arabic, styles.thai), [styles]);

  /* --------------------------- file names ----------------------------- */
  const sourcePath = project?.sourcePath ?? null;
  const lectureName = sourcePath ? fileStem(sourcePath) : (project?.name ?? "lecture");

  const plannedNames = useMemo(() => {
    const used = new Set<string>();
    return approvedClips.map((clip, index) =>
      resolveClipFileName(
        template,
        {
          lectureName,
          title: clip.title,
          index,
          resolution,
        },
        used,
      ),
    );
  }, [approvedClips, template, lectureName, resolution]);

  const resolvedOutputDir = outputDir?.trim() || defaultOutputDirectory(sourcePath);
  /** Sidecar-truth folder from the SSE `start`/`done` frames, when known. */
  const sidecarOutputDir = job.outputDir?.trim() ? job.outputDir : null;

  const copyOutputPath = async () => {
    const path = sidecarOutputDir ?? resolvedOutputDir;
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      toast.success("Output path copied");
    } catch {
      toast.error("Could not copy the path");
    }
  };

  const chooseOutputFolder = async () => {
    const folder = await openDirectory("Choose the output folder");
    if (folder) updateExportSettings({ outputDir: folder });
  };

  const openOutputFolder = async () => {
    const path = sidecarOutputDir ?? resolvedOutputDir;
    if (!path) return;
    const opened = await openPathInShell(path);
    if (!opened) await copyOutputPath();
  };

  /* ------------------------------ totals ------------------------------ */
  const totalDuration = useMemo(
    () => approvedClips.reduce((total, clip) => total + (clip.end - clip.start), 0),
    [approvedClips],
  );

  const clipsWithoutSubtitles = useMemo(
    () =>
      approvedClips.filter(
        (clip) => (project?.subtitles[clip.id] ?? []).filter((cue) => cue.arabic || cue.thai).length === 0,
      ).length,
    [approvedClips, project?.subtitles],
  );

  const [missingInserts, setMissingInserts] = useState<string[]>([]);
  useEffect(() => {
    if (!isTauriRuntime() || !project?.inserts) {
      setMissingInserts([]);
      return;
    }
    const paths = new Set<string>();
    for (const clip of approvedClips) {
      for (const ins of project.inserts[clip.id] ?? []) {
        if (ins.path && !/^(https?:|data:|blob:)/i.test(ins.path)) {
          paths.add(ins.path);
        }
      }
    }
    if (paths.size === 0) {
      setMissingInserts([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const missing: string[] = [];
      for (const path of paths) {
        const src = toMediaSrc(path);
        if (!src) continue;
        const probe = await probeMediaSrc(src);
        if (!probe.ok && probe.status !== null) {
          missing.push(path.split(/[\\/]/).pop() || path);
        }
      }
      if (!cancelled) setMissingInserts(missing);
    })();
    return () => {
      cancelled = true;
    };
  }, [approvedClips, project?.inserts]);

  /* ------------------------------ guards ------------------------------ */
  if (!project) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
        <HardDrive className="size-5 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">No project open</p>
        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
          Create or resume a lecture on Step 1 before exporting.
        </p>
        <Button className="mt-1" onClick={() => setStep(1)}>
          Go to Step 1
        </Button>
      </div>
    );
  }

  if (approvedClips.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
        <FileVideo2 className="size-5 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">{L("Nothing to export yet")}</p>
        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
          {subtitleOnly
            ? L("Upload and transcribe your clip on Step 1 before exporting.")
            : "Approve the clips you want in Step 2. Approved clips become the batch render queue."}
        </p>
        <Button className="mt-1" onClick={() => setStep(subtitleOnly ? 1 : 2)}>
          {subtitleOnly ? L("Back to upload") : "Back to clip discovery"}
        </Button>
      </div>
    );
  }

  const running = job.status === "running";
  const resolutionLabel = resolution === "1080x1920" ? L("9:16 Vertical") : L("16:9 Widescreen");
  const framingLabel = FRAMING_LABELS[framing];
  // Framing only changes the 9:16 canvas; a 16:9 export never letterboxes.
  const framingApplies = resolution === "1080x1920";
  /**
   * Vendor-neutral encoder label (AGENTS.md §3: hardware/encoder names stay in
   * diagnostics; the raw string remains in `renderStore` state for them).
   */
  const encoderLabel = (encoder: string | null): string | null => {
    if (!encoder) return null;
    return encoder.includes("nvenc") ? "GPU encoding" : "CPU encoding";
  };
  const jobEncoderLabel = encoderLabel(job.encoder);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex shrink-0 flex-wrap items-end justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 space-y-0.5">
          <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            {L("Step 4 of 4 · Batch render")}
          </p>
          <div className="flex min-w-0 items-baseline gap-2">
            <h1 className="text-base font-medium text-foreground">{L("Export")}</h1>
            <span className="truncate text-[11px] text-muted-foreground">{project.name}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <FileVideo2 className="size-3.5" />
            {approvedClips.length} clip{approvedClips.length === 1 ? "" : "s"}
          </span>
          <span className="flex items-center gap-1">
            <Gauge className="size-3.5" />
            <TimeFlow value={totalDuration} />
          </span>
          <span className="flex items-center gap-1">
            <MonitorPlay className="size-3.5" />
            {resolutionLabel}
          </span>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(340px,420px)]">
        {/* ------------------------------ queue ------------------------------ */}
        <section className="flex min-h-0 flex-col border-r border-border">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <div className="flex items-center gap-2">
              <h2 className="text-[13px] font-medium text-foreground">{L("Export queue")}</h2>
              <Badge variant="outline" className="text-[10px] tabular-nums">
                {approvedClips.length}
              </Badge>
            </div>
            {jobEncoderLabel ? (
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Cpu className="size-3.5" />
                {jobEncoderLabel}
              </span>
            ) : null}
          </div>

          {/* overall progress */}
          <div className="shrink-0 border-b border-border px-4 py-3">
            <div className="flex items-end justify-between gap-3">
              <div className="flex shrink-0 items-baseline gap-0.5 whitespace-nowrap">
                <NumberFlow
                  value={Math.round(job.overall * 100)}
                  format={{ maximumFractionDigits: 0 }}
                  className="shrink-0 text-2xl font-medium whitespace-nowrap tabular-nums text-foreground"
                />
                <span className="text-xl text-muted-foreground">%</span>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-[11px] tabular-nums text-muted-foreground">
                <span>
                  <NumberFlow
                    value={job.rendered}
                    format={{ maximumFractionDigits: 0 }}
                  />{" "}
                  rendered
                </span>
                {job.failed > 0 ? (
                  <span className="text-destructive">
                    <NumberFlow value={job.failed} format={{ maximumFractionDigits: 0 }} /> failed
                  </span>
                ) : null}
                <span>
                  <NumberFlow value={job.elapsed} suffix="s" format={{ maximumFractionDigits: 1 }} />
                </span>
              </div>
            </div>
            <Progress
              value={Math.round(job.overall * 100)}
              className="mt-2 h-1.5"
              aria-label="Batch render progress"
            />
            {job.message ? (
              <p className="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-status-warning">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                {job.message}
              </p>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            <ul className="space-y-2">
              {approvedClips.map((clip: ProjectClip, index) => {
                const state = job.clips.find((item) => item.index === index);
                const status: ClipStatus = state?.status ?? "queued";
                const name = state?.outputPath
                  ? state.outputPath.split(/[\\/]/).pop() ?? state.outputPath
                  : (plannedNames[index] ?? "");
                const cues = (project.subtitles[clip.id] ?? []).filter(
                  (cue) => cue.arabic || cue.thai,
                ).length;
                const insertCount = (project.inserts?.[clip.id] ?? []).length;
                return (
                  <li
                    key={clip.id}
                    className="rounded-lg border border-border bg-card/40 px-3 py-2.5"
                  >
                    <div className="flex items-start gap-2.5">
                      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-secondary/60 text-[10px] tabular-nums text-muted-foreground">
                        {index + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                            {clip.title}
                          </p>
                          <Badge variant={statusVariant(status)} className="shrink-0 text-[10px]">
                            {statusLabel(status)}
                          </Badge>
                        </div>

                        <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                          {name}
                        </p>

                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] tabular-nums text-muted-foreground">
                          <span>
                            <TimeFlow value={clip.start} /> → <TimeFlow value={clip.end} />
                          </span>
                          <span className="flex items-center gap-1">
                            <Type className="size-3" />
                            {cues} line{cues === 1 ? "" : "s"}
                          </span>
                          {insertCount > 0 ? (
                            <span className="flex items-center gap-1">
                              <Film className="size-3" />
                              {insertCount} insert{insertCount === 1 ? "" : "s"}
                            </span>
                          ) : null}
                          <span className="flex items-center gap-1">
                            <MonitorPlay className="size-3" />
                            {resolutionLabel}
                          </span>
                          <span className="flex items-center gap-1">
                            <Crop className="size-3" />
                            {framingApplies ? framingLabel : "—"}
                          </span>
                          {state?.srtPath ? (
                            <span className="flex items-center gap-1">
                              <Subtitles className="size-3" />
                              .SRT
                            </span>
                          ) : null}
                          {state?.encoder ? <span>{encoderLabel(state.encoder)}</span> : null}
                        </div>

                        {status === "rendering" ? (
                          <div className="mt-2 flex items-center gap-2">
                            <Progress
                              value={Math.round((state?.progress ?? 0) * 100)}
                              className="h-1 flex-1"
                              aria-label={`Clip ${index + 1} progress`}
                            />
                            <span className="w-11 shrink-0 text-right text-[10px] whitespace-nowrap tabular-nums text-muted-foreground">
                              <NumberFlow
                                value={Math.round((state?.progress ?? 0) * 100)}
                                format={{ maximumFractionDigits: 0 }}
                                className="shrink-0 whitespace-nowrap"
                              />
                              <span className="text-muted-foreground/70">%</span>
                            </span>
                          </div>
                        ) : null}

                        {status === "done" && state?.outputPath ? (
                          <p className="mt-1.5 break-all font-mono text-[10px] text-muted-foreground/80">
                            {state.outputPath}
                          </p>
                        ) : null}

                        {status === "error" && state?.detail ? (
                          <p className="mt-1.5 text-[10px] leading-relaxed text-destructive">
                            {state.detail}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>

        {/* ----------------------------- settings ----------------------------- */}
        <section className="flex min-h-0 flex-col overflow-y-auto">
          <div className="space-y-4 px-4 py-4">
            {/* Aspect ratio and framing live above the preview on Step 3,
                where the change is visible; this step only reports them. */}
            <p className="text-xs leading-relaxed text-muted-foreground">
              Aspect ratio and framing are set above the preview on the Subtitles step.
            </p>

            <Separator />

            <div className="space-y-2">
              <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-card/40 px-3 py-2.5">
                <div className="space-y-0.5">
                  <p className="text-xs font-medium text-foreground">{L("Also export .SRT")}</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Also saves a separate .SRT file next to each video.
                  </p>
                </div>
                <Checkbox
                  checked={exportSrt}
                  onCheckedChange={(checked) => updateExportSettings({ exportSrt: checked === true })}
                  aria-label={L("Also export .SRT file")}
                />
              </div>

              <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-card/40 px-3 py-2.5">
                <div className="space-y-0.5">
                  <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                    <Cpu className="size-3.5" />
                    {L("Hardware encoding when available")}
                  </p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {encodingAvailable
                      ? `${encodingAvailabilityText(acceleration)} — if it isn't available, we render on the CPU instead.`
                      : L(encodingUnavailableText(acceleration))}
                  </p>
                  {!encodingAvailable && canRecheckEncoding(acceleration) && sidecar.status !== "offline" ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="-ml-1.5 h-5 gap-1 text-muted-foreground hover:text-foreground"
                      onClick={() => void recheckEncoding()}
                      disabled={recheckingEncoding}
                    >
                      <RotateCw className={recheckingEncoding ? "size-3 animate-spin" : "size-3"} />
                      {L("Check again")}
                    </Button>
                  ) : null}
                </div>
                <Switch
                  checked={useNvenc && encodingAvailable}
                  onCheckedChange={(checked) => updateExportSettings({ useNvenc: checked })}
                  disabled={!encodingAvailable}
                  aria-label="Use hardware encoding when available"
                />
              </div>
            </div>

            <Separator />

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="filename-template" className="text-[13px] font-medium text-foreground">
                  {L("Filename template")}
                </Label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-[10px] text-muted-foreground">{L("Windows-safe")}</span>
                  </TooltipTrigger>
                  <TooltipContent side="left" className="max-w-56 text-xs">
                    Invalid characters are replaced with underscores automatically.
                  </TooltipContent>
                </Tooltip>
              </div>
              <Input
                id="filename-template"
                value={template}
                onChange={(event) => updateExportSettings({ filenameTemplate: event.target.value })}
                spellCheck={false}
                className="font-mono text-xs"
              />
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {TEMPLATE_TOKEN_HINTS.map((hint) => (
                  <Button
                    key={hint.token}
                    variant="outline"
                    size="xs"
                    onClick={() =>
                      updateExportSettings({ filenameTemplate: `${template}${hint.token}` })
                    }
                    title={hint.description}
                    className="font-mono text-[10px]"
                  >
                    {hint.token}
                  </Button>
                ))}
              </div>

              <div className="mt-2 space-y-1 rounded-md border border-border bg-background/40 px-2.5 py-2">
                <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  {L("Resulting names")}
                </p>
                {plannedNames.slice(0, 4).map((name, index) => (
                  <p
                    key={`${name}-${index}`}
                    className="truncate font-mono text-[10px] text-foreground/80"
                    title={name}
                  >
                    {name}
                  </p>
                ))}
                {plannedNames.length > 4 ? (
                  <p className="text-[10px] text-muted-foreground">
                    +{plannedNames.length - 4} more
                  </p>
                ) : null}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="output-dir" className="text-[13px] font-medium text-foreground">
                {L("Output folder")}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="output-dir"
                  value={outputDir ?? ""}
                  onChange={(event) =>
                    updateExportSettings({ outputDir: event.target.value || null })
                  }
                  placeholder={resolvedOutputDir || L("Choose a folder")}
                  spellCheck={false}
                  className="font-mono text-xs"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => void chooseOutputFolder()}
                >
                  {L("Browse…")}
                </Button>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {outputDir?.trim()
                  ? "Files are written to this folder."
                  : subtitleOnly
                    ? L("Empty — files go to the exports folder next to the clip.")
                    : "Empty — files go to the exports folder next to the lecture."}
              </p>
            </div>

            <Separator />

            <Collapsible className="rounded-md border border-border bg-card/40">
              <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left">
                <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <Type className="size-3.5" />
                  {L("Burned-in subtitle styles")}
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
                    The two lines overlap by {Math.abs(Math.round(overlap.gap))} px at this font
                    size. Reduce the font size or the Harakat padding in Settings → 3 · Subtitles.
                  </p>
                ) : null}
              </CollapsibleContent>
            </Collapsible>

            {clipsWithoutSubtitles > 0 ? (
              <div className="flex items-start gap-2 rounded-md border border-status-warning/30 bg-status-warning/10 px-2.5 py-2 text-xs leading-relaxed text-status-warning">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {clipsWithoutSubtitles} approved clip
                  {clipsWithoutSubtitles === 1 ? " has" : "s have"} no subtitles. They will render
                  without burned-in text.
                </span>
              </div>
            ) : null}

            {missingInserts.length > 0 ? (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs leading-relaxed text-destructive">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  Missing insert file{missingInserts.length === 1 ? "" : "s"}:{" "}
                  {missingInserts.slice(0, 3).join(", ")}
                  {missingInserts.length > 3 ? ` (+${missingInserts.length - 3} more)` : ""}.
                  Replace or remove them in Step 3 before rendering.
                </span>
              </div>
            ) : null}

            {sidecar.status === "offline" ? (
              <InlineError
                title="The processing engine isn't responding."
                action={
                  <Button
                    variant="ghost"
                    size="xs"
                    className="h-5 text-destructive"
                    onClick={() => void refreshHealth()}
                  >
                    Retry
                  </Button>
                }
              >
                Rendering needs the engine. Retry, or restart the app if this keeps happening.
              </InlineError>
            ) : null}
          </div>

          <div className="sticky bottom-0 mt-auto space-y-2 border-t border-border bg-background/95 px-4 py-3 backdrop-blur">
            {running ? (
              <Button variant="outline" className="w-full gap-2" onClick={cancelRender}>
                <Square className="size-3.5" />
                {L("Cancel render")}
              </Button>
            ) : (
              <Button className="w-full gap-2" onClick={startRender}>
                <Play className="size-4" />
                Render {approvedClips.length} clip{approvedClips.length === 1 ? "" : "s"}
              </Button>
            )}
            <p className="text-center text-[10px] text-muted-foreground">
              {running
                ? L("Rendering your clips…")
                : `Burned-in subtitles, ${exportSrt ? ".SRT file, " : ""}${
                    useNvenc && encodingAvailable ? "GPU rendering" : "CPU rendering"
                  }.`}
            </p>
          </div>
        </section>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border bg-card/20 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
          {job.status === "done" ? (
            <>
              <CheckCircle2 className="size-3.5 shrink-0" />
              <NumberFlow value={job.rendered} format={{ maximumFractionDigits: 0 }} /> clip
              {job.rendered === 1 ? "" : "s"} rendered
              {sidecarOutputDir || resolvedOutputDir ? (
                <>
                  <span className="text-muted-foreground/50">·</span>
                  <span className="max-w-xs truncate" title={sidecarOutputDir ?? resolvedOutputDir ?? undefined}>
                    {sidecarOutputDir ?? resolvedOutputDir}
                  </span>
                </>
              ) : null}
              <Button
                variant="ghost"
                size="xs"
                disabled={!sidecarOutputDir && !resolvedOutputDir}
                onClick={() => void openOutputFolder()}
              >
                {L("Open folder")}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                disabled={!sidecarOutputDir && !resolvedOutputDir}
                onClick={() => void copyOutputPath()}
              >
                {L("Copy path")}
              </Button>
            </>
          ) : job.status === "error" ? (
            <>
              <XCircle className="size-3.5 shrink-0" />
              <NumberFlow value={job.failed} format={{ maximumFractionDigits: 0 }} /> clip
              {job.failed === 1 ? "" : "s"} failed
            </>
          ) : (
            <>
              <FolderOpen className="size-3.5 shrink-0" />
              {/* The sidecar's `output_dir` (SSE `start`/`done`) is the truth;
                  the local default is only a preview. */}
              <span className="min-w-0 flex-1 truncate">
                {sidecarOutputDir
                  ? `Saving to: ${sidecarOutputDir}`
                  : resolvedOutputDir
                    ? `Saving to: ${resolvedOutputDir}`
                    : "The output folder is chosen when rendering starts."}
              </span>
              <Button
                variant="ghost"
                size="xs"
                disabled={!sidecarOutputDir && !resolvedOutputDir}
                onClick={() => void openOutputFolder()}
              >
                {L("Open folder")}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                disabled={!sidecarOutputDir && !resolvedOutputDir}
                onClick={() => void copyOutputPath()}
              >
                {L("Copy path")}
              </Button>
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => setStep(3)}>
            {L("Back to subtitles")}
          </Button>
          {job.status === "done" ? (
            <Button variant="secondary" size="sm" className="gap-1.5" onClick={startRender}>
              <RotateCw className="size-3.5" />
              {L("Render again")}
            </Button>
          ) : null}
        </div>
      </footer>
    </div>
  );
}

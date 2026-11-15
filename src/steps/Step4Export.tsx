import { useMemo } from "react";
import NumberFlow from "@number-flow/react";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Crop,
  FileVideo2,
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
import { SegmentedToggle } from "@/components/SegmentedToggle";
import { TimeFlow } from "@/components/TimeFlow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { describeAcceleration, isGpuEncodingAvailable } from "@/lib/acceleration";
import type { FramingMode, ProjectClip, Resolution } from "@/lib/projectTypes";
import { FRAMING_LABELS } from "@/lib/projectTypes";
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
  if (status === "done") return "Rendered";
  if (status === "error") return "Failed";
  if (status === "rendering") return "Rendering";
  if (status === "cancelled") return "Cancelled";
  return "Queued";
}

/* -------------------------------------------------------------------------- */
/* Step 4                                                                      */
/* -------------------------------------------------------------------------- */

export function Step4Export() {
  const project = useProjectStore((state) => state.project);
  const updateExportSettings = useProjectStore((state) => state.updateExportSettings);
  const setStep = useProjectStore((state) => state.setStep);

  const sidecar = useSettingsStore((state) => state.sidecar);
  const refreshHealth = useSettingsStore((state) => state.refreshHealth);
  const arabicSettings = useSettingsStore((state) => state.arabic);
  const thaiSettings = useSettingsStore((state) => state.thai);

  /** Vendor-neutral acceleration state; hardware names stay in diagnostics. */
  const acceleration = describeAcceleration(sidecar.health);
  const encodingAvailable = isGpuEncodingAvailable(acceleration);

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
        },
        {
          font: thaiSettings.fontFamily,
          size: thaiSettings.fontSize,
          primaryColor: thaiSettings.color,
          outline: thaiSettings.outlineWidth,
          bold: thaiSettings.bold,
          lineHeightPad: 1.2,
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
        <p className="text-sm font-medium text-foreground">Nothing to export yet</p>
        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
          Approve the clips you want in Step 2. Approved clips become the batch render queue.
        </p>
        <Button className="mt-1" onClick={() => setStep(2)}>
          Back to clip discovery
        </Button>
      </div>
    );
  }

  const running = job.status === "running";
  const resolutionLabel = resolution === "1080x1920" ? "9:16 Vertical" : "16:9 Widescreen";
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
            Step 4 of 4 · Batch render
          </p>
          <div className="flex min-w-0 items-baseline gap-2">
            <h1 className="text-base font-medium text-foreground">Export</h1>
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
              <h2 className="text-[13px] font-medium text-foreground">Export queue</h2>
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
              <p className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-status-warning">
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
            <div className="space-y-1.5">
              <Label className="text-[13px] font-medium text-foreground">Aspect ratio</Label>
              <SegmentedToggle<Resolution>
                label="Aspect ratio"
                value={resolution}
                options={[
                  { value: "1080x1920", label: "9:16 Vertical", hint: "1080x1920" },
                  { value: "1920x1080", label: "16:9 Widescreen", hint: "1920x1080" },
                ]}
                onChange={(value) => updateExportSettings({ resolution: value })}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-[13px] font-medium text-foreground">Framing mode</Label>
              <SegmentedToggle<FramingMode>
                label="Framing mode"
                value={framing}
                disabled={!framingApplies}
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
              {!framingApplies ? (
                <p className="text-[10px] leading-relaxed text-muted-foreground">
                  16:9 output uses the whole frame, so 9:16 framing does not apply.
                </p>
              ) : null}
            </div>

            <Separator />

            <div className="space-y-2">
              <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-card/40 px-3 py-2.5">
                <div className="space-y-0.5">
                  <p className="text-xs font-medium text-foreground">Also export .SRT</p>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Also saves a separate .SRT file next to each video.
                  </p>
                </div>
                <Checkbox
                  checked={exportSrt}
                  onCheckedChange={(checked) => updateExportSettings({ exportSrt: checked === true })}
                  aria-label="Also export .SRT file"
                />
              </div>

              <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-card/40 px-3 py-2.5">
                <div className="space-y-0.5">
                  <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                    <Cpu className="size-3.5" />
                    Hardware encoding (GPU)
                  </p>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    {encodingAvailabilityText(acceleration)}
                    {encodingAvailable
                      ? " — if it isn't available, we render on the CPU instead."
                      : " — rendering runs on the CPU. Turn on GPU acceleration in Settings."}
                  </p>
                </div>
                <Switch
                  checked={useNvenc}
                  onCheckedChange={(checked) => updateExportSettings({ useNvenc: checked })}
                  disabled={!encodingAvailable}
                  aria-label="Use hardware encoding (GPU)"
                />
              </div>
            </div>

            <Separator />

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="filename-template" className="text-[13px] font-medium text-foreground">
                  Filename template
                </Label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-[10px] text-muted-foreground">Windows-safe</span>
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
                  Resulting names
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
                Output folder
              </Label>
              <Input
                id="output-dir"
                value={outputDir ?? ""}
                onChange={(event) =>
                  updateExportSettings({ outputDir: event.target.value || null })
                }
                placeholder={resolvedOutputDir || "Choose a folder"}
                spellCheck={false}
                className="font-mono text-xs"
              />
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                {outputDir?.trim()
                  ? "Files are written to this folder."
                  : "Empty — files go to the exports folder next to the lecture."}
              </p>
            </div>

            <Separator />

            <div className="space-y-2 rounded-md border border-border bg-card/40 px-3 py-2.5">
              <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <Type className="size-3.5" />
                Burned-in subtitle styles
              </p>
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
                <p className="flex items-start gap-1.5 text-[10px] leading-relaxed text-status-warning">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  The two lines overlap by {Math.abs(Math.round(overlap.gap))} px at this font size.
                  Reduce the font size or the Harakat padding in Settings → Fonts.
                </p>
              ) : null}
            </div>

            {clipsWithoutSubtitles > 0 ? (
              <div className="flex items-start gap-2 rounded-md border border-status-warning/30 bg-status-warning/10 px-2.5 py-2 text-[11px] leading-relaxed text-status-warning">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {clipsWithoutSubtitles} approved clip
                  {clipsWithoutSubtitles === 1 ? " has" : "s have"} no subtitles. They will render
                  without burned-in text.
                </span>
              </div>
            ) : null}

            {sidecar.status === "offline" ? (
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[11px] leading-relaxed text-destructive">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <div className="flex-1 space-y-1">
                  <p>{sidecar.error ?? "The processing engine isn't responding."}</p>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="h-5 text-destructive"
                    onClick={() => void refreshHealth()}
                  >
                    Retry
                  </Button>
                </div>
              </div>
            ) : null}
          </div>

          <div className="sticky bottom-0 mt-auto space-y-2 border-t border-border bg-background/95 px-4 py-3 backdrop-blur">
            {running ? (
              <Button variant="outline" className="w-full gap-2" onClick={cancelRender}>
                <Square className="size-3.5" />
                Cancel render
              </Button>
            ) : (
              <Button className="w-full gap-2" onClick={startRender}>
                <Play className="size-4" />
                Render {approvedClips.length} clip{approvedClips.length === 1 ? "" : "s"}
              </Button>
            )}
            <p className="text-center text-[10px] text-muted-foreground">
              {running
                ? "Rendering your clips…"
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
                onClick={() => void copyOutputPath()}
              >
                Copy path
              </Button>
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => setStep(3)}>
            Back to subtitles
          </Button>
          {job.status === "done" ? (
            <Button variant="secondary" size="sm" className="gap-1.5" onClick={startRender}>
              <RotateCw className="size-3.5" />
              Render again
            </Button>
          ) : null}
        </div>
      </footer>
    </div>
  );
}

/**
 * Batch-render job state and SSE orchestration, lifted out of Step 4.
 *
 * The wizard unmounts each step when the editor navigates, so component-local
 * job state used to abort a running batch and lose its progress. Keeping the
 * job here means switching steps (or closing the project view) never touches the
 * `/render-batch` stream; `Step4Export` is now a pure view over this store.
 */

import { create } from "zustand";
import { toast } from "sonner";

import { streamRenderBatch, type RenderCue, type RenderEvent } from "@/lib/api";
import { defaultOutputDirectory } from "@/lib/filenameTemplate";
import { formatClock } from "@/lib/format";
import type { SubtitleCue } from "@/lib/projectTypes";
import { assStyleToSpec, resolveAssStyles } from "@/lib/subtitleStyles";
import { wrapSubtitleText } from "@/lib/subtitleWrap";
import { useProjectStore } from "./projectStore";
import { useSettingsStore } from "./settingsStore";

export type ClipStatus = "queued" | "rendering" | "done" | "error" | "cancelled";

export interface ClipJob {
  index: number;
  title: string;
  status: ClipStatus;
  progress: number;
  encoder: string | null;
  outputPath: string | null;
  srtPath: string | null;
  detail: string | null;
}

export interface RenderJobState {
  /** Project that started the batch; the view only shows matching jobs. */
  projectId: string | null;
  status: "idle" | "running" | "done" | "error";
  overall: number;
  elapsed: number;
  rendered: number;
  failed: number;
  encoder: string | null;
  outputDir: string | null;
  clips: ClipJob[];
  message: string | null;
}

export const IDLE_RENDER_JOB: RenderJobState = {
  projectId: null,
  status: "idle",
  overall: 0,
  elapsed: 0,
  rendered: 0,
  failed: 0,
  encoder: null,
  outputDir: null,
  clips: [],
  message: null,
};

/**
 * Shown when the SSE stream closes without the sidecar's terminal `done` event
 * (backend crash, dropped connection, truncated response). The batch state is
 * unknown, so the UI must leave the "running" state instead of hanging.
 */
const STREAM_INTERRUPTED_MESSAGE =
  "The render stopped before it finished. Render the batch again; if it keeps happening, copy diagnostics from Settings → Main.";
const STREAM_INTERRUPTED_CLIP_DETAIL =
  "The render stream closed before this clip reported completion.";

function toRenderCues(
  cues: SubtitleCue[],
  maxCharsPerLine: number,
): { cues: RenderCue[]; skipped: number } {
  const valid: RenderCue[] = [];
  let skipped = 0;
  for (const cue of cues) {
    const start = Number(cue.start);
    const end = Number(cue.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      skipped += 1;
      continue;
    }
    valid.push({
      start: Math.max(0, start),
      end,
      arabic: cue.arabic ?? "",
      // Guarantee wrapped output at the boundary: even if a line was typed
      // past the wrap width and the editor never committed it (blur/split),
      // the burned `.ass` and the preview still agree. Idempotent.
      thai: wrapSubtitleText(cue.thai ?? "", maxCharsPerLine),
    });
  }
  return { cues: valid, skipped };
}

/** The in-flight stream; module-level so it survives step unmounts. */
let activeAbort: AbortController | null = null;
/** Incremented per batch/cancel so stale async callbacks can't touch new state. */
let activeRunId = 0;
/** Last fallback toast key in the current batch; dedupes repeated warnings. */
let fallbackToastKeyRef: string | null = null;

interface RenderState {
  job: RenderJobState;
  /** Validate the project and start a `/render-batch` stream (no-op guards toast). */
  startRender: () => void;
  /** Abort the active stream; the batch stops inside the sidecar. */
  cancelRender: () => void;
}

export const useRenderStore = create<RenderState>()((set) => ({
  job: IDLE_RENDER_JOB,

  startRender: () => {
    const current = useProjectStore.getState().project;
    if (!current) return;

    const approvedClips = current.clips.filter((clip) => clip.approved);
    if (approvedClips.length === 0) {
      toast.error("No approved clips", {
        description: "Approve at least one clip in Step 2 before exporting.",
      });
      return;
    }

    if (!current.sourcePath && !current.transcriptId) {
      toast.error("Lecture path missing", {
        description: "The source video or a stored transcript is needed. Re-add the lecture on Step 1.",
      });
      return;
    }

    const settings = useSettingsStore.getState();
    const resolved = resolveAssStyles(
      current.export.resolution,
      {
        font: settings.arabic.fontFamily,
        size: settings.arabic.fontSize,
        primaryColor: settings.arabic.color,
        outline: settings.arabic.outlineWidth,
        outlineColor: settings.arabic.outlineColor,
        boxOpacity: settings.arabic.boxOpacity,
        bold: settings.arabic.bold,
        lineHeightPad: settings.arabic.lineHeightPad,
        verticalOffset: settings.arabic.verticalOffset,
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
        verticalOffset: settings.thai.verticalOffset,
      },
    );

    let skippedCues = 0;
    const maxCharsPerLine = settings.editor.maxCharsPerLine;
    const renderClips = approvedClips.map((clip) => {
      const { cues, skipped } = toRenderCues(
        current.subtitles[clip.id] ?? [],
        maxCharsPerLine,
      );
      skippedCues += skipped;
      return {
        start: clip.start,
        end: clip.end,
        title: clip.title,
        subtitles: cues,
      };
    });

    const outputDir =
      current.export.outputDir?.trim() || defaultOutputDirectory(current.sourcePath);

    const runId = ++activeRunId;
    fallbackToastKeyRef = null;
    const controller = new AbortController();
    activeAbort?.abort();
    activeAbort = controller;

    set({
      job: {
        projectId: current.id,
        status: "running",
        overall: 0,
        elapsed: 0,
        rendered: 0,
        failed: 0,
        encoder: null,
        outputDir,
        message: null,
        clips: approvedClips.map((clip, index) => ({
          index,
          title: clip.title,
          status: "queued",
          progress: 0,
          encoder: null,
          outputPath: null,
          srtPath: null,
          detail: null,
        })),
      },
    });

    if (skippedCues > 0) {
      toast.warning("Some cues were skipped", {
        description: `${skippedCues} cue(s) have an invalid time range and were not burned in.`,
      });
    }

    const handleEvent = (event: RenderEvent) => {
      if (runId !== activeRunId) return;

      if (event.event === "start") {
        set((state) => ({
          job: {
            ...state.job,
            outputDir: event.outputDir ?? state.job.outputDir,
            clips: state.job.clips.map((clip) => {
              const plan = event.clips?.find((item) => item.index === clip.index);
              return plan
                ? { ...clip, outputPath: plan.outputPath, srtPath: plan.srtPath }
                : clip;
            }),
          },
        }));
        return;
      }

      if (event.event === "fallback") {
        set((state) => ({
          job: {
            ...state.job,
            encoder: event.encoder ?? state.job.encoder,
            message:
              event.reason ?? "GPU rendering failed — switching to CPU rendering.",
          },
        }));
        // One toast per distinct fallback cause per batch: on a CPU-only
        // machine every clip would otherwise repeat the same warning.
        const toastKey = `${event.failedEncoder ?? "hardware encoder"}:${event.reason ?? ""}`;
        if (fallbackToastKeyRef !== toastKey) {
          fallbackToastKeyRef = toastKey;
          toast.warning("GPU rendering unavailable", {
            description: "Switching to CPU rendering for this batch.",
          });
        }
        return;
      }

      if (event.event === "progress") {
        const index = event.clipIndex ?? 0;
        set((state) => ({
          job: {
            ...state.job,
            // Older sidecars may omit fields; keep the previous values instead
            // of collapsing progress to 0/undefined.
            overall: event.progress ?? state.job.overall,
            elapsed: event.elapsed ?? state.job.elapsed,
            encoder: event.encoder ?? state.job.encoder,
            clips: state.job.clips.map((clip) =>
              clip.index === index
                ? {
                    ...clip,
                    status: "rendering",
                    progress: event.clipProgress ?? clip.progress,
                    encoder: event.encoder ?? clip.encoder,
                  }
                : clip,
            ),
          },
        }));
        return;
      }

      if (event.event === "clip_done") {
        const index = event.clipIndex ?? 0;
        set((state) => {
          const clips = state.job.clips.map((clip): ClipJob =>
            clip.index === index
              ? {
                  ...clip,
                  status: "done",
                  progress: 1,
                  encoder: event.encoder ?? null,
                  outputPath: event.outputPath ?? null,
                  srtPath: event.srtPath ?? null,
                }
              : clip,
          );
          return {
            job: {
              ...state.job,
              overall: event.progress,
              elapsed: event.elapsed ?? state.job.elapsed,
              clips,
              // Derived from the updated list: a `+ 1` double-counted because
              // the clip had already been marked before counting.
              rendered: clips.filter((clip) => clip.status === "done").length,
            },
          };
        });
        return;
      }

      if (event.event === "clip_error") {
        const index = event.clipIndex ?? 0;
        set((state) => {
          const clips = state.job.clips.map((clip): ClipJob =>
            clip.index === index
              ? { ...clip, status: "error", detail: event.detail ?? "Unknown rendering error" }
              : clip,
          );
          return {
            job: {
              ...state.job,
              clips,
              failed: clips.filter((clip) => clip.status === "error").length,
            },
          };
        });
        toast.error("Clip failed to render", {
          description: event.detail ?? "Unknown rendering error",
        });
        return;
      }

      if (event.event === "done") {
        const failed = event.failedClips ?? useRenderStore.getState().job.failed;
        set((state) => ({
          job: {
            ...state.job,
            status: failed ? "error" : "done",
            overall: 1,
            elapsed: event.elapsed ?? state.job.elapsed,
            rendered: event.renderedClips ?? state.job.rendered,
            failed,
            outputDir: event.outputDir ?? state.job.outputDir,
          },
        }));
        // A batch with failures is an error outcome, not a success: the footer
        // already shows the failed count, the toast must agree with it.
        if (failed > 0) {
          toast.error("Batch finished with errors", {
            description: `${event.renderedClips ?? 0} clip(s) rendered, ${failed} failed.`,
          });
        } else {
          toast.success("Batch rendered", {
            description: `${event.renderedClips ?? 0} clip(s) in ${formatClock(
              event.elapsed ?? 0,
            )}.`,
          });
        }
      }
    };

    void (async () => {
      try {
        const stream = await streamRenderBatch(
          {
            project_name: current.name,
            source_path: current.sourcePath,
            transcript_id: current.transcriptId,
            clips: renderClips,
            resolution: current.export.resolution,
            framing: current.export.framing,
            use_nvenc: current.export.useNvenc,
            export_srt: current.export.exportSrt,
            output_dir: current.export.outputDir?.trim() ? current.export.outputDir : null,
            filename_template: current.export.filenameTemplate,
            subtitle_timebase: "clip",
            styles: {
              arabic: assStyleToSpec(resolved.arabic),
              thai: assStyleToSpec(resolved.thai),
            },
          },
          handleEvent,
          controller.signal,
        );
        if (runId !== activeRunId) return;
        // A user abort is a silent cancellation: `cancelRender` already reset
        // the UI, and the reader normally rejects rather than resolving.
        if (controller.signal.aborted) return;
        if (!stream.completed) {
          set((state) => {
            const clips = state.job.clips.map((clip): ClipJob =>
              clip.status === "rendering"
                ? { ...clip, status: "error", detail: STREAM_INTERRUPTED_CLIP_DETAIL }
                : clip,
            );
            return {
              job: {
                ...state.job,
                status: "error",
                message: STREAM_INTERRUPTED_MESSAGE,
                clips,
                rendered: clips.filter((clip) => clip.status === "done").length,
                failed: clips.filter((clip) => clip.status === "error").length,
              },
            };
          });
          toast.error("Render interrupted", { description: STREAM_INTERRUPTED_MESSAGE });
        }
      } catch (error) {
        if (runId !== activeRunId) return;
        if (controller.signal.aborted) {
          set((state) => ({ job: { ...state.job, status: "idle" } }));
          toast("Render cancelled");
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({ job: { ...state.job, status: "error", message } }));
        toast.error("Render failed", { description: message });
      } finally {
        if (activeAbort === controller) activeAbort = null;
      }
    })();
  },

  cancelRender: () => {
    // Invalidate in-flight callbacks first so the abort below cannot clobber
    // the reset state or double-toast "Render cancelled".
    activeRunId += 1;
    activeAbort?.abort();
    activeAbort = null;
    set((state) => ({
      job: {
        ...state.job,
        status: "idle",
        message: "Render cancelled.",
        // Frozen "Encoding"/"Queued" badges would hang forever; mark the
        // unfinished rows explicitly. Finished clips keep their "Rendered".
        clips: state.job.clips.map((clip) =>
          clip.status === "rendering" || clip.status === "queued"
            ? { ...clip, status: "cancelled", progress: 0 }
            : clip,
        ),
      },
    }));
    toast("Render cancelled");
  },
}));

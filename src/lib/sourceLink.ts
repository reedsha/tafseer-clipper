/**
 * Non-destructive lecture re-linking.
 *
 * A reopened project can point at a lecture on a disconnected or re-lettered
 * drive. Re-linking re-points `sourcePath` only — clips, subtitles, transcript
 * and the project id survive — unlike "Change lecture", which starts a new
 * session. Everything here is renderer-side plumbing over the asset protocol;
 * no media processing happens in the frontend.
 */

import { toast } from "sonner";

import { resolutionForDimensions } from "@/lib/clipMath";
import { L } from "@/lib/i18n";
import {
  hasLectureExtension,
  openLectureFile,
  probeMediaSrc,
  toMediaSrc,
  type MediaFailureKind,
} from "@/lib/media";
import { isSubtitleOnlyProject, type ProjectData } from "@/lib/projectTypes";
import { useProjectStore } from "@/store/projectStore";

/** Actionable, honest copy for a failed preview (never blames the asset protocol). */
export function mediaFailureMessage(kind: MediaFailureKind): string {
  switch (kind) {
    case "missing":
      return L(
        "The lecture can't be opened at its saved location. It may be on a disconnected drive.",
      );
    case "forbidden":
      return L("The lecture can't be read at its saved location.");
    case "decode":
      return L("This format can't be previewed in-app. Trimming and export still work.");
    case "network":
      return L("The preview stream was interrupted. Try again.");
    default:
      return L("The preview could not load this file.");
  }
}

export interface SourceVideoMetadata {
  duration: number | null;
  width: number | null;
  height: number | null;
}

/** Read a video's duration and dimensions from a throwaway metadata-only element. */
export function probeVideoMetadata(src: string): Promise<SourceVideoMetadata> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    let timer = 0;
    const finish = (value: SourceVideoMetadata) => {
      window.clearTimeout(timer);
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute("src");
      video.load();
      resolve(value);
    };
    timer = window.setTimeout(
      () => finish({ duration: null, width: null, height: null }),
      8_000,
    );
    video.onloadedmetadata = () =>
      finish({
        duration:
          Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null,
        width:
          Number.isFinite(video.videoWidth) && video.videoWidth > 0 ? video.videoWidth : null,
        height:
          Number.isFinite(video.videoHeight) && video.videoHeight > 0
            ? video.videoHeight
            : null,
      });
    video.onerror = () => finish({ duration: null, width: null, height: null });
    video.src = src;
  });
}

/**
 * Record the source file size (additive project field) without blocking ingest.
 * A later reconnect can match a moved lecture on another volume by size.
 */
export function recordSourceSize(path: string): void {
  const src = toMediaSrc(path);
  if (!src) return;
  void probeMediaSrc(src).then((probe) => {
    if (probe.size === null) return;
    const current = useProjectStore.getState().project;
    if (current?.sourcePath !== path) return;
    useProjectStore.getState().updateProject({ sourceSize: probe.size });
  });
}

/**
 * Probe size, duration, and video dimensions right after staging a file in
 * Step 1. When the project is in Subtitles-only mode, automatically match the
 * project's export orientation unless the user already chose one manually.
 */
export function recordSourceMetadata(
  path: string,
  options?: { shouldAutoMatchResolution?: () => boolean },
): void {
  recordSourceSize(path);
  const src = toMediaSrc(path);
  if (!src) return;
  void probeVideoMetadata(src).then(({ duration, width, height }) => {
    const current = useProjectStore.getState().project;
    if (current?.sourcePath !== path) return;
    const patch: Partial<ProjectData> = {};
    if (width && width > 0) patch.sourceWidth = Math.round(width);
    if (height && height > 0) patch.sourceHeight = Math.round(height);
    if (current.duration === null && duration && duration > 0) {
      patch.duration = duration;
    }
    if (Object.keys(patch).length > 0) {
      useProjectStore.getState().updateProject(patch);
    }
    if (
      isSubtitleOnlyProject(current) &&
      width &&
      height &&
      options?.shouldAutoMatchResolution?.() !== false
    ) {
      const detected = resolutionForDimensions(width, height);
      if (detected && detected !== current.export.resolution) {
        useProjectStore.getState().applyExportDefaults({ resolution: detected });
      }
    }
  });
}

/**
 * Ask for the lecture again and re-point the open project at it, keeping all
 * editorial work. Returns `true` when the source was re-linked.
 */
export async function relinkLecture(): Promise<boolean> {
  const pick = await openLectureFile();
  if (pick.cancelled || !pick.path) return false;
  const name = pick.name ?? pick.path.split(/[\\/]/).pop() ?? pick.path;
  if (!hasLectureExtension(name) && !hasLectureExtension(pick.path)) {
    toast.error(L("Unsupported file"), {
      description: L("Choose an MP4, MOV or MKV lecture."),
    });
    return false;
  }
  const src = toMediaSrc(pick.path);
  if (!src) {
    toast.error(L("Re-link needs the desktop app"));
    return false;
  }
  const probe = await probeMediaSrc(src);
  if (!probe.ok) {
    toast.error(L("Can't read that file"), {
      description: L("The selected file could not be opened."),
    });
    return false;
  }

  const previousDuration = useProjectStore.getState().project?.duration ?? null;
  useProjectStore.getState().relinkSource({ path: pick.path, name, size: probe.size });

  // Timings assume one source: warn when the replacement is a different length.
  if (previousDuration !== null) {
    const { duration: actual } = await probeVideoMetadata(src);
    if (actual !== null && Math.abs(actual - previousDuration) > 1) {
      toast.warning(L("Different lecture length"), {
        description: L(
          "This file's length differs from the original. Clips and subtitles may not line up.",
        ),
      });
    }
  }
  toast.success(L("Lecture re-linked"), { description: name });
  return true;
}

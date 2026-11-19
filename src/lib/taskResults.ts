/**
 * Pure result application and a small durable journal for background tasks.
 *
 * A job may finish while the editor is looking at a different session. Its
 * result must land in the session that started it — not in whatever project is
 * currently open. This module owns that rule:
 *
 * - `applyTaskResult(project, payload)` is a pure merge used by the store.
 * - `queuePendingResult` persists a result for an inactive project.
 * - `applyPendingResults(project)` drains the journal when that project opens.
 *
 * Kept dependency-free (types + one pure geometry helper) so the store layer
 * can import it without a cycle.
 */

import { rangesOverlap } from "@/lib/clipMath";
import type {
  ProjectClip,
  ProjectData,
  SubtitleCue,
  TranscriptData,
} from "@/lib/projectTypes";

export type TaskKind = "transcribe" | "discovery" | "verify";

export type TaskResultPayload =
  | {
      kind: "transcribe";
      transcriptId: string;
      transcript: TranscriptData;
      duration: number | null;
      audioPath: string | null;
    }
  | {
      kind: "discovery";
      /** Proposals built by the step; merged against the target project here. */
      proposals: ProjectClip[];
      replaceAll: boolean;
      /** Reported by the sidecar; used only for the success toast. */
      excludedRangesApplied?: number;
    }
  | {
      kind: "verify";
      clipId: string;
      /**
       * One entry per verified line. The text and the corpus provenance are
       * written together: a line can be confirmed *without* a correction, and
       * dropping `source`/`reference` for those is what left verified verses
       * unbadged in Step 3.
       */
      lines: Array<{
        cueId: string;
        arabic: string;
        source?: string;
        reference?: string | null;
        confidence?: number | null;
      }>;
    };

interface PendingResult {
  id: string;
  projectId: string;
  createdAt: number;
  payload: TaskResultPayload;
}

const PENDING_KEY = "tafseer.pendingResults.v1";
const MAX_PENDING = 50;

function applyTranscribe(
  project: ProjectData,
  payload: Extract<TaskResultPayload, { kind: "transcribe" }>,
): ProjectData {
  return {
    ...project,
    transcriptId: payload.transcriptId,
    transcript: payload.transcript,
    duration: payload.duration,
    audioPath: payload.audioPath,
    // A new transcript invalidates every cue keyed by the old timing/text.
    subtitles: {},
    step: project.step < 2 ? 2 : project.step,
  };
}

function applyDiscovery(
  project: ProjectData,
  payload: Extract<TaskResultPayload, { kind: "discovery" }>,
): ProjectData {
  const approved = payload.replaceAll ? [] : project.clips.filter((clip) => clip.approved);
  // The proposal list may include ranges the editor has since approved; the
  // merge is the single place that decides what survives, so it stays correct
  // whether the job finished while open or while another session was visible.
  const fresh = payload.proposals.filter(
    (clip) =>
      !approved.some((kept) => rangesOverlap(clip.start, clip.end, kept.start, kept.end)),
  );
  // An empty re-roll means "nothing more was found", never "throw away the deck
  // the editor is reviewing". This also covers "Start over": a clean search
  // that returns nothing must not delete the kept clips and their hand-edited
  // subtitles, which no rebuild could restore.
  if (fresh.length === 0) return project;
  const merged = [...approved, ...fresh].sort((a, b) => a.start - b.start);
  const selectedClipId = merged.some((clip) => clip.id === project.selectedClipId)
    ? project.selectedClipId
    : (merged[0]?.id ?? null);
  return {
    ...project,
    clips: merged,
    // Old clip ids are gone on a clean restart, so their cue tracks must go too.
    subtitles: payload.replaceAll ? {} : project.subtitles,
    selectedClipId,
  };
}

function applyVerify(
  project: ProjectData,
  payload: Extract<TaskResultPayload, { kind: "verify" }>,
): ProjectData {
  const cues = project.subtitles[payload.clipId];
  if (!cues?.length) return project;
  const byCue = new Map(payload.lines.map((line) => [line.cueId, line]));
  let changed = false;
  const next = cues.map((cue) => {
    const line = byCue.get(cue.id);
    if (!line) return cue;
    const patch: Partial<SubtitleCue> = {};
    // A confirmed line keeps its text; only the provenance is new. Treating
    // "same text" as "nothing to do" is what hid every corpus match.
    if (line.arabic && line.arabic !== cue.arabic) patch.arabic = line.arabic;
    if (line.source && line.source !== cue.source) patch.source = line.source;
    if (line.reference && line.reference !== cue.reference) patch.reference = line.reference;
    if (typeof line.confidence === "number" && line.confidence !== cue.confidence) {
      patch.confidence = line.confidence;
    }
    if (Object.keys(patch).length === 0) return cue;
    changed = true;
    return { ...cue, ...patch };
  });
  if (!changed) return project;
  return { ...project, subtitles: { ...project.subtitles, [payload.clipId]: next } };
}

/** Merge one finished task result into a project. Returns the same object when nothing changed. */
export function applyTaskResult(project: ProjectData, payload: TaskResultPayload): ProjectData {
  switch (payload.kind) {
    case "transcribe":
      return applyTranscribe(project, payload);
    case "discovery":
      return applyDiscovery(project, payload);
    case "verify":
      return applyVerify(project, payload);
  }
}

/* -------------------------------------------------------------------------- */
/* Journal for results whose project is not currently open                     */
/* -------------------------------------------------------------------------- */

function readJournal(): PendingResult[] {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is PendingResult =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as PendingResult).id === "string" &&
        typeof (item as PendingResult).projectId === "string" &&
        typeof (item as PendingResult).payload === "object",
    );
  } catch {
    return [];
  }
}

function writeJournal(list: PendingResult[]): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(-MAX_PENDING)));
  } catch {
    /* Storage unavailable — the result is still applied if the project is open. */
  }
}

/** Persist a result for a project that is not currently open. */
export function queuePendingResult(projectId: string, payload: TaskResultPayload): void {
  const list = readJournal();
  list.push({
    id:
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    projectId,
    createdAt: Date.now(),
    payload,
  });
  writeJournal(list);
}

/**
 * Drain every pending result for a project, oldest first. The journal entries
 * are removed before returning, so applying twice can never double-apply.
 */
export function applyPendingResults(project: ProjectData): {
  project: ProjectData;
  applied: number;
} {
  const all = readJournal();
  const mine = all.filter((item) => item.projectId === project.id);
  if (mine.length === 0) return { project, applied: 0 };
  writeJournal(all.filter((item) => item.projectId !== project.id));
  const next = mine
    .sort((a, b) => a.createdAt - b.createdAt)
    .reduce((current, item) => applyTaskResult(current, item.payload), project);
  return { project: next, applied: mine.length };
}

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

import {
  buildFullVideoClip,
  effectiveTranscriptDuration,
} from "@/lib/clipMath";
import {
  isSubtitleOnlyProject,
  type ProjectClip,
  type ProjectData,
  type SubtitleCue,
  type TranscriptData,
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
        arabic?: string;
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
  if (isSubtitleOnlyProject(project)) {
    const duration = effectiveTranscriptDuration(
      payload.duration,
      payload.transcript.segments,
    );
    const fullClip = buildFullVideoClip({
      name: project.name,
      sourceFileName: project.sourceFileName,
      duration,
    });
    if (fullClip) {
      return {
        ...project,
        transcriptId: payload.transcriptId,
        transcript: payload.transcript,
        duration: payload.duration ?? duration,
        audioPath: payload.audioPath,
        clips: [fullClip],
        selectedClipId: fullClip.id,
        // A new transcript invalidates every cue keyed by the old timing/text.
        subtitles: {},
        inserts: undefined,
        step: project.step < 3 ? 3 : project.step,
      };
    }
    return {
      ...project,
      transcriptId: payload.transcriptId,
      transcript: payload.transcript,
      duration: payload.duration,
      audioPath: payload.audioPath,
      clips: [],
      selectedClipId: null,
      subtitles: {},
      inserts: undefined,
      step: 1,
    };
  }

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
  // Approved ranges were already excluded by the sidecar. A proposal can still
  // collide after cut-buffer padding, or overlap a clip approved while the job
  // was running. Keep it and let Step 2 label the collision: silently dropping
  // it here loses valid adjacent clips and makes the success toast count lie.
  const fresh = payload.proposals;
  // An empty re-roll means "nothing more was found", never "throw away the deck
  // the editor is reviewing". This also covers "Start over": a clean search
  // that returns nothing must not delete the kept clips and their hand-edited
  // subtitles, which no rebuild could restore.
  if (fresh.length === 0) return project;
  const merged = [...approved, ...fresh].sort((a, b) => a.start - b.start);
  const selectedClipId = merged.some((clip) => clip.id === project.selectedClipId)
    ? project.selectedClipId
    : (merged[0]?.id ?? null);
  const validClipIds = new Set(merged.map((clip) => clip.id));
  const cleanedSubtitles: Record<string, SubtitleCue[]> = {};
  for (const [clipId, cues] of Object.entries(project.subtitles)) {
    if (validClipIds.has(clipId)) {
      cleanedSubtitles[clipId] = cues;
    }
  }
  return {
    ...project,
    clips: merged,
    subtitles: cleanedSubtitles,
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
    if (line.source === "unmatched" || line.source === "needs_model") {
      if (
        cue.source !== undefined ||
        cue.reference !== undefined ||
        cue.confidence !== undefined ||
        cue.translation !== undefined
      ) {
        changed = true;
        return {
          ...cue,
          source: undefined,
          reference: undefined,
          confidence: undefined,
          translation: undefined,
        };
      }
      return cue;
    }
    const patch: Partial<SubtitleCue> = {};
    // A confirmed line keeps its text; only the provenance is new. Treating
    // "same text" as "nothing to do" is what hid every corpus match.
    if (line.arabic && line.arabic !== cue.arabic) {
      patch.arabic = line.arabic;
      patch.reviewed = false;
    }
    if (line.source && line.source !== cue.source) patch.source = line.source;
    if (line.reference !== undefined && (line.reference ?? undefined) !== cue.reference) {
      patch.reference = line.reference ?? undefined;
    }
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

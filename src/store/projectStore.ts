import { create } from "zustand";
import { persist } from "zustand/middleware";

import {
  type ProjectClip,
  type ProjectData,
  type ProjectExportSettings,
  type RecentProject,
  type SubtitleCue,
  type TranscriptData,
  type WizardStep,
} from "@/lib/projectTypes";
import {
  deleteAutosave,
  deleteAutosaveFile,
  isDesktopRuntime,
  readAutosave,
  readAutosaveFile,
  toRecentProject,
  writeAutosave,
  writeAutosaveFile,
} from "@/lib/projectFile";
import {
  applyPendingResults,
  applyTaskResult as mergeTaskResult,
  type TaskResultPayload,
} from "@/lib/taskResults";
import { useSettingsStore, type EditorDefaults } from "./settingsStore";

const MAX_RECENT_SESSIONS = 30;

/** Discarded clips kept per project as negative examples for a re-roll. */
const MAX_TRASHED_CLIPS = 20;

export interface CreateProjectInput {
  name?: string;
  sourcePath?: string | null;
  sourceFileName?: string | null;
  duration?: number | null;
}

export interface ProjectState {
  project: ProjectData | null;
  recentProjects: RecentProject[];
  /** Id of the most recently opened project; the Recent bar leads with it. */
  lastProjectId: string | null;
  autosavedAt: number | null;
  dirty: boolean;
  /** Set when the durable disk auto-save failed; cleared on the next success. */
  lastAutosaveError: string | null;

  createProject: (input?: CreateProjectInput) => ProjectData;
  openProject: (project: ProjectData) => void;
  closeProject: () => void;
  updateProject: (patch: Partial<ProjectData>) => void;
  setStep: (step: WizardStep) => void;

  setTranscript: (
    transcriptId: string,
    transcript: TranscriptData,
    duration: number | null,
  ) => void;
  setClips: (clips: ProjectClip[]) => void;
  addClips: (clips: ProjectClip[]) => void;
  updateClip: (id: string, patch: Partial<ProjectClip>) => void;
  approveClip: (id: string, approved: boolean) => void;
  removeClip: (id: string) => void;
  selectClip: (id: string | null) => void;
  setSubtitles: (clipId: string, cues: SubtitleCue[]) => void;
  setBasePrompt: (prompt: string) => void;
  setPromptPreset: (presetId: string | null) => void;
  setSessionGuide: (guide: string) => void;
  updateExportSettings: (patch: Partial<ProjectExportSettings>) => void;
  /** Apply the Settings → 4 · Export defaults to the active project only. */
  applyExportDefaults: (patch: Partial<ProjectExportSettings>) => void;
  /**
   * Merge a finished background-task result into the open project. A result
   * for any other project is journaled by the caller (see `taskResults`).
   */
  applyTaskResult: (projectId: string, payload: TaskResultPayload) => void;

  autosave: () => boolean;
  resumeRecent: (projectId: string) => Promise<boolean>;
  removeRecent: (projectId: string) => void;
  /** Inline-rename a session (the open one or a listed recent). */
  renameSession: (projectId: string, name: string) => void;
  markSaved: () => void;
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^./\\]+$/, "");
}

function upsertRecent(list: RecentProject[], entry: RecentProject): RecentProject[] {
  const next = [entry, ...list.filter((item) => item.id !== entry.id)];
  return next.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_RECENT_SESSIONS);
}

/**
 * Step 3 and Step 4 edit the project's export settings directly. Mirroring the
 * shared fields into Settings → 4 · Export keeps the persisted defaults honest;
 * without it the drawer keeps showing whatever was last edited there while the
 * exported file follows the project.
 */
function mirrorExportDefaults(patch: Partial<ProjectExportSettings>): void {
  const mirrored: Partial<EditorDefaults> = {};
  if (patch.resolution !== undefined) mirrored.resolution = patch.resolution;
  if (patch.framing !== undefined) mirrored.framing = patch.framing;
  if (patch.useNvenc !== undefined) mirrored.useNvenc = patch.useNvenc;
  if (patch.exportSrt !== undefined) mirrored.exportSrt = patch.exportSrt;
  if (patch.filenameTemplate !== undefined) mirrored.filenameTemplate = patch.filenameTemplate;
  if (Object.keys(mirrored).length === 0) return;
  useSettingsStore.getState().updateEditor(mirrored);
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Validate one persisted `recentProjects` entry (persist migrate/merge). */
function normalizeRecentProject(value: unknown): RecentProject | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  if (!id) return null;
  const step =
    record.step === 2 || record.step === 3 || record.step === 4 ? record.step : 1;
  const updatedAt = finiteNumber(record.updatedAt, Date.now());
  return {
    id,
    name: typeof record.name === "string" ? record.name : "Untitled session",
    sourceFileName:
      typeof record.sourceFileName === "string" ? record.sourceFileName : null,
    step,
    duration:
      typeof record.duration === "number" && Number.isFinite(record.duration)
        ? record.duration
        : null,
    clipCount: Math.max(0, Math.round(finiteNumber(record.clipCount, 0))),
    updatedAt,
    lastActivityAt: finiteNumber(record.lastActivityAt, updatedAt),
  };
}

/** Revalidate a persisted recent-projects list instead of discarding it. */
function normalizeRecentProjects(value: unknown): RecentProject[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const entries: RecentProject[] = [];
  for (const item of value) {
    const entry = normalizeRecentProject(item);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return entries.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_RECENT_SESSIONS);
}

function touch(project: ProjectData, patch: Partial<ProjectData>): ProjectData {
  // A no-op patch (an effect writing back the values it just read) must not
  // advance the activity clock — only a real change counts as work.
  let changed = false;
  for (const key of Object.keys(patch) as (keyof ProjectData)[]) {
    if (project[key] !== patch[key]) {
      changed = true;
      break;
    }
  }
  const now = Date.now();
  return {
    ...project,
    ...patch,
    updatedAt: now,
    // Workflow-activity clock for the sidebar's Today/Yesterday groups:
    // opening or auto-saving a session never advances it, only real edits
    // and step changes do.
    lastActivityAt: changed ? now : project.lastActivityAt,
  };
}

/**
 * Cue times are stored clip-relative (`cue.start = segment.start - clip.start`)
 * and `/render-batch` receives `subtitle_timebase: "clip"`, so any change of a
 * clip's start must shift that clip's cues by the same delta or the burned
 * subtitles drift silently. `delta` is `oldStart - newStart`.
 */
export const CUE_REBASE_EPSILON = 0.0005;
const MIN_CUE_WINDOW = 0.05;

/** Pure: shift one clip's cues by `delta` and clamp into `[0, clipDuration]`. */
export function rebaseCuesForClip(
  subtitles: Record<string, SubtitleCue[]>,
  clipId: string,
  delta: number,
  clipDuration: number,
): Record<string, SubtitleCue[]> {
  if (!Number.isFinite(delta) || Math.abs(delta) < CUE_REBASE_EPSILON) return subtitles;
  const cues = subtitles[clipId];
  if (!cues || cues.length === 0) return subtitles;
  const duration = Math.max(0, clipDuration);
  const shifted = cues.map((cue) => {
    let start = Math.max(0, Math.min(cue.start + delta, duration));
    let end = Math.max(0, Math.min(cue.end + delta, duration));
    // Never delete text: keep a minimum window even when the shift pushes the
    // cue against a boundary.
    if (end - start < MIN_CUE_WINDOW) {
      start = Math.max(0, Math.min(start, Math.max(0, duration - MIN_CUE_WINDOW)));
      end = Math.min(duration, start + MIN_CUE_WINDOW);
    }
    return { ...cue, start, end };
  });
  return { ...subtitles, [clipId]: shifted };
}

/** Shift cues for a clip whose start moved; a no-op below the epsilon. */
function rebaseCuesForMovedClip(
  subtitles: Record<string, SubtitleCue[]>,
  prev: ProjectClip | undefined,
  next: ProjectClip | undefined,
): Record<string, SubtitleCue[]> {
  if (!prev || !next) return subtitles;
  const delta = prev.start - next.start;
  return rebaseCuesForClip(subtitles, prev.id, delta, next.end - next.start);
}

/**
 * Pure: keep one clip's cues inside `[0, duration]`.
 *
 * Shortening a clip in Step 2 used to leave cues past the new end: they could
 * never be shown, the tail was silently skipped, and the only visible remedy
 * was "Build subtitles", which discards every hand edit. Cues that start after
 * the new end are dropped; the ones that straddle it are clamped so their text
 * still appears once. Returns the same object when nothing needed clamping.
 */
export function clampCuesToDuration(
  subtitles: Record<string, SubtitleCue[]>,
  clipId: string,
  duration: number,
): Record<string, SubtitleCue[]> {
  const cues = subtitles[clipId];
  if (!cues?.length) return subtitles;
  const limit = Math.max(0, duration);
  const next: SubtitleCue[] = [];
  let changed = false;
  for (const cue of cues) {
    if (cue.start >= limit) {
      changed = true;
      continue;
    }
    const start = Math.min(cue.start, Math.max(0, limit - MIN_CUE_WINDOW));
    const end = Math.min(limit, Math.max(cue.end, start + MIN_CUE_WINDOW));
    if (start === cue.start && end === cue.end) {
      next.push(cue);
      continue;
    }
    changed = true;
    next.push({ ...cue, start, end });
  }
  if (!changed) return subtitles;
  return { ...subtitles, [clipId]: next };
}

/**
 * Drop the auto-saves of entries evicted from `recentProjects`. The localStorage
 * journal is cleaned synchronously; the durable disk copy is fire-and-forget.
 */
function pruneEvictedAutosaves(previous: RecentProject[], next: RecentProject[]): void {
  const kept = new Set(next.map((item) => item.id));
  const projectFolder = useSettingsStore.getState().storage.projectFolder;
  for (const entry of previous) {
    if (kept.has(entry.id)) continue;
    deleteAutosave(entry.id);
    void deleteAutosaveFile(entry.id, projectFolder, entry.name);
  }
}

/**
 * Write the durable `.tafseer` copy after the fast localStorage write.
 * Fire-and-forget: a failure lands in `lastAutosaveError` (the UI warns) and
 * never interrupts editing.
 */
function persistAutosaveToDisk(project: ProjectData): void {
  if (!isDesktopRuntime()) return;
  const projectFolder = useSettingsStore.getState().storage.projectFolder;
  void writeAutosaveFile(project, projectFolder)
    .then(() => {
      if (useProjectStore.getState().project?.id === project.id) {
        useProjectStore.setState({ lastAutosaveError: null });
      }
    })
    .catch((error: unknown) => {
      if (useProjectStore.getState().project?.id === project.id) {
        useProjectStore.setState({
          lastAutosaveError: error instanceof Error ? error.message : String(error),
        });
      }
    });
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set, get) => ({
      project: null,
      recentProjects: [],
      autosavedAt: null,
      dirty: false,
      lastAutosaveError: null,
      lastProjectId: null,

      createProject: (input = {}) => {
        // Save the outgoing project before replacing it: the debounced timer
        // would otherwise write whatever is current at fire time and silently
        // discard the outgoing project's last edits.
        if (get().project && get().dirty) get().autosave();
        const now = Date.now();
        const sourceFileName = input.sourceFileName ?? null;
        const name = input.name ?? (sourceFileName ? stripExtension(sourceFileName) : "Untitled session");
        const editor = useSettingsStore.getState().editor;
        const project: ProjectData = {
          schemaVersion: 1,
          id: crypto.randomUUID(),
          name,
          sourcePath: input.sourcePath ?? null,
          sourceFileName,
          duration: input.duration ?? null,
          step: 1,
          transcriptId: null,
          transcript: null,
          audioPath: null,
          basePrompt: "You are a senior Thai Tafseer video editor. You cut long Thai Tafseer lectures (Thai speech with Arabic Qur'anic recitation, often transliterated into Thai script by the speech-to-text) into standalone social clips for a Thai Muslim audience.\n\nA GOOD clip:\n- Delivers ONE clear lesson, ruling, story, or reminder that a viewer can understand with no prior context.\n- Has a strong hook (a question, a verse, a story, a striking statement) and a clear takeaway or conclusion.\n- Is self-contained: if a name, verse, or event needs context, the passage itself must supply it. Avoid clips that only make sense after an earlier part of the lecture.\n- Prefers emotionally resonant, practical, shareable moments (hope, patience, trust in Allah, gratitude, moral stories, clear fiqh answers, reminders about death/the Hereafter) over admin, greetings, repetition, or filler.\n- When a passage contains Arabic Qur'anic recitation, include the whole recitation together with its Thai explanation. Do not split a recitation from the explanation that follows it.\n\nBOUNDARIES (decide these carefully):\n- Start where the actual point begins. Skip preparatory discussion, setup, or background that only makes sense with an earlier part of the lecture, unless that sentence is needed for the clip to be understood on its own.\n- End at the point's conclusion or final takeaway. Stop before the lecturer moves on to the next point, the next verse, a new story, or the consequences/follow-up of the same point.\n- Never cut mid-sentence or mid-recitation. Start and end on complete sentences. If a sentence is very long, include it whole rather than truncating.\n- When in doubt between two possible end points, choose the earlier one that still contains the complete point and its conclusion.\n\nDO NOT propose clips that:\n- Are greetings, announcements, fundraising, or channel admin.\n- Are only Qur'anic recitation with no explanation, or only Thai filler / repetition.\n- End before the lesson reaches its conclusion.\n- Bundle two or more unrelated points into one clip.\n- Start or end inside an Arabic recitation.\n- Depend on context from earlier in the lecture that is not included.\n\nTitle (Thai, max 70 chars): name the moment or lesson, not the editing process. Rationale (Thai, one sentence): why this passage works as a standalone clip.\n\nWrite titles and rationales in Thai.",
          promptPresetId: null,
          sessionGuide: "",
          clips: [],
          selectedClipId: null,
          subtitles: {},
          // Seed from Settings → 4 · Export so the render path reads one source of
          // truth (`project.export.*`) instead of a static default table.
          export: {
            resolution: editor.resolution,
            framing: editor.framing,
            useNvenc: editor.useNvenc,
            exportSrt: editor.exportSrt,
            filenameTemplate: editor.filenameTemplate,
            outputDir: null,
          },
          createdAt: now,
          updatedAt: now,
          lastActivityAt: now,
        };
        const previousRecent = get().recentProjects;
        const recentProjects = upsertRecent(previousRecent, toRecentProject(project));
        pruneEvictedAutosaves(previousRecent, recentProjects);
        set({
          project,
          autosavedAt: null,
          dirty: true,
          lastAutosaveError: null,
          lastProjectId: project.id,
          recentProjects,
        });
        return project;
      },

      openProject: (project) => {
        if (get().project && get().dirty) get().autosave();
        // A task that finished while another session was visible left its result
        // in the journal; merging here is the only place those results land.
        const { project: merged, applied } = applyPendingResults(project);
        const previousRecent = get().recentProjects;
        const recentProjects = upsertRecent(previousRecent, toRecentProject(merged));
        pruneEvictedAutosaves(previousRecent, recentProjects);
        set({
          project: merged,
          autosavedAt: null,
          // Pending results are real work and must be written back to disk.
          dirty: applied > 0,
          lastAutosaveError: null,
          lastProjectId: merged.id,
          recentProjects,
        });
      },

      closeProject: () => {
        if (get().project && get().dirty) get().autosave();
        set({
          project: null,
          autosavedAt: null,
          dirty: false,
          lastAutosaveError: null,
          lastProjectId: null,
        });
      },

      updateProject: (patch) =>
        set((state) => {
          if (!state.project) return {};
          return { project: touch(state.project, patch), dirty: true };
        }),

      setStep: (step) =>
        set((state) => {
          if (!state.project) return {};
          return { project: touch(state.project, { step }), dirty: true };
        }),

      setTranscript: (transcriptId, transcript, duration) =>
        set((state) => {
          if (!state.project) return {};
          // A new transcript invalidates the old cue timing/text (including
          // Arabic recovery); Step 3 reseeds from the new one.
          return {
            project: touch(state.project, {
              transcriptId,
              transcript,
              duration,
              subtitles: {},
            }),
            dirty: true,
          };
        }),

      setClips: (clips) =>
        set((state) => {
          if (!state.project) return {};
          // Re-base cues for existing clips whose start moved (trim commits and
          // the Step-2 buffer re-apply arrive through here wholesale).
          let subtitles = state.project.subtitles;
          for (const prev of state.project.clips) {
            const next = clips.find((clip) => clip.id === prev.id);
            subtitles = rebaseCuesForMovedClip(subtitles, prev, next);
            if (next) {
              subtitles = clampCuesToDuration(subtitles, prev.id, next.end - next.start);
            }
          }
          const selectedClipId = state.project.selectedClipId;
          return {
            project: touch(state.project, {
              clips,
              subtitles,
              selectedClipId: clips.some((clip) => clip.id === selectedClipId)
                ? selectedClipId
                : (clips[0]?.id ?? null),
            }),
            dirty: true,
          };
        }),

      addClips: (clips) =>
        set((state) => {
          if (!state.project) return {};
          const merged = [...state.project.clips, ...clips];
          return {
            project: touch(state.project, {
              clips: merged,
              selectedClipId: state.project.selectedClipId ?? merged[0]?.id ?? null,
            }),
            dirty: true,
          };
        }),

      updateClip: (id, patch) =>
        set((state) => {
          if (!state.project) return {};
          const prev = state.project.clips.find((clip) => clip.id === id);
          const clips = state.project.clips.map((clip) =>
            clip.id === id ? { ...clip, ...patch } : clip,
          );
          let subtitles = state.project.subtitles;
          const nextClip = clips.find((clip) => clip.id === id);
          if (
            prev &&
            typeof patch.start === "number" &&
            Number.isFinite(patch.start) &&
            Math.abs(prev.start - patch.start) >= CUE_REBASE_EPSILON
          ) {
            subtitles = rebaseCuesForMovedClip(subtitles, prev, nextClip);
          }
          // Shortening the cut-out leaves cues hanging past the end: they are
          // orphaned, never rendered, and the only visible remedy used to be a
          // full rebuild. Drop/clamp them here instead.
          if (
            prev &&
            nextClip &&
            prev.end - prev.start > nextClip.end - nextClip.start + CUE_REBASE_EPSILON
          ) {
            subtitles = clampCuesToDuration(
              subtitles,
              id,
              nextClip.end - nextClip.start,
            );
          }
          return {
            project: touch(state.project, { clips, subtitles }),
            dirty: true,
          };
        }),

      approveClip: (id, approved) =>
        set((state) => {
          if (!state.project) return {};
          return {
            project: touch(state.project, {
              clips: state.project.clips.map((clip) =>
                clip.id === id ? { ...clip, approved } : clip,
              ),
            }),
            dirty: true,
          };
        }),

      removeClip: (id) =>
        set((state) => {
          if (!state.project) return {};
          const removed = state.project.clips.find((clip) => clip.id === id);
          const clips = state.project.clips.filter((clip) => clip.id !== id);
          const subtitles = { ...state.project.subtitles };
          delete subtitles[id];
          // A discarded clip is the strongest negative example a re-roll can
          // get, so it is kept (bounded) instead of vanishing without trace.
          const trashedClips = removed
            ? [...(state.project.trashedClips ?? []), removed].slice(-MAX_TRASHED_CLIPS)
            : state.project.trashedClips;
          return {
            project: touch(state.project, {
              clips,
              subtitles,
              ...(trashedClips ? { trashedClips } : {}),
              selectedClipId:
                state.project.selectedClipId === id
                  ? (clips[0]?.id ?? null)
                  : state.project.selectedClipId,
            }),
            dirty: true,
          };
        }),

      selectClip: (id) =>
        set((state) => {
          if (!state.project) return {};
          return { project: touch(state.project, { selectedClipId: id }), dirty: true };
        }),

      setSubtitles: (clipId, cues) =>
        set((state) => {
          if (!state.project) return {};
          return {
            project: touch(state.project, {
              subtitles: { ...state.project.subtitles, [clipId]: cues },
            }),
            dirty: true,
          };
        }),

      setBasePrompt: (basePrompt) =>
        set((state) => {
          if (!state.project) return {};
          return { project: touch(state.project, { basePrompt }), dirty: true };
        }),

      setPromptPreset: (promptPresetId) =>
        set((state) => {
          if (!state.project) return {};
          return { project: touch(state.project, { promptPresetId }), dirty: true };
        }),

      setSessionGuide: (sessionGuide) =>
        set((state) => {
          if (!state.project) return {};
          return { project: touch(state.project, { sessionGuide }), dirty: true };
        }),

      updateExportSettings: (patch) => {
        mirrorExportDefaults(patch);
        set((state) => {
          if (!state.project) return {};
          return {
            project: touch(state.project, { export: { ...state.project.export, ...patch } }),
            dirty: true,
          };
        });
      },

      applyExportDefaults: (patch) =>
        set((state) => {
          if (!state.project) return {};
          return {
            project: touch(state.project, { export: { ...state.project.export, ...patch } }),
            dirty: true,
          };
        }),

      applyTaskResult: (projectId, payload) =>
        set((state) => {
          if (!state.project || state.project.id !== projectId) return {};
          const next = mergeTaskResult(state.project, payload);
          if (next === state.project) return {};
          return { project: touch(state.project, next), dirty: true };
        }),

      autosave: () => {
        const { project, dirty } = get();
        if (!project) return false;
        const saved = writeAutosave(project);
        // The durable disk copy is the safety net for exactly the case where
        // the localStorage journal fails (quota, privacy mode), so it must run
        // regardless of the journal result.
        persistAutosaveToDisk(project);
        if (!saved) {
          set({ lastAutosaveError: "Local journal write failed — the disk copy still saves." });
          return false;
        }
        const savedAt = Date.now();
        // A redundant save (nothing changed since the last one — e.g. the
        // debounced timer firing right after a session was opened) must not
        // refresh the recent entry's save time: an untouched session reopened
        // from yesterday would otherwise read "just now" in the sidebar.
        if (!dirty) {
          set({ autosavedAt: savedAt, lastAutosaveError: null });
          return true;
        }
        const previousRecent = get().recentProjects;
        const recentProjects = upsertRecent(
          previousRecent,
          toRecentProject({ ...project, updatedAt: savedAt }),
        );
        pruneEvictedAutosaves(previousRecent, recentProjects);
        set({
          autosavedAt: savedAt,
          dirty: false,
          lastAutosaveError: null,
          recentProjects,
        });
        return true;
      },

      resumeRecent: async (projectId) => {
        if (get().project && get().dirty) get().autosave();
        try {
          // Fast path: the localStorage journal holds the newest snapshot.
          const local = readAutosave(projectId);
          if (local) {
            get().openProject(local);
            set({ autosavedAt: local.updatedAt });
            return true;
          }
          // Durable fallback: the localStorage copy is gone (quota/cleanup) but
          // the disk auto-save may still be there.
          const recent = get().recentProjects.find((item) => item.id === projectId);
          const projectFolder = useSettingsStore.getState().storage.projectFolder;
          const disk = await readAutosaveFile(projectId, projectFolder, recent?.name);
          if (!disk) return false;
          get().openProject(disk);
          set({ autosavedAt: disk.updatedAt });
          return true;
        } catch {
          return false;
        }
      },

      removeRecent: (projectId) => {
        deleteAutosave(projectId);
        const recent = get().recentProjects.find((item) => item.id === projectId);
        const projectFolder = useSettingsStore.getState().storage.projectFolder;
        void deleteAutosaveFile(projectId, projectFolder, recent?.name);
        set((state) => {
          const recentProjects = state.recentProjects.filter((item) => item.id !== projectId);
          if (state.project?.id === projectId) {
            return {
              recentProjects,
              project: null,
              autosavedAt: null,
              dirty: false,
              lastProjectId: null,
            };
          }
          const lastProjectId =
            state.lastProjectId === projectId ? null : state.lastProjectId;
          return { recentProjects, lastProjectId };
        });
      },

      markSaved: () => set({ dirty: false, autosavedAt: Date.now() }),

      renameSession: (projectId, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        const state = get();
        // The open session renames through the normal (autosaving) path…
        if (state.project?.id === projectId) {
          state.updateProject({ name: trimmed });
        }
        // …and the sidebar list is updated immediately either way (the debounced
        // auto-save would otherwise leave the row stale for up to an interval).
        set((s) => ({
          recentProjects: s.recentProjects.map((item) =>
            item.id === projectId ? { ...item, name: trimmed } : item,
          ),
        }));
      },
    }),
    {
      name: "tafseer.projects.v1",
      version: 2,
      partialize: (state) => ({
        recentProjects: state.recentProjects,
        lastProjectId: state.lastProjectId,
      }),
      // A version bump used to make zustand discard the whole payload (losing
      // Recent Lectures). Revalidate it instead so old v1 data survives.
      migrate: (persisted) => {
        const incoming = persisted as { recentProjects?: unknown } | undefined;
        return { recentProjects: normalizeRecentProjects(incoming?.recentProjects) };
      },
      merge: (persisted, current) => {
        const incoming = persisted as {
          recentProjects?: unknown;
          lastProjectId?: unknown;
        } | undefined;
        const lastProjectId =
          typeof incoming?.lastProjectId === "string" ? incoming.lastProjectId : null;
        return {
          ...current,
          lastProjectId,
          recentProjects: Array.isArray(incoming?.recentProjects)
            ? normalizeRecentProjects(incoming.recentProjects)
            : current.recentProjects,
        };
      },
    },
  ),
);

/**
 * Debounced `.tafseer` auto-save with a max-wait: a mutation stream restarts
 * the timer, but if the last successful save is older than the interval the
 * save fires immediately, so continuous typing or trim-dragging cannot postpone
 * the journal write indefinitely. The interval comes from Settings -> Storage
 * (0 disables auto-save).
 */
export function startProjectAutosave(): () => void {
  let timer: number | undefined;
  let lastProject = useProjectStore.getState().project;
  let lastInterval = useSettingsStore.getState().storage.autosaveIntervalMs;

  const schedule = () => {
    window.clearTimeout(timer);
    const interval = useSettingsStore.getState().storage.autosaveIntervalMs;
    if (!interval || interval <= 0) return;
    // Reading `autosavedAt` from the store (instead of a closure) keeps the
    // throttle honest even when another path called `autosave()` directly.
    const savedAt = useProjectStore.getState().autosavedAt;
    const sinceLast = savedAt ? Date.now() - savedAt : interval;
    const wait = Math.max(0, interval - sinceLast);
    timer = window.setTimeout(() => {
      useProjectStore.getState().autosave();
    }, wait);
  };

  const unsubscribeProject = useProjectStore.subscribe((state) => {
    if (state.project === lastProject) return;
    lastProject = state.project;
    if (state.project) schedule();
    else window.clearTimeout(timer);
  });

  const unsubscribeSettings = useSettingsStore.subscribe((state) => {
    if (state.storage.autosaveIntervalMs === lastInterval) return;
    lastInterval = state.storage.autosaveIntervalMs;
    schedule();
  });

  const flush = () => {
    useProjectStore.getState().autosave();
  };
  window.addEventListener("beforeunload", flush);

  return () => {
    window.clearTimeout(timer);
    unsubscribeProject();
    unsubscribeSettings();
    window.removeEventListener("beforeunload", flush);
  };
}

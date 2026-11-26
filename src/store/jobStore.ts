/**
 * Background task ownership, lifted out of the wizard steps.
 *
 * The wizard swaps step components on navigation, so task state that lived in
 * `useState`/`useRef` used to vanish (and abort) the moment the editor moved.
 * This store owns the job and its `AbortController` at module scope, exactly
 * like `renderStore` owns `/render-batch`. Components are pure views.
 *
 * Results are routed by `projectId` (not by "whatever is open now"), so a job
 * started in session A can finish while session B is on screen and still land
 * in A through the `taskResults` journal.
 */

import { create } from "zustand";

import {
  queuePendingResult,
  type TaskKind,
  type TaskResultPayload,
} from "@/lib/taskResults";
import { useProjectStore } from "./projectStore";

export type TaskStatus = "running" | "done" | "error" | "cancelled";

export interface TaskJob {
  id: string;
  kind: TaskKind;
  projectId: string;
  /** Optional clip scope (used by Step 3 Arabic check). */
  clipId?: string;
  label: string;
  status: TaskStatus;
  startedAt: number;
  endedAt: number | null;
  error: string | null;
  /** Human-readable current stage streamed from the sidecar, if reported. */
  stageLabel: string | null;
  /** Determinate progress (`done`/`total`); `null` when indeterminate. */
  progress: { done: number; total: number } | null;
}

export interface TaskHooks {
  /** Report determinate batch progress. */
  setProgress: (done: number, total: number) => void;
  /** Update the current stage description (and optionally progress). */
  setStage: (
    stageLabel: string | null,
    progress?: { done: number; total: number } | null,
  ) => void;
  /** Apply a partial result to the open project immediately (no journal). */
  deliverPartial: (payload: TaskResultPayload) => void;
}

export interface StartTaskInput {
  kind: TaskKind;
  projectId: string;
  clipId?: string;
  label: string;
  run: (signal: AbortSignal, hooks: TaskHooks) => Promise<TaskResultPayload | null>;
  onSuccess?: (payload: TaskResultPayload | null) => void;
  onError?: (message: string) => void;
  onCancel?: () => void;
}

interface JobState {
  jobs: TaskJob[];
  startTask: (input: StartTaskInput) => void;
  cancelJob: (jobId: string) => void;
  cancelKind: (kind: TaskKind, projectId: string | null) => void;
  cancelAll: () => void;
  clearFinished: () => void;
}

const MAX_JOBS = 40;

/** Live controllers keyed by job id; module-level so unmounts cannot reach them. */
const controllers = new Map<string, AbortController>();

function newJobId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `job-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Apply to the open project when it matches; otherwise persist for later. */
export function deliverTaskResult(projectId: string, payload: TaskResultPayload): void {
  const store = useProjectStore.getState();
  if (store.project?.id === projectId) {
    store.applyTaskResult(projectId, payload);
  } else {
    queuePendingResult(projectId, payload);
  }
}

function deliverPartial(projectId: string, payload: TaskResultPayload): void {
  const store = useProjectStore.getState();
  if (store.project?.id === projectId) store.applyTaskResult(projectId, payload);
}

export const useJobStore = create<JobState>()((set, get) => ({
  jobs: [],

  startTask: (input) => {
    // Starting the same kind again for the same session supersedes the old run.
    const existing = get().jobs.find(
      (job) =>
        job.kind === input.kind &&
        job.projectId === input.projectId &&
        job.status === "running",
    );
    if (existing) get().cancelJob(existing.id);

    const id = newJobId();
    const controller = new AbortController();
    controllers.set(id, controller);

    const update = (patch: Partial<TaskJob>) =>
      set((state) => ({
        jobs: state.jobs.map((job) => (job.id === id ? { ...job, ...patch } : job)),
      }));

    set((state) => ({
      jobs: [
        {
          id,
          kind: input.kind,
          projectId: input.projectId,
          ...(input.clipId ? { clipId: input.clipId } : {}),
          label: input.label,
          status: "running" as const,
          startedAt: Date.now(),
          endedAt: null,
          error: null,
          stageLabel: null,
          progress: null,
        },
        ...state.jobs,
      ].slice(0, MAX_JOBS),
    }));

    const hooks: TaskHooks = {
      setProgress: (done, total) => update({ progress: { done, total } }),
      setStage: (stageLabel, progress) =>
        update({
          stageLabel,
          ...(progress !== undefined ? { progress } : {}),
        }),
      deliverPartial: (payload) => deliverPartial(input.projectId, payload),
    };

    void (async () => {
      try {
        const payload = await input.run(controller.signal, hooks);
        if (controller.signal.aborted) {
          update({ status: "cancelled", endedAt: Date.now(), stageLabel: null });
          input.onCancel?.();
          return;
        }
        update({ status: "done", endedAt: Date.now(), stageLabel: null, progress: null });
        if (payload) deliverTaskResult(input.projectId, payload);
        input.onSuccess?.(payload);
      } catch (error) {
        if (controller.signal.aborted) {
          update({ status: "cancelled", endedAt: Date.now(), stageLabel: null });
          input.onCancel?.();
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        update({
          status: "error",
          endedAt: Date.now(),
          error: message,
          stageLabel: null,
          progress: null,
        });
        input.onError?.(message);
      } finally {
        controllers.delete(id);
      }
    })();
  },

  cancelJob: (jobId) => {
    const controller = controllers.get(jobId);
    controller?.abort();
    controllers.delete(jobId);
    set((state) => ({
      jobs: state.jobs.map((job) =>
        job.id === jobId && job.status === "running"
          ? { ...job, status: "cancelled", endedAt: Date.now(), stageLabel: null }
          : job,
      ),
    }));
  },

  cancelKind: (kind, projectId) => {
    for (const job of get().jobs) {
      if (job.status !== "running") continue;
      if (job.kind !== kind) continue;
      if (projectId && job.projectId !== projectId) continue;
      get().cancelJob(job.id);
    }
  },

  cancelAll: () => {
    for (const job of get().jobs) {
      if (job.status === "running") get().cancelJob(job.id);
    }
  },

  clearFinished: () =>
    set((state) => ({ jobs: state.jobs.filter((job) => job.status === "running") })),
}));

/** The current job of a kind for a session (and optional clip), or `null`. */
export function useTaskJob(
  kind: TaskKind,
  projectId: string | null,
  clipId?: string | null,
): TaskJob | null {
  return useJobStore((state) =>
    projectId
      ? (state.jobs.find(
          (job) =>
            job.kind === kind &&
            job.projectId === projectId &&
            (clipId === undefined || job.clipId === clipId),
        ) ?? null)
      : null,
  );
}

export function runningJobs(jobs: TaskJob[]): TaskJob[] {
  return jobs.filter((job) => job.status === "running");
}

/** Re-exported so callers can import the result type from the store too. */
export type { TaskKind, TaskResultPayload } from "@/lib/taskResults";

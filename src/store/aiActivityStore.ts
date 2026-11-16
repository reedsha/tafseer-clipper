/**
 * In-memory log of recent AI-backed runs. It records which task used which
 * model on which connection — no keys, prompts, transcripts or file contents.
 * Deliberately not persisted: provenance belongs to the current session.
 */

import { create } from "zustand";

import type { AiActivityEntry, AiRunStatus } from "@/lib/aiActivity";

const MAX_ENTRIES = 20;

export type AiActivityStart = Pick<AiActivityEntry, "task" | "model" | "backend" | "detail">;

interface AiActivityState {
  entries: AiActivityEntry[];
  /** Returns the id used to finish the run. */
  start: (input: AiActivityStart) => string;
  finish: (id: string, status: Exclude<AiRunStatus, "running">, actualModel?: string) => void;
  clear: () => void;
}

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `ai-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const useAiActivityStore = create<AiActivityState>()((set) => ({
  entries: [],

  start: (input) => {
    const id = newId();
    const entry: AiActivityEntry = {
      ...input,
      id,
      status: "running",
      startedAt: Date.now(),
    };
    set((state) => ({
      entries: [entry, ...state.entries].slice(0, MAX_ENTRIES),
    }));
    return id;
  },

  finish: (id, status, actualModel) =>
    set((state) => ({
      entries: state.entries.map((entry) =>
        entry.id === id && entry.status === "running"
          ? {
              ...entry,
              status,
              finishedAt: Date.now(),
              model: actualModel?.trim() || entry.model,
            }
          : entry,
      ),
    })),

  clear: () => set({ entries: [] }),
}));

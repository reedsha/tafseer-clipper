/**
 * Provenance for work that uses an AI service.
 *
 * Labels are derived from the same settings slice that builds the request, so
 * the UI cannot advertise a different route than the one the renderer sends.
 * Nothing here is persisted — activity is per app session.
 */

export type AiTask = "transcription" | "ai-analysis" | "clip-finding" | "arabic-check";
export type AiRunStatus = "running" | "done" | "failed" | "cancelled";
export type AiBackend = "cloud" | "local";

export interface AiActivityEntry {
  id: string;
  task: AiTask;
  model: string;
  backend: AiBackend;
  /** Vendor-neutral runtime hint, e.g. "GPU" / "CPU" for local transcription. */
  detail?: string;
  status: AiRunStatus;
  startedAt: number;
  finishedAt?: number;
}

export const AI_TASK_LABEL: Record<AiTask, string> = {
  transcription: "Transcription",
  "ai-analysis": "AI analysis",
  "clip-finding": "Clip finding",
  "arabic-check": "Arabic check",
};

const STATUS_LABEL: Record<AiRunStatus, string> = {
  running: "running",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

export function aiStatusLabel(status: AiRunStatus): string {
  return STATUS_LABEL[status];
}

/** Vendor-neutral wording from the glossary ("on this computer" / "your AI account"). */
export function aiBackendLabel(backend: AiBackend): string {
  return backend === "cloud" ? "Your AI account" : "This computer";
}

export function aiTimeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export type DecisionActivitySlot = "analysis" | "verify_triage";

export interface DecisionActivitySlice {
  decisionSlots: Record<
    DecisionActivitySlot,
    { enabled: boolean; mode: "local" | "cloud"; model: string }
  >;
}

/**
 * Provenance for a step whose first pass is a fast-judgment model. `null` when
 * no model is configured and the step keeps its generative/today's route.
 */
export function decisionActivityFor(
  settings: DecisionActivitySlice,
  slot: DecisionActivitySlot,
): { model: string; backend: AiBackend; detail: string } | null {
  const config = settings.decisionSlots[slot];
  const model = config.model.trim();
  if (!model) return null;
  return {
    model,
    backend: config.mode === "local" ? "local" : "cloud",
    detail: "Fast judgments",
  };
}

export interface AiRoute {
  task: AiTask;
  model: string;
  backend: AiBackend;
}

/** The route a task will actually take, from the settings slice used to build it. */
export function aiRouteFor(
  settings: {
    transcriptionMode: "local" | "cloud";
    analysisMode: "local" | "cloud";
    whisper: { model: string };
    cloudStt: { model: string };
    cloud: { model: string };
    ollama: { model: string };
  },
  task: AiTask,
): AiRoute {
  if (task === "transcription") {
    return settings.transcriptionMode === "local"
      ? { task, model: settings.whisper.model, backend: "local" }
      : { task, model: settings.cloudStt.model || "whisper-1", backend: "cloud" };
  }
  return settings.analysisMode === "local"
    ? { task, model: settings.ollama.model, backend: "local" }
    : { task, model: settings.cloud.model, backend: "cloud" };
}

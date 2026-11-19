/**
 * Provider routing for the sidecar's LLM calls.
 *
 * The renderer never talks to OpenAI/Ollama itself (AGENTS.md §3) — it only
 * builds the `provider` override that `POST /discover-clips` and
 * `POST /verify-arabic` forward to the sidecar. Shared by Step 3 (Arabic
 * verification), the Settings provider probe and the Step 1 pre-flight guard
 * so those three cannot drift.
 *
 * There are no hard-coded services or model lists here: the connection is a
 * plain OpenAI-compatible base URL + key (Main settings), and model choices
 * are fetched live (`POST /list-models`) or scanned locally (`GET /health`).
 */

import type { DecisionProviderOverride, ProviderOverride } from "@/lib/api";
import type { DecisionSlotId, DecisionSlots } from "@/store/settingsStore";

/** The subset of `settingsStore` needed to route a provider call. */
export interface ProviderSettingsSlice {
  analysisMode: "local" | "cloud";
  ollama: { baseUrl: string; model: string };
  cloud: {
    baseUrl: string;
    apiKey: string;
    model: string;
    timeout: number;
  };
  /**
   * Optional Step 3 override. When present, non-`inherit`, and holding a model,
   * `buildProviderFor(settings, "verify")` uses this engine/model instead of
   * the shared clip-finding model. Absent on older settings records.
   */
  verificationProvider?: { mode: "inherit" | "local" | "cloud"; model: string };
}

/** The `provider` override forwarded to `/discover-clips` or `/verify-arabic`. */
export function buildProviderFor(
  settings: ProviderSettingsSlice,
  task?: "discovery" | "verify",
): ProviderOverride {
  // Step 3 may run its Arabic check on a dedicated engine/model. The connection
  // address and key are never duplicated here — they are reused from the saved
  // `ollama`/`cloud` connections (AGENTS.md §3). No override, or `inherit`,
  // falls through to the shared clip-finding model below.
  if (task === "verify") {
    const verification = settings.verificationProvider;
    if (
      verification &&
      verification.mode !== "inherit" &&
      verification.model.trim() !== ""
    ) {
      if (verification.mode === "local") {
        return {
          base_url: settings.ollama.baseUrl || null,
          api_key: "",
          model: verification.model.trim() || null,
          timeout: settings.cloud.timeout || null,
        };
      }
      return {
        base_url: settings.cloud.baseUrl || null,
        api_key: settings.cloud.apiKey || null,
        model: verification.model.trim() || null,
        timeout: settings.cloud.timeout || null,
      };
    }
  }
  if (settings.analysisMode === "local") {
    return {
      base_url: settings.ollama.baseUrl || null,
      api_key: "",
      model: settings.ollama.model || null,
      timeout: settings.cloud.timeout || null,
    };
  }
  return {
    base_url: settings.cloud.baseUrl || null,
    api_key: settings.cloud.apiKey || null,
    model: settings.cloud.model.trim() || null,
    timeout: settings.cloud.timeout || null,
  };
}

/**
 * Human-readable description of the first missing provider field, or `null`
 * when the configured engine can run. Used for local pre-flight guards so the
 * user sees "API key missing" instead of the provider's raw 401 body.
 */
export function describeProviderGap(settings: ProviderSettingsSlice): string | null {
  if (settings.analysisMode === "local") {
    return settings.ollama.model.trim() ? null : "the AI model";
  }
  if (!settings.cloud.baseUrl.trim()) return "the AI service address";
  if (!settings.cloud.apiKey.trim()) return "the API key";
  if (!settings.cloud.model.trim()) return "the AI model";
  return null;
}

/** The settings slice needed to route one fast-judgment slot. */
export interface DecisionSettingsSlice {
  decisionSlots: DecisionSlots;
  ollama: { baseUrl: string };
  cloud: { baseUrl: string; apiKey: string; timeout: number };
}

/**
 * The `decision_provider` override for one slot, or `null` when no model is
 * configured (the step then uses its standard path). Judgments are always on;
 * the address and key are reused from the saved connections — the decision
 * layer never gets a second set of credentials (AGENTS.md §3).
 */
export function buildDecisionProviderFor(
  settings: DecisionSettingsSlice,
  slot: DecisionSlotId,
): DecisionProviderOverride | null {
  const config = settings.decisionSlots[slot];
  const model = config.model.trim();
  if (!model) return null;
  const timeout = settings.cloud.timeout || null;
  const endpoint_url = config.endpointUrl.trim() || null;
  if (config.mode === "local") {
    return {
      mode: "local",
      base_url: settings.ollama.baseUrl || null,
      api_key: "",
      model,
      endpoint_style: config.format,
      endpoint_url,
      timeout,
    };
  }
  return {
    mode: "cloud",
    base_url: settings.cloud.baseUrl || null,
    api_key: settings.cloud.apiKey || null,
    model,
    endpoint_style: config.format,
    endpoint_url,
    timeout,
  };
}

/** First reason a fast-judgment slot cannot run, or `null` when it can. */
export function describeDecisionSlotGap(
  settings: DecisionSettingsSlice,
  slot: DecisionSlotId,
): string | null {
  const config = settings.decisionSlots[slot];
  if (!config.model.trim()) return "the fast-judgment model";
  if (config.mode === "local") {
    return settings.ollama.baseUrl.trim() ? null : "the local AI address";
  }
  if (!settings.cloud.baseUrl.trim()) return "the AI service address";
  if (!settings.cloud.apiKey.trim()) return "the API key";
  return null;
}

/**
 * The connection the Cloud STT engine will actually upload audio to.
 *
 * A dedicated speech service wins when configured; otherwise the shared AI
 * connection is used (OpenAI/Groq host chat and audio on one account). The
 * split exists because "OpenAI-compatible" only guarantees chat: gateways such
 * as Vercel AI Gateway and DeepSeek expose no `/audio/transcriptions` route, so
 * reusing their address made every cloud transcription fail with 404.
 */
export interface SttConnectionSettingsSlice {
  transcriptionMode: "local" | "cloud";
  cloud: { baseUrl: string; apiKey: string };
  cloudStt: { baseUrl: string; apiKey: string; model: string };
}

export interface ResolvedSttConnection {
  baseUrl: string;
  apiKey: string;
  /** True when a dedicated speech service is configured. */
  dedicated: boolean;
}

export function resolveSttConnection(
  settings: SttConnectionSettingsSlice,
): ResolvedSttConnection {
  const dedicated =
    settings.cloudStt.baseUrl.trim() !== "" || settings.cloudStt.apiKey.trim() !== "";
  if (dedicated) {
    return {
      baseUrl: settings.cloudStt.baseUrl.trim(),
      apiKey: settings.cloudStt.apiKey.trim(),
      dedicated: true,
    };
  }
  return {
    baseUrl: settings.cloud.baseUrl.trim(),
    apiKey: settings.cloud.apiKey.trim(),
    dedicated: false,
  };
}

/**
 * First missing piece of the Cloud STT setup, or `null` when it can run.
 * A dedicated speech service may be keyless (a local OpenAI-compatible
 * server), so the key is only required when the AI connection is reused.
 */
export function describeSttGap(settings: SttConnectionSettingsSlice): string | null {
  const connection = resolveSttConnection(settings);
  if (!connection.baseUrl) {
    return connection.dedicated ? "the speech service address" : "the AI service address";
  }
  if (!connection.apiKey && !connection.dedicated) return "the API key";
  if (!settings.cloudStt.model.trim()) return "the speech-to-text model";
  return null;
}

/** Human label for the honest fit verdict shown next to local models. */export function fitLabel(tier: "high" | "medium" | "low" | undefined): string {
  if (tier === "high") return "Great fit";
  if (tier === "medium") return "Workable";
  return "Too heavy";
}

export function fitSentence(tier: "high" | "medium" | "low" | undefined): string {
  if (tier === "high") return "The best local model runs comfortably here.";
  if (tier === "medium") {
    return "The best local model will be slow here — pick a mid-size one.";
  }
  return "Local AI will be painfully slow here — use a small model, or connect an AI account.";
}

/** Honest speed hint for the local speech-to-text model on this machine. */
export function whisperFitSentence(tier: "high" | "medium" | "low" | undefined): string {
  if (tier === "high") return "The best-quality model runs comfortably on this computer.";
  if (tier === "medium") {
    return "The best-quality model will be slower here — a mid-size model is a good fit.";
  }
  return "Use a small model here; the bigger ones will be slow.";
}

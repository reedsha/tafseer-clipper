/**
 * Provider routing for the sidecar's LLM calls.
 *
 * The renderer never talks to OpenAI/Ollama itself (AGENTS.md §3) — it only
 * builds the `provider` override that `POST /discover-clips` and
 * `POST /verify-arabic` forward to the sidecar. Shared by Step 3 (Arabic
 * verification), the Settings provider probe and the Step 1 pre-flight guard
 * so those three cannot drift.
 */

import type { HardwareTier, ProviderOverride } from "@/lib/api";

/** A named AI service the editor can connect with one click. */
export interface CloudPreset {
  id: string;
  label: string;
  baseUrl: string | null;
}

export const CLOUD_PRESETS: CloudPreset[] = [
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  { id: "custom", label: "Custom connection", baseUrl: null },
];

/** Which preset a stored base URL corresponds to (falls back to custom). */
export function matchCloudPreset(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  const match = CLOUD_PRESETS.find(
    (preset) => preset.baseUrl !== null && preset.baseUrl.replace(/\/+$/, "") === trimmed,
  );
  return match?.id ?? "custom";
}

/** Curated model choices; the codename stays visible in the label. */
export const CLOUD_MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: "gpt-4.1", label: "Best quality — gpt-4.1" },
  { value: "gpt-4.1-mini", label: "Balanced — gpt-4.1-mini" },
  { value: "gpt-4.1-nano", label: "Fastest — gpt-4.1-nano" },
  { value: "deepseek-chat", label: "DeepSeek — deepseek-chat" },
];

/** Local-model recommendations, keyed by capability tier (never by hardware). */
export interface LocalModelRecommendation {
  model: string;
  label: string;
  tier: HardwareTier;
}

export const OLLAMA_RECOMMENDATIONS: LocalModelRecommendation[] = [
  { model: "qwen3:14b", label: "Best quality", tier: "high" },
  { model: "qwen3:8b", label: "Balanced", tier: "medium" },
  { model: "qwen3:4b", label: "Fastest", tier: "low" },
];

export function recommendLocalModel(tier: HardwareTier | undefined): LocalModelRecommendation {
  if (tier === "high") return OLLAMA_RECOMMENDATIONS[0];
  if (tier === "medium") return OLLAMA_RECOMMENDATIONS[1];
  return OLLAMA_RECOMMENDATIONS[2];
}

/** Human label for the honest fit verdict shown next to local models. */
export function fitLabel(tier: HardwareTier | undefined): string {
  if (tier === "high") return "Great fit";
  if (tier === "medium") return "Workable";
  return "Too heavy";
}

export function fitSentence(tier: HardwareTier | undefined): string {
  if (tier === "high") return "The best local model runs comfortably here.";
  if (tier === "medium") {
    return "The best local model will be slow here — Balanced is the best fit.";
  }
  return "Local AI will be painfully slow here — use Fastest, or connect an AI account.";
}

/** Tier label for a Whisper model name, with the codename kept for reference. */
export function whisperModelLabel(model: string): string {
  switch (model) {
    case "large-v3-turbo":
      return "Best quality — large-v3-turbo";
    case "large-v3":
      return "Most accurate — large-v3";
    case "medium":
      return "Balanced — medium";
    case "small":
      return "Light — small";
    case "base":
      return "Lighter — base";
    case "tiny":
      return "Fastest — tiny";
    default:
      return model;
  }
}

/** The subset of `settingsStore` needed to route a provider call. */
export interface ProviderSettingsSlice {
  analysisMode: "local" | "cloud";
  ollama: { baseUrl: string; model: string };
  cloud: {
    baseUrl: string;
    apiKey: string;
    reasoningModel: string;
    fastTextModel: string;
    timeout: number;
  };
}

/**
 * Which model the sidecar should use: the reasoning model for clip discovery
 * (Step 2) or the fast text model for Arabic verification (Step 3).
 */
export type ProviderPurpose = "reasoning" | "fast";

function modelFor(settings: ProviderSettingsSlice, purpose: ProviderPurpose): string {
  const model =
    purpose === "reasoning" ? settings.cloud.reasoningModel : settings.cloud.fastTextModel;
  return model.trim();
}

/** The `provider` override forwarded to `/discover-clips` or `/verify-arabic`. */
export function buildProviderFor(
  settings: ProviderSettingsSlice,
  purpose: ProviderPurpose,
): ProviderOverride {
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
    model: modelFor(settings, purpose) || null,
    timeout: settings.cloud.timeout || null,
  };
}

/**
 * Human-readable description of the first missing provider field, or `null`
 * when the configured engine can run. Used for local pre-flight guards so the
 * user sees "API key missing" instead of the provider's raw 401 body.
 */
export function describeProviderGap(
  settings: ProviderSettingsSlice,
  purpose: ProviderPurpose,
): string | null {
  if (settings.analysisMode === "local") {
    return settings.ollama.model.trim() ? null : "the Ollama model name";
  }
  if (!settings.cloud.baseUrl.trim()) return "the AI service address";
  if (!settings.cloud.apiKey.trim()) return "the API key";
  if (!modelFor(settings, purpose)) {
    return purpose === "reasoning"
      ? "the clip-finding model"
      : "the Arabic-check model";
  }
  return null;
}

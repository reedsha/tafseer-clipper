/**
 * Provider routing for the sidecar's LLM calls.
 *
 * The renderer never talks to OpenAI/Ollama itself (AGENTS.md §3) — it only
 * builds the `provider` override that `POST /discover-clips` and
 * `POST /verify-arabic` forward to the sidecar. Shared by Step 3 (Arabic
 * verification), the Settings provider probe and the Step 1 pre-flight guard
 * so those three cannot drift.
 */

import type { ProviderOverride } from "@/lib/api";

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
    return settings.ollama.model.trim() ? null : "the Ollama model id";
  }
  if (!settings.cloud.baseUrl.trim()) return "the provider base URL";
  if (!settings.cloud.apiKey.trim()) return "the API key";
  if (!modelFor(settings, purpose)) {
    return purpose === "reasoning"
      ? "the reasoning model (Step 2)"
      : "the fast text model (Step 3)";
  }
  return null;
}

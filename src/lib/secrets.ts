/**
 * Desktop API key encryption helper (Windows DPAPI via Tauri commands).
 *
 * Plaintext API keys are never written into `tafseer.settings.v1` on desktop;
 * sealed blobs live in `tafseer.secrets.v1` and are unsealed on boot. In
 * browser / Playwright sessions (`!isDesktopRuntime()`), all helpers are no-ops
 * so plain browser state behaves unchanged.
 */

import { isDesktopRuntime } from "./projectFile";

const SECRETS_STORAGE_KEY = "tafseer.secrets.v1";
const SETTINGS_STORAGE_KEY = "tafseer.settings.v1";

interface SealedSecretsRecord {
  cloudApiKey?: string;
  cloudSttApiKey?: string;
}

export interface DesktopSecrets {
  cloudApiKey: string;
  cloudSttApiKey: string;
}

let persistSeq = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function protectSecret(plaintext: string): Promise<string> {
  if (!plaintext) return "";
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("protect_secret", { plaintext });
}

async function unprotectSecret(ciphertext: string): Promise<string> {
  if (!ciphertext) return "";
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string>("unprotect_secret", { ciphertext });
  } catch {
    return "";
  }
}

function readLegacyPlaintextKeys(): {
  cloudApiKey: string;
  cloudSttApiKey: string;
  hasLegacyInSettings: boolean;
} {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { cloudApiKey: "", cloudSttApiKey: "", hasLegacyInSettings: false };
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.state)) {
      return { cloudApiKey: "", cloudSttApiKey: "", hasLegacyInSettings: false };
    }
    const cloud = isRecord(parsed.state.cloud) ? parsed.state.cloud : null;
    const cloudStt = isRecord(parsed.state.cloudStt) ? parsed.state.cloudStt : null;
    const cloudApiKey = typeof cloud?.apiKey === "string" ? cloud.apiKey : "";
    const cloudSttApiKey = typeof cloudStt?.apiKey === "string" ? cloudStt.apiKey : "";
    return {
      cloudApiKey,
      cloudSttApiKey,
      hasLegacyInSettings: cloudApiKey.length > 0 || cloudSttApiKey.length > 0,
    };
  } catch {
    return { cloudApiKey: "", cloudSttApiKey: "", hasLegacyInSettings: false };
  }
}

function scrubLegacyPlaintextKeys(): void {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.state)) return;
    let changed = false;
    if (isRecord(parsed.state.cloud) && parsed.state.cloud.apiKey) {
      parsed.state.cloud.apiKey = "";
      changed = true;
    }
    if (isRecord(parsed.state.cloudStt) && parsed.state.cloudStt.apiKey) {
      parsed.state.cloudStt.apiKey = "";
      changed = true;
    }
    if (changed) {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(parsed));
    }
  } catch {
    /* Ignore malformed or restricted storage. */
  }
}

/** Seal and persist both API keys in `tafseer.secrets.v1` on desktop. */
export async function persistDesktopSecrets(
  cloudApiKey: string,
  cloudSttApiKey: string,
): Promise<void> {
  if (!isDesktopRuntime()) return;
  const seq = ++persistSeq;
  try {
    const [sealedCloud, sealedStt] = await Promise.all([
      protectSecret(cloudApiKey),
      protectSecret(cloudSttApiKey),
    ]);
    if (seq !== persistSeq) return;
    if (!sealedCloud && !sealedStt) {
      localStorage.removeItem(SECRETS_STORAGE_KEY);
      return;
    }
    const payload: SealedSecretsRecord = {};
    if (sealedCloud) payload.cloudApiKey = sealedCloud;
    if (sealedStt) payload.cloudSttApiKey = sealedStt;
    localStorage.setItem(SECRETS_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* DPAPI / storage unavailable — keep runtime working with in-memory keys. */
  }
}

/**
 * Load DPAPI-sealed API keys on desktop boot, migrating any legacy plaintext
 * keys left in `tafseer.settings.v1` and scrubbing the plaintext copy.
 */
export async function loadDesktopSecrets(): Promise<{
  secrets: DesktopSecrets;
  migrated: boolean;
}> {
  if (!isDesktopRuntime()) {
    return { secrets: { cloudApiKey: "", cloudSttApiKey: "" }, migrated: false };
  }

  let stored: SealedSecretsRecord = {};
  try {
    const raw = localStorage.getItem(SECRETS_STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) {
        stored = {
          cloudApiKey: typeof parsed.cloudApiKey === "string" ? parsed.cloudApiKey : "",
          cloudSttApiKey: typeof parsed.cloudSttApiKey === "string" ? parsed.cloudSttApiKey : "",
        };
      }
    }
  } catch {
    stored = {};
  }

  const [sealedCloudPlain, sealedSttPlain] = await Promise.all([
    unprotectSecret(stored.cloudApiKey ?? ""),
    unprotectSecret(stored.cloudSttApiKey ?? ""),
  ]);
  const legacy = readLegacyPlaintextKeys();

  const secrets: DesktopSecrets = {
    cloudApiKey: sealedCloudPlain || legacy.cloudApiKey,
    cloudSttApiKey: sealedSttPlain || legacy.cloudSttApiKey,
  };

  const needsSeal =
    (!stored.cloudApiKey && Boolean(legacy.cloudApiKey)) ||
    (!stored.cloudSttApiKey && Boolean(legacy.cloudSttApiKey));
  if (needsSeal) {
    await persistDesktopSecrets(secrets.cloudApiKey, secrets.cloudSttApiKey);
  }
  if (legacy.hasLegacyInSettings) {
    scrubLegacyPlaintextKeys();
  }

  return {
    secrets,
    migrated: needsSeal || legacy.hasLegacyInSettings,
  };
}

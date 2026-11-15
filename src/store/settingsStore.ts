import { create } from "zustand";
import { persist } from "zustand/middleware";

import { getHealth, type FontInfo, type HealthResponse } from "@/lib/api";
import {
  coerceToRange,
  NUMERIC_LIMITS,
  type NumericLimitKey,
} from "@/lib/settingsLimits";

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export type EngineMode = "local" | "cloud";
export type ComputeType = "int8" | "float16" | "float32";
export type FramingMode = "blur-fill" | "center-crop";
export type Resolution = "1920x1080" | "1080x1920";

export interface CloudProviderSettings {
  baseUrl: string;
  apiKey: string;
  reasoningModel: string;
  fastTextModel: string;
  timeout: number;
}

export interface OllamaSettings {
  baseUrl: string;
  model: string;
}

export interface CloudSttSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface WhisperSettings {
  model: string;
  computeType: ComputeType;
  autoUnload: boolean;
  initialPrompt: string;
}

export interface ArabicStyle {
  fontFamily: string;
  fontSize: number;
  color: string;
  outlineWidth: number;
  outlineColor: string;
  boxOpacity: number;
  /** Multiplier that keeps Arabic diacritics from clipping. */
  lineHeightPad: number;
  bold: boolean;
}

export interface ThaiStyle {
  fontFamily: string;
  fontSize: number;
  color: string;
  outlineWidth: number;
  outlineColor: string;
  boxOpacity: number;
  bold: boolean;
}

export interface StylePreset {
  id: string;
  name: string;
  arabic: ArabicStyle;
  thai: ThaiStyle;
}

export interface GlossaryEntry {
  id: string;
  find: string;
  replace: string;
  enabled: boolean;
}

export interface EditorDefaults {
  cutBufferSeconds: number;
  autoPad: boolean;
  filenameTemplate: string;
  maxCharsPerLine: number;
  resolution: Resolution;
  framing: FramingMode;
  useNvenc: boolean;
  exportSrt: boolean;
  language: string;
}

/** Saved editorial policies for Step 2 clip discovery. */
export interface PromptPreset {
  id: string;
  name: string;
  description: string;
  prompt: string;
  minDuration: number;
  maxDuration: number;
  maxClips: number;
}

export interface StorageSettings {
  autosaveIntervalMs: number;
  projectFolder: string;
}

export interface SidecarState {
  status: "unknown" | "checking" | "online" | "offline";
  health: HealthResponse | null;
  error: string | null;
  checkedAt: number | null;
}

export interface SettingsData {
  transcriptionMode: EngineMode;
  analysisMode: EngineMode;
  cloud: CloudProviderSettings;
  ollama: OllamaSettings;
  cloudStt: CloudSttSettings;
  whisper: WhisperSettings;
  arabic: ArabicStyle;
  thai: ThaiStyle;
  presets: StylePreset[];
  activePresetId: string | null;
  promptPresets: PromptPreset[];
  glossary: GlossaryEntry[];
  editor: EditorDefaults;
  storage: StorageSettings;
  importedFonts: FontInfo[];
  fontsDir: string | null;
}

export interface SettingsState extends SettingsData {
  sidecar: SidecarState;

  setTranscriptionMode: (mode: EngineMode) => void;
  setAnalysisMode: (mode: EngineMode) => void;
  updateCloud: (patch: Partial<CloudProviderSettings>) => void;
  updateOllama: (patch: Partial<OllamaSettings>) => void;
  updateCloudStt: (patch: Partial<CloudSttSettings>) => void;
  updateWhisper: (patch: Partial<WhisperSettings>) => void;
  updateArabic: (patch: Partial<ArabicStyle>) => void;
  updateThai: (patch: Partial<ThaiStyle>) => void;
  updateEditor: (patch: Partial<EditorDefaults>) => void;
  updateStorage: (patch: Partial<StorageSettings>) => void;

  setImportedFonts: (fonts: FontInfo[], fontsDir: string | null) => void;

  createPreset: (name: string) => string;
  renamePreset: (id: string, name: string) => void;
  deletePreset: (id: string) => void;
  applyPreset: (id: string) => void;
  /** Overwrite a preset with the current Arabic/Thai typography. */
  updatePreset: (id: string) => void;

  addPromptPreset: (preset: Omit<PromptPreset, "id">) => string;
  updatePromptPreset: (id: string, patch: Partial<Omit<PromptPreset, "id">>) => void;
  deletePromptPreset: (id: string) => void;

  addGlossaryEntry: () => void;
  updateGlossaryEntry: (id: string, patch: Partial<Omit<GlossaryEntry, "id">>) => void;
  removeGlossaryEntry: (id: string) => void;

  exportSettings: () => string;
  importSettings: (text: string) => { ok: true } | { ok: false; error: string };
  resetSettings: () => void;

  refreshHealth: (options?: { background?: boolean }) => Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Defaults                                                                    */
/* -------------------------------------------------------------------------- */

const STORAGE_KEY = "tafseer.settings.v1";
const SETTINGS_FORMAT = "tafseer-settings";

export const DEFAULT_WHISPER_PROMPT = [
  "ถ้อยคำภาษาอาหรับและศัพท์อิสลามที่พบบ่อย:",
  "อัลลอฮฺ, เราะสูลุลลอฮฺ, ศ็อลลัลลอฮุอะลัยฮิวะซัลลัม, เศาะฮาบะฮฺ,",
  "อัลกุรอาน, ซูเราะฮฺ, อายะฮฺ, หะดีษ, ตัฟซีร, ฟัรฎ์, สุนัต, หะรอม, หะลาล,",
  "ซูเราะฮฺ อัลฟาติฮะฮฺ, อัลบะเกาะเราะฮฺ, อาล อิมรอน, อันนูร, อัลกะฮ์ฟ, ยาซีน, อัรเราะฮ์มาน,",
  "บิสมิลลาฮิรเราะฮ์มานิรเราะฮีม.",
].join(" ");

const DEFAULT_ARABIC: ArabicStyle = {
  fontFamily: "Noto Naskh Arabic",
  fontSize: 64,
  color: "#dcb46e",
  outlineWidth: 2,
  outlineColor: "#0b0c0d",
  boxOpacity: 0,
  lineHeightPad: 1.35,
  bold: false,
};

const DEFAULT_THAI: ThaiStyle = {
  fontFamily: "Leelawadee UI",
  fontSize: 44,
  color: "#f4f4f1",
  outlineWidth: 3,
  outlineColor: "#0b0c0d",
  boxOpacity: 0.15,
  bold: false,
};

function preset(id: string, name: string, arabic: ArabicStyle, thai: ThaiStyle): StylePreset {
  return { id, name, arabic, thai };
}

const DEFAULT_PRESETS: StylePreset[] = [
  preset("studio-default", "Studio default", { ...DEFAULT_ARABIC }, { ...DEFAULT_THAI }),
  preset(
    "large-thai",
    "Large Thai / gold Arabic",
    { ...DEFAULT_ARABIC, fontSize: 72, color: "#e2c07c" },
    { ...DEFAULT_THAI, fontSize: 54, outlineWidth: 4 },
  ),
  preset(
    "clean-white",
    "Clean white on dark",
    { ...DEFAULT_ARABIC, color: "#f0f0ec", outlineWidth: 3 },
    { ...DEFAULT_THAI, color: "#ffffff", boxOpacity: 0.45, outlineWidth: 2 },
  ),
];

const DEFAULT_PROMPT_PRESETS: PromptPreset[] = [
  {
    id: "prompt-tiktok-hooks",
    name: "60s Emotional Hooks for TikTok",
    description: "Hook-first vertical moments for TikTok, Reels and Shorts.",
    prompt: [
      "You are a senior Islamic-studies video editor cutting Thai Tafseer lectures into vertical",
      "TikTok, Reels and Shorts. Pick self-contained, emotionally resonant moments: a Quranic",
      "verse with its Thai explanation, a moving story of the Prophets, or a heartfelt reminder.",
      "The opening three seconds must land a hook, the clip must end on a complete thought, and",
      "Arabic recitation must stay intact from start to finish. Prefer one idea per clip; skip",
      "admin, audio checks and repeated filler.",
    ].join(" "),
    minDuration: 35,
    maxDuration: 75,
    maxClips: 8,
  },
  {
    id: "prompt-fiqh-qa",
    name: "3–5 Min Fiqh Q&A for YouTube",
    description: "Full question-and-answer rulings for long-form YouTube.",
    prompt: [
      "You are a senior Islamic-studies video editor preparing YouTube excerpts from a Thai",
      "Tafseer lecture. Select practical Fiqh questions and their complete answers: the question",
      "must be audible, the reasoning complete, and the ruling clear. Keep the full exchange in",
      "one clip, never split a ruling across clips, and keep any Arabic dalil together with the",
      "Thai explanation it supports. Skip tangents and repeated examples.",
    ].join(" "),
    minDuration: 180,
    maxDuration: 300,
    maxClips: 5,
  },
  {
    id: "prompt-prophets",
    name: "Stories of the Prophets",
    description: "Complete narrative beats with the lesson intact.",
    prompt: [
      "You are a senior Islamic-studies video editor selecting story-driven segments from a Thai",
      "Tafseer lecture. Find a complete narrative beat from the stories of the Prophets: a scene,",
      "its turning point, and the lesson drawn from it. Start at the scene's opening, end on the",
      "lesson, and never cut a Quranic recitation or a hadith mid-sentence. Prefer vivid,",
      "self-contained moments over commentary about the lecture itself.",
    ].join(" "),
    minDuration: 60,
    maxDuration: 180,
    maxClips: 6,
  },
];

const DEFAULT_GLOSSARY: GlossaryEntry[] = [
  { id: "glossary-1", find: "อัลเลาะห์", replace: "อัลลอฮฺ", enabled: true },
  { id: "glossary-2", find: "ซอฮาบะห์", replace: "เศาะฮาบะฮฺ", enabled: true },
];

const DEFAULT_DATA: SettingsData = {
  transcriptionMode: "local",
  analysisMode: "cloud",
  cloud: {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    reasoningModel: "",
    fastTextModel: "",
    timeout: 120,
  },
  ollama: {
    baseUrl: "http://localhost:11434/v1",
    model: "",
  },
  cloudStt: {
    baseUrl: "",
    apiKey: "",
    model: "whisper-1",
  },
  whisper: {
    model: "large-v3-turbo",
    computeType: "int8",
    autoUnload: true,
    initialPrompt: DEFAULT_WHISPER_PROMPT,
  },
  arabic: { ...DEFAULT_ARABIC },
  thai: { ...DEFAULT_THAI },
  presets: DEFAULT_PRESETS.map((item) => ({
    ...item,
    arabic: { ...item.arabic },
    thai: { ...item.thai },
  })),
  activePresetId: "studio-default",
  promptPresets: DEFAULT_PROMPT_PRESETS.map((item) => ({ ...item })),
  glossary: DEFAULT_GLOSSARY.map((entry) => ({ ...entry })),
  editor: {
    cutBufferSeconds: 0.3,
    autoPad: true,
    filenameTemplate: "{LectureName}_Clip{01}_{Title}.mp4",
    maxCharsPerLine: 40,
    resolution: "1080x1920",
    framing: "blur-fill",
    useNvenc: true,
    exportSrt: true,
    language: "th",
  },
  storage: {
    autosaveIntervalMs: 15_000,
    projectFolder: "",
  },
  importedFonts: [],
  fontsDir: null,
};

const INITIAL_SIDECAR: SidecarState = {
  status: "unknown",
  health: null,
  error: null,
  checkedAt: null,
};

/* -------------------------------------------------------------------------- */
/* Coercion helpers (persist migrations + .json settings import)               */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Snap a persisted number to the range its control supports, so an imported
 * or older snapshot can never desync a slider from the value it shows.
 */
function asRangedNumber(value: unknown, fallback: number, key: NumericLimitKey): number {
  return coerceToRange(asNumber(value, fallback), fallback, NUMERIC_LIMITS[key]);
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asMode(value: unknown, fallback: EngineMode): EngineMode {
  return value === "local" || value === "cloud" ? value : fallback;
}

function asCompute(value: unknown, fallback: ComputeType): ComputeType {
  return value === "int8" || value === "float16" || value === "float32" ? value : fallback;
}

function asResolution(value: unknown, fallback: Resolution): Resolution {
  return value === "1920x1080" || value === "1080x1920" ? value : fallback;
}

function asFraming(value: unknown, fallback: FramingMode): FramingMode {
  return value === "blur-fill" || value === "center-crop" ? value : fallback;
}

function coerceArabic(value: unknown, fallback: ArabicStyle): ArabicStyle {
  if (!isRecord(value)) return { ...fallback };
  return {
    fontFamily: asString(value.fontFamily, fallback.fontFamily),
    fontSize: asRangedNumber(value.fontSize, fallback.fontSize, "arabicFontSize"),
    color: asString(value.color, fallback.color),
    outlineWidth: asRangedNumber(value.outlineWidth, fallback.outlineWidth, "arabicOutlineWidth"),
    outlineColor: asString(value.outlineColor, fallback.outlineColor),
    boxOpacity: asRangedNumber(value.boxOpacity, fallback.boxOpacity, "boxOpacity"),
    lineHeightPad: asRangedNumber(value.lineHeightPad, fallback.lineHeightPad, "arabicLineHeightPad"),
    bold: asBoolean(value.bold, fallback.bold),
  };
}

function coerceThai(value: unknown, fallback: ThaiStyle): ThaiStyle {
  if (!isRecord(value)) return { ...fallback };
  return {
    fontFamily: asString(value.fontFamily, fallback.fontFamily),
    fontSize: asRangedNumber(value.fontSize, fallback.fontSize, "thaiFontSize"),
    color: asString(value.color, fallback.color),
    outlineWidth: asRangedNumber(value.outlineWidth, fallback.outlineWidth, "thaiOutlineWidth"),
    outlineColor: asString(value.outlineColor, fallback.outlineColor),
    boxOpacity: asRangedNumber(value.boxOpacity, fallback.boxOpacity, "boxOpacity"),
    bold: asBoolean(value.bold, fallback.bold),
  };
}

function coercePresets(value: unknown, fallback: StylePreset[]): StylePreset[] {
  if (!Array.isArray(value)) return fallback;
  const presets: StylePreset[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = asString(item.id, "");
    const name = asString(item.name, "");
    if (!id || !name) continue;
    presets.push({
      id,
      name,
      arabic: coerceArabic(item.arabic, DEFAULT_ARABIC),
      thai: coerceThai(item.thai, DEFAULT_THAI),
    });
  }
  // An intentionally empty list must survive a restart; only a missing or
  // non-array value falls back to the built-in presets.
  return presets;
}

function coerceGlossary(value: unknown, fallback: GlossaryEntry[]): GlossaryEntry[] {
  if (!Array.isArray(value)) return fallback;
  const entries: GlossaryEntry[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const find = asString(item.find, "");
    const replace = asString(item.replace, "");
    // A row that is still being typed (only one side filled) must survive a
    // restart; only a fully blank row carries no user content and is dropped.
    if (!find.trim() && !replace.trim()) continue;
    entries.push({
      id: asString(item.id, crypto.randomUUID()),
      find,
      replace,
      enabled: asBoolean(item.enabled, true),
    });
  }
  return entries;
}

function coercePromptPresets(value: unknown, fallback: PromptPreset[]): PromptPreset[] {
  if (!Array.isArray(value)) return fallback;
  const presets: PromptPreset[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = asString(item.id, "");
    const name = asString(item.name, "");
    const prompt = asString(item.prompt, "");
    if (!id || !name || !prompt.trim()) continue;
    const minDuration = Math.max(5, asNumber(item.minDuration, 15));
    const maxDuration = Math.max(minDuration + 1, asNumber(item.maxDuration, 90));
    presets.push({
      id,
      name,
      description: asString(item.description, ""),
      prompt,
      minDuration,
      maxDuration,
      maxClips: Math.round(Math.min(50, Math.max(1, asNumber(item.maxClips, 8)))),
    });
  }
  // Deleting every prompt preset must stick across restarts.
  return presets;
}

function coerceFonts(value: unknown): FontInfo[] {
  if (!Array.isArray(value)) return [];
  const fonts: FontInfo[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const family = asString(item.family, "");
    if (!family) continue;
    fonts.push({
      family,
      style: asString(item.style, "Regular"),
      path: asString(item.path, ""),
      format: asString(item.format, "ttf"),
    });
  }
  return fonts;
}

function coerceSettingsData(raw: unknown): SettingsData {
  if (!isRecord(raw)) return structuredClone(DEFAULT_DATA);

  const cloud = isRecord(raw.cloud) ? raw.cloud : {};
  const ollama = isRecord(raw.ollama) ? raw.ollama : {};
  const cloudStt = isRecord(raw.cloudStt) ? raw.cloudStt : {};
  const whisper = isRecord(raw.whisper) ? raw.whisper : {};
  const editor = isRecord(raw.editor) ? raw.editor : {};
  const storage = isRecord(raw.storage) ? raw.storage : {};

  return {
    transcriptionMode: asMode(raw.transcriptionMode, DEFAULT_DATA.transcriptionMode),
    analysisMode: asMode(raw.analysisMode, DEFAULT_DATA.analysisMode),
    cloud: {
      baseUrl: asString(cloud.baseUrl, DEFAULT_DATA.cloud.baseUrl),
      apiKey: asString(cloud.apiKey, DEFAULT_DATA.cloud.apiKey),
      reasoningModel: asString(cloud.reasoningModel, DEFAULT_DATA.cloud.reasoningModel),
      fastTextModel: asString(cloud.fastTextModel, DEFAULT_DATA.cloud.fastTextModel),
      timeout: asNumber(cloud.timeout, DEFAULT_DATA.cloud.timeout),
    },
    ollama: {
      baseUrl: asString(ollama.baseUrl, DEFAULT_DATA.ollama.baseUrl),
      model: asString(ollama.model, DEFAULT_DATA.ollama.model),
    },
    cloudStt: {
      baseUrl: asString(cloudStt.baseUrl, DEFAULT_DATA.cloudStt.baseUrl),
      apiKey: asString(cloudStt.apiKey, DEFAULT_DATA.cloudStt.apiKey),
      model: asString(cloudStt.model, DEFAULT_DATA.cloudStt.model),
    },
    whisper: {
      model: asString(whisper.model, DEFAULT_DATA.whisper.model),
      computeType: asCompute(whisper.computeType, DEFAULT_DATA.whisper.computeType),
      autoUnload: asBoolean(whisper.autoUnload, DEFAULT_DATA.whisper.autoUnload),
      initialPrompt: asString(whisper.initialPrompt, DEFAULT_DATA.whisper.initialPrompt),
    },
    arabic: coerceArabic(raw.arabic, DEFAULT_DATA.arabic),
    thai: coerceThai(raw.thai, DEFAULT_DATA.thai),
    presets: coercePresets(raw.presets, DEFAULT_DATA.presets),
    activePresetId: typeof raw.activePresetId === "string" ? raw.activePresetId : null,
    promptPresets: coercePromptPresets(raw.promptPresets, DEFAULT_DATA.promptPresets),
    glossary: coerceGlossary(raw.glossary, DEFAULT_DATA.glossary),
    editor: {
      cutBufferSeconds: asRangedNumber(
        editor.cutBufferSeconds,
        DEFAULT_DATA.editor.cutBufferSeconds,
        "cutBufferSeconds",
      ),
      autoPad: asBoolean(editor.autoPad, DEFAULT_DATA.editor.autoPad),
      filenameTemplate: asString(editor.filenameTemplate, DEFAULT_DATA.editor.filenameTemplate),
      maxCharsPerLine: asRangedNumber(
        editor.maxCharsPerLine,
        DEFAULT_DATA.editor.maxCharsPerLine,
        "maxCharsPerLine",
      ),
      resolution: asResolution(editor.resolution, DEFAULT_DATA.editor.resolution),
      framing: asFraming(editor.framing, DEFAULT_DATA.editor.framing),
      useNvenc: asBoolean(editor.useNvenc, DEFAULT_DATA.editor.useNvenc),
      exportSrt: asBoolean(editor.exportSrt, DEFAULT_DATA.editor.exportSrt),
      language: asString(editor.language, DEFAULT_DATA.editor.language),
    },
    storage: {
      autosaveIntervalMs: asRangedNumber(
        storage.autosaveIntervalMs,
        DEFAULT_DATA.storage.autosaveIntervalMs,
        "autosaveIntervalMs",
      ),
      projectFolder: asString(storage.projectFolder, DEFAULT_DATA.storage.projectFolder),
    },
    importedFonts: coerceFonts(raw.importedFonts),
    fontsDir: typeof raw.fontsDir === "string" ? raw.fontsDir : null,
  };
}

function pickSettingsData(state: SettingsState): SettingsData {
  return {
    transcriptionMode: state.transcriptionMode,
    analysisMode: state.analysisMode,
    cloud: state.cloud,
    ollama: state.ollama,
    cloudStt: state.cloudStt,
    whisper: state.whisper,
    arabic: state.arabic,
    thai: state.thai,
    presets: state.presets,
    activePresetId: state.activePresetId,
    promptPresets: state.promptPresets,
    glossary: state.glossary,
    editor: state.editor,
    storage: state.storage,
    importedFonts: state.importedFonts,
    fontsDir: state.fontsDir,
  };
}

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

let healthRequestInFlight = false;

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      ...structuredClone(DEFAULT_DATA),
      sidecar: { ...INITIAL_SIDECAR },

      setTranscriptionMode: (mode) => set({ transcriptionMode: mode }),
      setAnalysisMode: (mode) => set({ analysisMode: mode }),

      updateCloud: (patch) => set((state) => ({ cloud: { ...state.cloud, ...patch } })),
      updateOllama: (patch) => set((state) => ({ ollama: { ...state.ollama, ...patch } })),
      updateCloudStt: (patch) => set((state) => ({ cloudStt: { ...state.cloudStt, ...patch } })),
      updateWhisper: (patch) => set((state) => ({ whisper: { ...state.whisper, ...patch } })),
      updateArabic: (patch) => set((state) => ({ arabic: { ...state.arabic, ...patch } })),
      updateThai: (patch) => set((state) => ({ thai: { ...state.thai, ...patch } })),
      updateEditor: (patch) => set((state) => ({ editor: { ...state.editor, ...patch } })),
      updateStorage: (patch) => set((state) => ({ storage: { ...state.storage, ...patch } })),

      setImportedFonts: (fonts, fontsDir) =>
        set((state) => {
          const merged = new Map(
            state.importedFonts.map((font) => [`${font.family}::${font.style}`, font]),
          );
          for (const font of fonts) merged.set(`${font.family}::${font.style}`, font);
          return {
            importedFonts: [...merged.values()].sort((a, b) =>
              a.family.localeCompare(b.family),
            ),
            fontsDir: fontsDir ?? state.fontsDir,
          };
        }),

      createPreset: (name) => {
        const id = crypto.randomUUID();
        const { arabic, thai, presets } = get();
        set({
          presets: [...presets, { id, name: name.trim() || "Untitled preset", arabic, thai }],
          activePresetId: id,
        });
        return id;
      },
      renamePreset: (id, name) =>
        set((state) => ({
          presets: state.presets.map((item) =>
            item.id === id ? { ...item, name: name.trim() || item.name } : item,
          ),
        })),
      deletePreset: (id) =>
        set((state) => ({
          presets: state.presets.filter((item) => item.id !== id),
          activePresetId: state.activePresetId === id ? null : state.activePresetId,
        })),
      applyPreset: (id) =>
        set((state) => {
          const found = state.presets.find((item) => item.id === id);
          if (!found) return {};
          return {
            arabic: { ...found.arabic },
            thai: { ...found.thai },
            activePresetId: id,
          };
        }),
      updatePreset: (id) =>
        set((state) => {
          if (!state.presets.some((item) => item.id === id)) return {};
          return {
            presets: state.presets.map((item) =>
              item.id === id
                ? { ...item, arabic: { ...state.arabic }, thai: { ...state.thai } }
                : item,
            ),
            activePresetId: id,
          };
        }),

      addPromptPreset: (preset) => {
        const id = crypto.randomUUID();
        set((state) => ({
          promptPresets: [...state.promptPresets, { ...preset, id }],
        }));
        return id;
      },
      updatePromptPreset: (id, patch) =>
        set((state) => ({
          promptPresets: state.promptPresets.map((item) =>
            item.id === id ? { ...item, ...patch } : item,
          ),
        })),
      deletePromptPreset: (id) =>
        set((state) => ({
          promptPresets: state.promptPresets.filter((item) => item.id !== id),
        })),

      addGlossaryEntry: () =>
        set((state) => ({
          glossary: [
            ...state.glossary,
            { id: crypto.randomUUID(), find: "", replace: "", enabled: true },
          ],
        })),
      updateGlossaryEntry: (id, patch) =>
        set((state) => ({
          glossary: state.glossary.map((entry) =>
            entry.id === id ? { ...entry, ...patch } : entry,
          ),
        })),
      removeGlossaryEntry: (id) =>
        set((state) => ({ glossary: state.glossary.filter((entry) => entry.id !== id) })),

      exportSettings: () =>
        JSON.stringify(
          {
            format: SETTINGS_FORMAT,
            version: 1,
            exportedAt: new Date().toISOString(),
            settings: pickSettingsData(get()),
          },
          null,
          2,
        ),

      importSettings: (text) => {
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch {
          return { ok: false, error: "This file is not valid JSON." };
        }
        if (!isRecord(payload) || payload.format !== SETTINGS_FORMAT || !isRecord(payload.settings)) {
          return { ok: false, error: "This is not a Tafseer Clipper settings backup." };
        }
        const data = coerceSettingsData(payload.settings);
        set({ ...data });
        return { ok: true };
      },

      resetSettings: () => set({ ...structuredClone(DEFAULT_DATA) }),

      refreshHealth: async (options) => {
        if (healthRequestInFlight) return;
        healthRequestInFlight = true;
        // A background poll (every 15 s) must not repaint the status LED as
        // "checking" — that made the header dot flicker amber once per tick.
        const background = options?.background === true && get().sidecar.health !== null;
        if (!background) {
          set((state) => ({ sidecar: { ...state.sidecar, status: "checking" } }));
        }
        try {
          const health = await getHealth();
          set({
            sidecar: {
              status: "online",
              health,
              error: null,
              checkedAt: Date.now(),
            },
          });
        } catch (error) {
          set({
            sidecar: {
              status: "offline",
              health: null,
              error: error instanceof Error ? error.message : String(error),
              checkedAt: Date.now(),
            },
          });
        } finally {
          healthRequestInFlight = false;
        }
      },
    }),
    {
      name: STORAGE_KEY,
      // v2 keeps persisted configuration alive across schema bumps instead of
      // letting zustand discard it (which silently wiped API keys, glossary,
      // fonts and presets). `migrate` re-runs the same coercion the merge does.
      version: 2,
      migrate: (persisted) => coerceSettingsData(persisted),
      partialize: (state) => pickSettingsData(state),
      merge: (persisted, current) => ({
        ...current,
        ...coerceSettingsData(persisted),
        sidecar: current.sidecar,
      }),
    },
  ),
);

import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Drawer } from "vaul";
import NumberFlow from "@number-flow/react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Bot,
  Copy,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  HardDrive,
  Languages,
  Loader2,
  MoveRight,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  SlidersHorizontal,
  Trash2,
  Type,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "cn";

import { GpuAccelerationPanel, GpuStatusLine } from "@/components/GpuAcceleration";
import { FitBadge } from "@/components/FitBadge";
import { SidecarStatusDot, SIDECAR_STATUS_LABEL } from "@/components/SidecarStatusDot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { importFonts, verifyArabic } from "@/lib/api";
import { describeAcceleration, isGpuEncodingAvailable } from "@/lib/acceleration";
import { buildDiagnostics, copyText } from "@/lib/diagnostics";
import {
  sanitizeFileNameTemplate,
  TEMPLATE_TOKEN_HINTS,
  unknownTemplateTokens,
} from "@/lib/filenameTemplate";
import { formatBytes } from "@/lib/format";
import { loadImportedFonts } from "@/lib/fonts";
import type { HardwareTier } from "@/lib/api";
import { isTauriRuntime, openDirectory, openExternalUrl } from "@/lib/media";
import type { Resolution } from "@/lib/projectTypes";
import {
  buildProviderFor,
  CLOUD_MODEL_OPTIONS,
  CLOUD_PRESETS,
  describeProviderGap,
  fitSentence,
  matchCloudPreset,
  recommendLocalModel,
  whisperModelLabel,
} from "@/lib/providers";
import { coerceToRange, NUMERIC_LIMITS } from "@/lib/settingsLimits";
import { estimateThaiLineFit } from "@/lib/subtitleWidth";
import {
  checkForUpdates,
  downloadAndInstall,
  getPendingUpdate,
  getUpdaterStatus,
  relaunchApp,
  useUpdaterStatus,
  type UpdaterStatus,
} from "@/lib/updater";
import { useProjectStore } from "@/store/projectStore";
import {
  useSettingsStore,
  type ArabicStyle,
  type EngineMode,
  type StylePreset,
  type ThaiStyle,
  type UiLanguage,
} from "@/store/settingsStore";
import type { SettingsTab } from "@/store/uiStore";
import { useUiStore } from "@/store/uiStore";

/* -------------------------------------------------------------------------- */
/* Layout helpers                                                              */
/* -------------------------------------------------------------------------- */

function Section({
  title,
  description,
  badge,
  children,
}: {
  title: string;
  description?: string;
  /** State marker rendered beside the heading ("In use" / "Not used"). */
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-[13px] font-medium text-foreground">{title}</h3>
          {description ? (
            <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {badge ? <div className="shrink-0 pt-0.5">{badge}</div> : null}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <Label className="text-xs font-medium text-foreground/90">{label}</Label>
        {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

function SwitchRow({
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border border-border bg-card/40 px-3 py-2.5">
      <div className="space-y-0.5">
        <p className="text-xs font-medium text-foreground/90">{label}</p>
        {description ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-label={label}
      />
    </div>
  );
}

/** Password-style field with an explicit reveal toggle. */
function SecretInput({
  value,
  onChange,
  label,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        autoComplete="off"
        spellCheck={false}
        className="pr-9"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="absolute right-1 top-1/2 -translate-y-1/2"
        aria-label={visible ? `Hide ${label}` : `Show ${label}`}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </Button>
    </div>
  );
}

/**
 * Slider plus an exact-value read-out. The read-out stays a NumberFlow (the
 * contract's animated-number primitive) and doubles as a trigger: clicking it
 * opens a shadcn Popover so a precise value can be typed instead of nudged.
 */
function NumberField({
  value,
  onChange,
  suffix,
  min,
  max,
  step = 1,
  ariaLabel,
}: {
  value: number;
  onChange: (value: number) => void;
  suffix: string;
  min: number;
  max: number;
  step?: number;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const unit = suffix.trim();
  const rangeText =
    unit === "%" ? `${min}–${max}%` : unit ? `${min}–${max} ${unit}` : `${min}–${max}`;

  // Typed values go through the same coerce/snap path as an imported snapshot,
  // so a typed 500 lands on the slider's maximum instead of a dead control.
  function commit() {
    const parsed = Number(draft.replace(",", "."));
    if (Number.isFinite(parsed)) {
      onChange(coerceToRange(parsed, value, { min, max, step }));
    }
    setOpen(false);
  }

  return (
    <div className="flex items-center gap-3" data-vaul-no-drag>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([next]) => onChange(next)}
        aria-label={ariaLabel}
      />
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setDraft(String(value));
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="h-6 w-16 shrink-0 justify-end px-1.5 text-xs font-normal tabular-nums text-foreground/90"
            aria-label={`Type an exact value for ${ariaLabel}`}
            title="Type an exact value"
          >
            <NumberFlow
              value={value}
              suffix={suffix}
              format={{ maximumFractionDigits: step < 1 ? 2 : 0 }}
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          sideOffset={6}
          className="w-56 space-y-2 p-3"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
            inputRef.current?.select();
          }}
        >
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              commit();
            }}
          >
            <Label htmlFor={inputId} className="text-[11px] font-medium text-foreground">
              {ariaLabel}
            </Label>
            <Input
              id={inputId}
              ref={inputRef}
              value={draft}
              inputMode={step < 1 ? "decimal" : "numeric"}
              autoComplete="off"
              spellCheck={false}
              aria-label={ariaLabel}
              onChange={(event) => setDraft(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              className="h-8 text-xs"
            />
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              {rangeText} · snaps to {step}
            </p>
            <Button type="submit" size="sm" className="w-full">
              Set
            </Button>
          </form>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * Width sanity check for the pair that decides how wide a Thai line renders:
 * `maxCharsPerLine` x the Thai font size. The `.ass` column is the frame
 * minus its side margins, so a line past it reaches the frame edge.
 */
function LineWidthHint({
  fontFamily,
  fontSize,
  maxChars,
  bold,
  resolution,
  onUseSuggestion,
}: {
  fontFamily: string;
  fontSize: number;
  maxChars: number;
  bold: boolean;
  resolution: Resolution;
  onUseSuggestion: (chars: number) => void;
}) {
  const fit = estimateThaiLineFit({
    fontFamily,
    fontSize,
    maxChars,
    resolution,
    bold,
  });
  const percent = Math.round(fit.fill * 100);

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-[11px]">
        <span className="text-muted-foreground">Widest line at this size</span>
        <span
          className={cn(
            "tabular-nums",
            fit.fits ? "text-foreground/80" : "text-status-warning",
          )}
        >
          <NumberFlow value={percent} suffix="%" /> of the column
        </span>
      </div>
      {fit.fits ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-status-warning">
            A full line runs past the subtitle column, so subtitle text can reach
            the frame edge. Shorten the line or reduce the font size.
          </p>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => onUseSuggestion(fit.suggestedMaxChars)}
          >
            Use {fit.suggestedMaxChars} chars
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Tier-first model chooser: the curated labels lead with plain-language quality
 * tiers and keep the codename visible, with a free-text escape hatch for any
 * OpenAI-compatible service.
 */
function ModelPicker({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  const known = CLOUD_MODEL_OPTIONS.some((option) => option.value === value);
  const [custom, setCustom] = useState(!known);

  return (
    <div className="space-y-1.5">
      <Select
        value={custom ? "custom" : value}
        onValueChange={(next) => {
          if (next === "custom") {
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange(next);
        }}
      >
        <SelectTrigger className="w-full" aria-label={label}>
          <SelectValue placeholder="Choose a model" />
        </SelectTrigger>
        <SelectContent>
          {CLOUD_MODEL_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
          <SelectItem value="custom">Custom model name…</SelectItem>
        </SelectContent>
      </Select>
      {custom ? (
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Paste the model name from your AI service"
          aria-label={`${label} (custom)`}
          spellCheck={false}
          className="text-xs"
        />
      ) : null}
    </div>
  );
}

/** Marks a provider block the current engine routing does (not) call. */
function UsageBadge({ active }: { active: boolean }) {
  return active ? (
    <Badge variant="secondary" className="text-[10px]">
      In use
    </Badge>
  ) : (
    <Badge variant="outline" className="text-[10px] text-muted-foreground">
      Not used
    </Badge>
  );
}

/* -------------------------------------------------------------------------- */
/* Content constants                                                           */
/* -------------------------------------------------------------------------- */

const TABS: { value: SettingsTab; label: string; icon: LucideIcon }[] = [
  { value: "providers", label: "AI", icon: Bot },
  { value: "fonts", label: "Fonts & Style", icon: Type },
  { value: "glossary", label: "Glossary & transcription", icon: Languages },
  { value: "editor", label: "Editor & Export", icon: SlidersHorizontal },
  { value: "storage", label: "Storage & Backup", icon: HardDrive },
];

const ARABIC_COLORS = [
  { value: "#dcb46e", label: "Warm gold" },
  { value: "#e2c07c", label: "Pale gold" },
  { value: "#f0f0ec", label: "Soft white" },
];

const THAI_COLORS = [
  { value: "#f4f4f1", label: "Crisp white" },
  { value: "#efece4", label: "Warm white" },
  { value: "#dcb46e", label: "Gold" },
];

const SYSTEM_FONTS = [
  "Leelawadee UI",
  "Tahoma",
  "Noto Naskh Arabic",
  "Traditional Arabic",
  "Segoe UI",
];

const AUTOSAVE_OPTIONS = [
  { value: "0", label: "Off" },
  { value: "5000", label: "Every 5 seconds" },
  { value: "15000", label: "Every 15 seconds" },
  { value: "30000", label: "Every 30 seconds" },
  { value: "60000", label: "Every minute" },
];

const SHORTCUTS = [
  { keys: "Space", action: "Play / pause" },
  { keys: "J K L", action: "Shuttle backward / pause / forward" },
  { keys: "← →", action: "Nudge 0.2s" },
  { keys: "Ctrl Enter", action: "Split subtitle at cursor" },
  { keys: "Ctrl K", action: "Command palette" },
];

/** Named sidecar models, plus a Custom escape hatch for anything else. */
const WHISPER_MODELS = [
  { value: "large-v3-turbo", label: whisperModelLabel("large-v3-turbo") },
  { value: "large-v3", label: whisperModelLabel("large-v3") },
  { value: "medium", label: whisperModelLabel("medium") },
  { value: "small", label: whisperModelLabel("small") },
  { value: "base", label: whisperModelLabel("base") },
  { value: "tiny", label: whisperModelLabel("tiny") },
];

/** Honest speed hint for the local transcription model on this machine. */
function whisperFitSentence(tier: HardwareTier | undefined): string {
  if (tier === "high") return "Best quality runs comfortably on this computer.";
  if (tier === "medium") {
    return "Best quality will be slower here — Balanced is a good fit.";
  }
  return "Use Fastest here; the better models will be slow.";
}

/** True when every Arabic/Thai field still equals the saved preset. */
function presetMatchesStyle(
  preset: StylePreset,
  arabic: ArabicStyle,
  thai: ThaiStyle,
): boolean {
  return (
    (Object.keys(arabic) as (keyof ArabicStyle)[]).every(
      (key) => preset.arabic[key] === arabic[key],
    ) &&
    (Object.keys(thai) as (keyof ThaiStyle)[]).every((key) => preset.thai[key] === thai[key])
  );
}

/** Date-stamped backup name so two exports never overwrite each other. */
function settingsBackupFileName(now = new Date()): string {
  return `tafseer-settings-${now.toISOString().slice(0, 10)}.json`;
}

function withCurrentColor(
  options: { value: string; label: string }[],
  current: string,
): { value: string; label: string }[] {
  return options.some((option) => option.value === current)
    ? options
    : [...options, { value: current, label: `Custom (${current})` }];
}

/** Human-readable label for an auto-save interval outside the preset list. */
function formatIntervalLabel(ms: number): string {
  if (ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return `Custom (${minutes} min)`;
  }
  if (ms % 1_000 === 0) return `Custom (${ms / 1_000} s)`;
  return `Custom (${ms} ms)`;
}

/**
 * Keep the interval Select honest for values that are not one of the presets:
 * an imported or migrated interval must render as a label, never as a blank
 * trigger with no visible value.
 */
function withCurrentInterval(
  options: { value: string; label: string }[],
  currentMs: number,
): { value: string; label: string }[] {
  const value = String(currentMs);
  return options.some((option) => option.value === value)
    ? options
    : [...options, { value, label: formatIntervalLabel(currentMs) }];
}

/** The 0–100 % view of the stored 0–1 box-opacity fraction. */
const BOX_OPACITY_PERCENT = {
  min: NUMERIC_LIMITS.boxOpacity.min * 100,
  max: NUMERIC_LIMITS.boxOpacity.max * 100,
  step: NUMERIC_LIMITS.boxOpacity.step * 100,
};

function downloadJson(text: string, fileName: string): void {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

/** One-line status under the updater buttons (toasts carry the detail). */
function updaterStatusText(status: UpdaterStatus): ReactNode {
  switch (status.phase) {
    case "checking":
      return "Checking the release channel…";
    case "up-to-date":
      return status.currentVersion
        ? `You are running the latest version (v${status.currentVersion}).`
        : "You are running the latest version.";
    case "available":
      return `Version ${status.version ?? "unknown"} is available. Install & restart when convenient — nothing installs automatically.`;
    case "downloading":
      return status.progress === null ? (
        "Downloading the update…"
      ) : (
        <span className="inline-flex items-baseline gap-1">
          <span>Downloading the update…</span>
          <NumberFlow
            value={Math.round(status.progress * 100)}
            suffix="%"
            format={{ maximumFractionDigits: 0 }}
          />
        </span>
      );
    case "installing":
      return "Installing the update. The app restarts when it finishes.";
    case "unsupported":
      return "Updates are available in the installed desktop app.";
    case "error":
      return `Update check failed: ${status.message ?? "unknown error"}`;
    default:
      return "Not checked in this session.";
  }
}

function ColorSelect({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  label: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {withCurrentColor(options, value).map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <span className="flex items-center gap-2">
              <span
                className="size-3 rounded-full border border-border"
                style={{ backgroundColor: option.value }}
              />
              {option.label}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/* -------------------------------------------------------------------------- */
/* Drawer                                                                      */
/* -------------------------------------------------------------------------- */

export function SettingsDrawer() {
  const settingsOpen = useUiStore((state) => state.settingsOpen);
  const settingsTab = useUiStore((state) => state.settingsTab);
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);
  const openSettings = useUiStore((state) => state.openSettings);

  const {
    transcriptionMode,
    analysisMode,
    cloud,
    ollama,
    cloudStt,
    whisper,
    arabic,
    thai,
    presets,
    activePresetId,
    glossary,
    editor,
    storage,
    importedFonts,
    fontsDir,
    sidecar,
    uiLanguage,
    setTranscriptionMode,
    setAnalysisMode,
    setUiLanguage,
    updateCloud,
    updateOllama,
    updateCloudStt,
    updateWhisper,
    updateArabic,
    updateThai,
    updateEditor,
    updateStorage,
    setImportedFonts,
    createPreset,
    renamePreset,
    deletePreset,
    applyPreset,
    updatePreset,
    addGlossaryEntry,
    updateGlossaryEntry,
    removeGlossaryEntry,
    exportSettings,
    importSettings,
    resetSettings,
    refreshHealth,
  } = useSettingsStore();

  const fontInputRef = useRef<HTMLInputElement>(null);
  const settingsInputRef = useRef<HTMLInputElement>(null);
  const [importingFonts, setImportingFonts] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);

  // Updater state is a module-level snapshot so the silent startup check and
  // this panel always agree; in a plain browser the plugin is never loaded.
  const updater = useUpdaterStatus();
  const desktopRuntime = isTauriRuntime();
  const updaterBusy = updater.phase === "checking" || updater.phase === "downloading";

  const project = useProjectStore((state) => state.project);
  const applyExportDefaults = useProjectStore((state) => state.applyExportDefaults);
  const lastAutosaveError = useProjectStore((state) => state.lastAutosaveError);

  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [customWhisperModel, setCustomWhisperModel] = useState(false);

  const fontFamilies = useMemo(() => {
    const families = new Set(SYSTEM_FONTS);
    for (const font of importedFonts) families.add(font.family);
    return [...families].sort((a, b) => a.localeCompare(b));
  }, [importedFonts]);

  /**
   * Rows where the replacement is typed but the match text is missing cannot
   * be applied (Step 1 skips them). They survive a restart now, so the panel
   * has to say why they are inert instead of letting them look active.
   */
  const incompleteGlossaryCount = glossary.filter(
    (entry) => entry.replace.trim() !== "" && !entry.find.trim(),
  ).length;

  /** Rename can only do something when the trimmed name is new and non-empty. */
  const renamingPreset = renamingId
    ? presets.find((item) => item.id === renamingId) ?? null
    : null;
  const renameUnchanged = !renameValue.trim() || renameValue.trim() === renamingPreset?.name;

  /** First missing provider field for the Step 3 fast-model probe, if any. */
  const providerGap = describeProviderGap({ analysisMode, ollama, cloud }, "fast");
  const activePreset = activePresetId
    ? presets.find((item) => item.id === activePresetId) ?? null
    : null;
  /** The live style drifted from the preset it claims to be. */
  const activePresetModified = activePreset
    ? !presetMatchesStyle(activePreset, arabic, thai)
    : false;
  const whisperModelIsPreset = WHISPER_MODELS.some((item) => item.value === whisper.model);
  const showCustomWhisperModel = customWhisperModel || !whisperModelIsPreset;
  const templateTokens = unknownTemplateTokens(editor.filenameTemplate);
  const cloudSttIncomplete = !cloudStt.baseUrl.trim() || !cloudStt.apiKey.trim();
  const ollamaIncomplete = !ollama.model.trim();

  const health = sidecar.health;
  const hardwareTier: HardwareTier | undefined = health?.hardware?.tier;
  const ollamaStatus = health?.providers?.ollama;
  const ollamaDetected = ollamaStatus?.detected === true;
  const ollamaModels = ollamaStatus?.models ?? [];
  const recommendedLocal = recommendLocalModel(hardwareTier);
  const cloudPresetId = matchCloudPreset(cloud.baseUrl);
  /** Vendor-neutral acceleration state derived from GET /health. */
  const acceleration = describeAcceleration(health);

  async function handleFontFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setImportingFonts(true);
    try {
      const result = await importFonts(Array.from(files));
      setImportedFonts(result.fonts, result.fonts_dir);
      // Make the new faces resolvable in the Step 3 preview (asset protocol).
      void loadImportedFonts(result.fonts);
      toast.success("Custom font imported", {
        description: result.imported_fonts.join(", "),
      });
    } catch (error) {
      toast.error("Font import failed", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setImportingFonts(false);
      if (fontInputRef.current) fontInputRef.current.value = "";
    }
  }

  /**
   * Test Connection = sidecar health ping + one tiny provider probe through
   * the allowed `POST /verify-arabic` endpoint. No extra endpoint is added:
   * the sidecar performs the provider call, exactly as Step 3 does.
   */
  async function handleTestConnection() {
    if (testingConnection) return;
    setTestingConnection(true);
    try {
      await refreshHealth();
      const current = useSettingsStore.getState();
      if (current.sidecar.status !== "online" || !current.sidecar.health) {
        toast.error("The processing engine isn't responding", {
          description: current.sidecar.error ?? "Click Retry, or restart the app.",
        });
        return;
      }

      const gap = describeProviderGap(current, "fast");
      if (gap) {
        toast.error("The AI connection isn't set up yet", {
          description: `Add ${gap} below, then check again.`,
        });
        return;
      }

      const result = await verifyArabic(
        {
          arabic_text: "بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ",
          context_thai: "",
          provider: buildProviderFor(current, "fast"),
        },
        { timeoutMs: 20_000 },
      );

      toast.success("Connected", {
        description: `${result.model || "The model"} answered · ${
          result.correction_applied ? "correction applied" : "text unchanged"
        }`,
      });
    } catch (error) {
      toast.error("Connection check failed", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTestingConnection(false);
    }
  }

  async function handleGetOllama() {
    const opened = await openExternalUrl("https://ollama.com/download");
    if (opened) return;
    const copied = await copyText("https://ollama.com/download");
    toast(copied ? "Download link copied" : "Open ollama.com/download", {
      description: "Install Ollama, then use Check again.",
    });
  }

  async function handleInstallLocalModel() {
    const command = `ollama pull ${recommendedLocal.model}`;
    const copied = await copyText(command);
    toast(copied ? "Command copied" : command, {
      description: "Paste it into a terminal, then use Check again.",
    });
    if (!ollamaDetected) void openExternalUrl("https://ollama.com/download");
  }

  async function handleSettingsImport(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    try {
      const result = importSettings(await file.text());
      if (result.ok) {
        syncOpenProjectExportDefaults();
        // A backup carries font names, not font files; re-register the ones that
        // are actually present so the Step 3 preview can resolve them again.
        const { importedFonts: restoredFonts } = useSettingsStore.getState();
        if (restoredFonts.length > 0) void loadImportedFonts(restoredFonts);
        toast.success("Settings imported", {
          description:
            restoredFonts.length > 0
              ? "Font names were restored — re-import any .ttf/.otf files that are missing."
              : undefined,
        });
      } else {
        toast.error("Import failed", { description: result.error });
      }
    } catch (error) {
      toast.error("Import failed", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (settingsInputRef.current) settingsInputRef.current.value = "";
    }
  }

  function handleExportSettings() {
    downloadJson(exportSettings(), settingsBackupFileName());
    toast.success("Settings exported", {
      description: "Includes API keys in plain text — keep the file private.",
    });
  }

  /**
   * Import and reset replace the whole settings snapshot in one `set()`, so the
   * per-field handlers that normally push export defaults into the open project
   * never ran. Re-sync explicitly or the drawer shows new defaults while the
   * project keeps rendering with the old ones.
   */
  function syncOpenProjectExportDefaults() {
    const { editor: next } = useSettingsStore.getState();
    applyExportDefaults({
      resolution: next.resolution,
      framing: next.framing,
      useNvenc: next.useNvenc,
      exportSrt: next.exportSrt,
      filenameTemplate: next.filenameTemplate,
    });
  }

  /* ----------------------------- Updates ----------------------------- */

  async function handleCheckForUpdates() {
    if (getUpdaterStatus().phase === "checking") return;
    const result = await checkForUpdates();
    if ("error" in result) {
      toast.error("Update check failed", {
        description: result.error,
      });
      return;
    }
    if (result.available) {
      toast.success(`Version ${result.version} is available`, {
        description: result.notes
          ? result.notes.split("\n")[0]
          : "Download and install from this panel when convenient.",
      });
      return;
    }
    toast.success("You are up to date", {
      description: result.currentVersion
        ? `Tafseer Clipper v${result.currentVersion} is the latest release.`
        : "No newer release was announced.",
    });
  }

  async function handleInstallUpdate() {
    if (installingUpdate) return;
    const pending = getPendingUpdate();
    if (!pending) {
      toast.error("No update is staged", {
        description: "Check for updates again before installing.",
      });
      return;
    }
    setInstallingUpdate(true);
    try {
      const result = await downloadAndInstall(pending);
      if ("error" in result) {
        toast.error("Update failed", { description: result.error });
        return;
      }
      toast.success("Update installed", {
        description: "Restarting Tafseer Clipper to finish the install.",
      });
      try {
        await relaunchApp();
      } catch (error) {
        toast.error("Restart failed", {
          description:
            error instanceof Error
              ? error.message
              : "Close and reopen the app to finish the update.",
        });
      }
    } finally {
      setInstallingUpdate(false);
    }
  }

  /* ---------------------------- Diagnostics ---------------------------- */

  async function handleCopyDiagnostics() {
    if (diagnosticsBusy) return;
    setDiagnosticsBusy(true);
    try {
      const bundle = await buildDiagnostics({
        health,
        sidecarStatus: sidecar.status,
        sidecarError: sidecar.error,
        projectFolder: storage.projectFolder,
        lastAutosaveError,
      });
      const copied = await copyText(bundle);
      if (copied) {
        toast.success("Diagnostics copied", {
          description: "Paste it into your support request. No API keys are included.",
        });
      } else {
        toast.error("Could not copy diagnostics", {
          description: "The clipboard is unavailable in this window.",
        });
      }
    } catch (error) {
      toast.error("Could not build diagnostics", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDiagnosticsBusy(false);
    }
  }

  return (
    <Drawer.Root
      open={settingsOpen}
      onOpenChange={setSettingsOpen}
      direction="right"
      shouldScaleBackground={false}
    >
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[1px]" />
        <Drawer.Content
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col border-l border-border bg-background outline-none"
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div className="space-y-0.5">
              <Drawer.Title className="text-sm font-medium text-foreground">
                Settings
              </Drawer.Title>
              <Drawer.Description className="text-xs text-muted-foreground">
                Power-user configuration. Changes save automatically.
              </Drawer.Description>
            </div>
            <Drawer.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close settings">
                <X className="size-4" />
              </Button>
            </Drawer.Close>
          </div>

          <Tabs
            value={settingsTab}
            onValueChange={(value) => openSettings(value as SettingsTab)}
            className="min-h-0 flex-1 gap-0"
          >
            <div className="overflow-x-auto border-b border-border px-3" data-vaul-no-drag>
              <TabsList variant="line" className="h-10 w-max justify-start gap-1 px-0">
                {TABS.map(({ value, label, icon: Icon }) => (
                  <TabsTrigger key={value} value={value} className="gap-1.5 px-2.5 text-xs">
                    <Icon className="size-3.5" />
                    {label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>

            {/* ------------------------------ Providers ------------------------------ */}
            <TabsContent value="providers" className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              <div className="space-y-5">
                <Section title="Engine routing">
                  <Field label="Transcription engine">
                    <Select
                      value={transcriptionMode}
                      onValueChange={(value) => setTranscriptionMode(value as EngineMode)}
                    >
                      <SelectTrigger className="w-full" aria-label="Transcription engine">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="local">This computer (offline)</SelectItem>
                        <SelectItem value="cloud">Cloud speech-to-text</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Topic analysis engine">
                    <Select
                      value={analysisMode}
                      onValueChange={(value) => setAnalysisMode(value as EngineMode)}
                    >
                      <SelectTrigger className="w-full" aria-label="Topic analysis engine">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="cloud">Your AI account</SelectItem>
                        <SelectItem value="local">This computer (Ollama)</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </Section>

                <Separator />

                <Section
                  title="Your AI account"
                  description="Used for finding clips and checking the Arabic."
                  badge={<UsageBadge active={analysisMode === "cloud"} />}
                >
                  <Field label="Service">
                    <Select
                      value={cloudPresetId}
                      onValueChange={(value) => {
                        const preset = CLOUD_PRESETS.find((item) => item.id === value);
                        if (preset?.baseUrl) updateCloud({ baseUrl: preset.baseUrl });
                      }}
                    >
                      <SelectTrigger className="w-full" aria-label="AI service">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CLOUD_PRESETS.map((preset) => (
                          <SelectItem key={preset.id} value={preset.id}>
                            {preset.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  {cloudPresetId === "custom" ? (
                    <Field label="Server address">
                      <Input
                        value={cloud.baseUrl}
                        onChange={(event) => updateCloud({ baseUrl: event.target.value })}
                        placeholder="https://api.openai.com/v1"
                        aria-label="Cloud API server address"
                        spellCheck={false}
                        autoComplete="off"
                      />
                    </Field>
                  ) : null}
                  <Field label="API key">
                    {/* Chromium logs a password-manager warning for a
                        `type="password"` field outside a form; this one is
                        inert (implicit submits are cancelled). */}
                    <form onSubmit={(event) => event.preventDefault()}>
                      <SecretInput
                        label="Cloud API key"
                        value={cloud.apiKey}
                        onChange={(value) => updateCloud({ apiKey: value })}
                        placeholder="sk-…"
                      />
                    </form>
                  </Field>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Model for finding clips">
                      <ModelPicker
                        label="Clip-finding model"
                        value={cloud.reasoningModel}
                        onChange={(value) => updateCloud({ reasoningModel: value })}
                      />
                    </Field>
                    <Field label="Model for checking Arabic">
                      <ModelPicker
                        label="Arabic-check model"
                        value={cloud.fastTextModel}
                        onChange={(value) => updateCloud({ fastTextModel: value })}
                      />
                    </Field>
                  </div>
                  {analysisMode === "cloud" && providerGap ? (
                    <p className="text-[11px] leading-relaxed text-status-warning">
                      The Arabic checker isn't set up yet: add {providerGap}.
                    </p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => void handleTestConnection()}
                      disabled={testingConnection}
                    >
                      {testingConnection ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="size-3.5" />
                      )}
                      Test connection
                    </Button>
                    <span className="text-[11px] text-muted-foreground">
                      Checks the connection, then asks{" "}
                      {analysisMode === "local"
                        ? "your Ollama model"
                        : "your AI account"}{" "}
                      to verify one Arabic verse.
                    </span>
                  </div>
                </Section>

                <Separator />

                <Section
                  title="This computer (Ollama)"
                  description="Runs clip finding on this computer, offline."
                  badge={<UsageBadge active={analysisMode === "local"} />}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="gap-1.5 text-[10px]">
                      <span
                        aria-hidden
                        className={cn(
                          "size-1.5 rounded-full",
                          ollamaDetected ? "bg-status-online" : "bg-muted-foreground/50",
                        )}
                      />
                      {ollamaDetected ? "Ollama found" : "Ollama not found"}
                    </Badge>
                    <FitBadge tier={hardwareTier} />
                    <Button
                      variant="ghost"
                      size="xs"
                      className="h-5 text-muted-foreground"
                      onClick={() => void refreshHealth()}
                    >
                      Check again
                    </Button>
                  </div>

                  {hardwareTier ? (
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      This computer: {fitSentence(hardwareTier)} Recommended:{" "}
                      {recommendedLocal.label} ({recommendedLocal.model}).
                    </p>
                  ) : null}

                  {ollamaDetected ? (
                    ollamaModels.length > 0 ? (
                      <Field label="Model">
                        <Select
                          value={ollama.model || undefined}
                          onValueChange={(value) => updateOllama({ model: value })}
                        >
                          <SelectTrigger className="w-full" aria-label="Ollama model">
                            <SelectValue placeholder="Choose an installed model" />
                          </SelectTrigger>
                          <SelectContent>
                            {ollamaModels.map((name) => (
                              <SelectItem key={name} value={name}>
                                {name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                    ) : (
                      <p className="text-[11px] leading-relaxed text-status-warning">
                        Ollama is installed but has no AI models yet.
                      </p>
                    )
                  ) : (
                    <div className="space-y-2 rounded-md border border-border bg-card/40 px-3 py-2.5">
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        Ollama isn't installed yet. It's free and runs everything offline.
                      </p>
                      <ol className="list-decimal space-y-0.5 pl-4 text-[11px] leading-relaxed text-muted-foreground">
                        <li>Install Ollama.</li>
                        <li>Install the recommended model.</li>
                        <li>Come back and press Check again.</li>
                      </ol>
                      <div className="flex flex-wrap gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1.5"
                          onClick={() => void handleGetOllama()}
                        >
                          <Download className="size-3.5" />
                          Get Ollama
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="gap-1.5"
                          onClick={() => void handleInstallLocalModel()}
                        >
                          Install a recommended model
                        </Button>
                      </div>
                    </div>
                  )}

                  {ollamaDetected && ollamaModels.length === 0 ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => void handleInstallLocalModel()}
                    >
                      <Download className="size-3.5" />
                      Install a recommended model
                    </Button>
                  ) : null}

                  {analysisMode === "local" && ollamaIncomplete ? (
                    <p className="text-[11px] leading-relaxed text-status-warning">
                      Clip finding won't work until you enter a model name.
                    </p>
                  ) : null}
                </Section>

                <Separator />

                <Section
                  title="Cloud speech-to-text"
                  description="Used for transcription when you choose cloud speech-to-text."
                  badge={<UsageBadge active={transcriptionMode === "cloud"} />}
                >
                  <Field label="Server address">
                    <Input
                      value={cloudStt.baseUrl}
                      onChange={(event) => updateCloudStt({ baseUrl: event.target.value })}
                      placeholder="https://api.openai.com/v1"
                      aria-label="Cloud speech-to-text server address"
                      spellCheck={false}
                    />
                  </Field>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="API key">
                      <form onSubmit={(event) => event.preventDefault()}>
                        <SecretInput
                          label="Cloud STT API key"
                          value={cloudStt.apiKey}
                          onChange={(value) => updateCloudStt({ apiKey: value })}
                          placeholder="sk-…"
                        />
                      </form>
                    </Field>
                    <Field label="Model">
                      <Input
                        value={cloudStt.model}
                        onChange={(event) => updateCloudStt({ model: event.target.value })}
                        placeholder="whisper-1"
                        aria-label="Cloud STT model"
                        spellCheck={false}
                      />
                    </Field>
                  </div>
                  {transcriptionMode === "cloud" && cloudSttIncomplete ? (
                    <p className="text-[11px] leading-relaxed text-status-warning">
                      Cloud transcription needs a server address and an API key.
                    </p>
                  ) : null}
                </Section>
              </div>
            </TabsContent>

            {/* -------------------------------- Fonts -------------------------------- */}
            <TabsContent value="fonts" className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              <div className="space-y-5">
                <Section
                  title="Custom font importer"
                  description="Fonts are added to the app so exported subtitles always render Thai and Uthmani Arabic correctly."
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      ref={fontInputRef}
                      type="file"
                      accept=".ttf,.otf"
                      multiple
                      className="hidden"
                      onChange={(event) => void handleFontFiles(event.target.files)}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      disabled={importingFonts}
                      onClick={() => fontInputRef.current?.click()}
                    >
                      {importingFonts ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Upload className="size-3.5" />
                      )}
                      Import .TTF / .OTF
                    </Button>
                    <span className="text-[11px] text-muted-foreground">
                      {importedFonts.length} custom font
                      {importedFonts.length === 1 ? "" : "s"} available
                    </span>
                  </div>

                  {importedFonts.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {importedFonts.map((font) => (
                        <Badge
                          key={`${font.family}::${font.style}`}
                          variant="secondary"
                          className="font-normal"
                        >
                          {font.family}
                          <span className="ml-1 text-muted-foreground">{font.style}</span>
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No custom fonts imported yet — system fonts are used until you import.
                    </p>
                  )}

                  {fontsDir ? (
                    <p className="break-all font-mono text-[11px] text-muted-foreground">
                      fontsdir: {fontsDir}
                    </p>
                  ) : null}
                </Section>

                <Separator />

                <Section
                  title="Arabic defaults"
                  description="Quranic / Hadith line styling. Warm gold is a content color used only in the preview and .ass output."
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Font family">
                      <Select
                        value={arabic.fontFamily}
                        onValueChange={(value) => updateArabic({ fontFamily: value })}
                      >
                        <SelectTrigger className="w-full" aria-label="Arabic font family">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {fontFamilies.map((family) => (
                            <SelectItem key={family} value={family}>
                              {family}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label="Color">
                      <ColorSelect
                        label="Arabic color"
                        value={arabic.color}
                        onChange={(value) => updateArabic({ color: value })}
                        options={ARABIC_COLORS}
                      />
                    </Field>
                  </div>
                  <Field label="Font size">
                    <NumberField
                      ariaLabel="Arabic font size"
                      value={arabic.fontSize}
                      onChange={(value) => updateArabic({ fontSize: value })}
                      suffix=" px"
                      min={NUMERIC_LIMITS.arabicFontSize.min}
                      max={NUMERIC_LIMITS.arabicFontSize.max}
                      step={NUMERIC_LIMITS.arabicFontSize.step}
                    />
                  </Field>
                  <Field label="Harakat line-height padding">
                    <NumberField
                      ariaLabel="Arabic harakat padding"
                      value={arabic.lineHeightPad}
                      onChange={(value) => updateArabic({ lineHeightPad: value })}
                      suffix="×"
                      min={NUMERIC_LIMITS.arabicLineHeightPad.min}
                      max={NUMERIC_LIMITS.arabicLineHeightPad.max}
                      step={NUMERIC_LIMITS.arabicLineHeightPad.step}
                    />
                  </Field>
                  <Field label="Outline width">
                    <NumberField
                      ariaLabel="Arabic outline width"
                      value={arabic.outlineWidth}
                      onChange={(value) => updateArabic({ outlineWidth: value })}
                      suffix=" px"
                      min={NUMERIC_LIMITS.arabicOutlineWidth.min}
                      max={NUMERIC_LIMITS.arabicOutlineWidth.max}
                      step={NUMERIC_LIMITS.arabicOutlineWidth.step}
                    />
                  </Field>
                  <Field label="Box opacity">
                    <NumberField
                      ariaLabel="Arabic box opacity"
                      value={Math.round(arabic.boxOpacity * 100)}
                      onChange={(value) => updateArabic({ boxOpacity: value / 100 })}
                      suffix="%"
                      min={BOX_OPACITY_PERCENT.min}
                      max={BOX_OPACITY_PERCENT.max}
                      step={BOX_OPACITY_PERCENT.step}
                    />
                  </Field>
                  <SwitchRow
                    label="Bold Arabic"
                    checked={arabic.bold}
                    onCheckedChange={(checked) => updateArabic({ bold: checked })}
                  />
                </Section>

                <Separator />

                <Section
                  title="Thai defaults"
                  description="Subtitle line styling for the Thai translation under each Arabic verse."
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Font family">
                      <Select
                        value={thai.fontFamily}
                        onValueChange={(value) => updateThai({ fontFamily: value })}
                      >
                        <SelectTrigger className="w-full" aria-label="Thai font family">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {fontFamilies.map((family) => (
                            <SelectItem key={family} value={family}>
                              {family}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label="Color">
                      <ColorSelect
                        label="Thai color"
                        value={thai.color}
                        onChange={(value) => updateThai({ color: value })}
                        options={THAI_COLORS}
                      />
                    </Field>
                  </div>
                  <Field label="Font size">
                    <NumberField
                      ariaLabel="Thai font size"
                      value={thai.fontSize}
                      onChange={(value) => updateThai({ fontSize: value })}
                      suffix=" px"
                      min={NUMERIC_LIMITS.thaiFontSize.min}
                      max={NUMERIC_LIMITS.thaiFontSize.max}
                      step={NUMERIC_LIMITS.thaiFontSize.step}
                    />
                  </Field>
                  <Field label="Max characters per line">
                    <NumberField
                      ariaLabel="Max characters per line"
                      value={editor.maxCharsPerLine}
                      onChange={(value) => updateEditor({ maxCharsPerLine: Math.round(value) })}
                      suffix=" chars"
                      min={NUMERIC_LIMITS.maxCharsPerLine.min}
                      max={NUMERIC_LIMITS.maxCharsPerLine.max}
                      step={NUMERIC_LIMITS.maxCharsPerLine.step}
                    />
                  </Field>
                  <LineWidthHint
                    fontFamily={thai.fontFamily}
                    fontSize={thai.fontSize}
                    maxChars={editor.maxCharsPerLine}
                    bold={thai.bold}
                    resolution={editor.resolution}
                    onUseSuggestion={(chars) => updateEditor({ maxCharsPerLine: chars })}
                  />
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Thai has no inter-word spaces, so cues are broken with dictionary-aware word
                    segmentation before the .ass is written. Applies to the Thai line in every cue;
                    Arabic is never character-wrapped.
                  </p>
                  <Field label="Outline width">
                    <NumberField
                      ariaLabel="Thai outline width"
                      value={thai.outlineWidth}
                      onChange={(value) => updateThai({ outlineWidth: value })}
                      suffix=" px"
                      min={NUMERIC_LIMITS.thaiOutlineWidth.min}
                      max={NUMERIC_LIMITS.thaiOutlineWidth.max}
                      step={NUMERIC_LIMITS.thaiOutlineWidth.step}
                    />
                  </Field>
                  <Field label="Box opacity">
                    <NumberField
                      ariaLabel="Thai box opacity"
                      value={Math.round(thai.boxOpacity * 100)}
                      onChange={(value) => updateThai({ boxOpacity: value / 100 })}
                      suffix="%"
                      min={BOX_OPACITY_PERCENT.min}
                      max={BOX_OPACITY_PERCENT.max}
                      step={BOX_OPACITY_PERCENT.step}
                    />
                  </Field>
                  <SwitchRow
                    label="Bold Thai"
                    checked={thai.bold}
                    onCheckedChange={(checked) => updateThai({ bold: checked })}
                  />
                </Section>

                <Separator />

                <Section
                  title="Saved style presets"
                  description="One-click visual themes applied to the dual-line preview and the exported subtitles."
                >
                  <div className="space-y-1.5">
                    {presets.map((preset) => {
                      const isActive = preset.id === activePresetId;
                      const drifted = isActive && activePresetModified;
                      return (
                        <div
                          key={preset.id}
                          className={cn(
                            "flex items-center gap-1.5 rounded-md border px-2.5 py-2",
                            isActive
                              ? "border-ring/40 bg-accent/40"
                              : "border-border bg-card/40",
                          )}
                        >
                          <Button
                            variant="ghost"
                            className="h-auto min-w-0 flex-1 flex-col items-start justify-start gap-0 px-0 py-0 text-left font-normal hover:bg-transparent"
                            onClick={() => applyPreset(preset.id)}
                          >
                            <span className="flex items-center gap-1.5">
                              <span className="truncate text-xs font-medium text-foreground">
                                {preset.name}
                              </span>
                              {drifted ? (
                                <Badge variant="outline" className="text-[9px] text-status-warning">
                                  Modified
                                </Badge>
                              ) : null}
                            </span>
                            <span className="text-[11px] text-muted-foreground">
                              Arabic {preset.arabic.fontSize}px · Thai {preset.thai.fontSize}px
                            </span>
                          </Button>
                          {drifted ? (
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              aria-label={`Update ${preset.name} with the current style`}
                              title="Update this preset with the current style"
                              onClick={() => {
                                updatePreset(preset.id);
                                toast.success("Preset updated", { description: preset.name });
                              }}
                            >
                              <Save className="size-3.5" />
                            </Button>
                          ) : null}
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`Rename ${preset.name}`}
                            onClick={() => {
                              setRenamingId(preset.id);
                              setRenameValue(preset.name);
                            }}
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`Delete ${preset.name}`}
                            onClick={() => setDeletingId(preset.id)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => {
                      setPresetName("");
                      setPresetDialogOpen(true);
                    }}
                  >
                    <Plus className="size-3.5" />
                    Save current as preset
                  </Button>
                </Section>
              </div>
            </TabsContent>

            {/* ------------------------------- Glossary ------------------------------ */}
            <TabsContent value="glossary" className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              <div className="space-y-5">
                <Section
                  title="Thai–Arabic spelling glossary"
                  description="Applied automatically after transcription to fix common spelling variants."
                >
                  <div className="space-y-2">
                    {glossary.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No replacement pairs yet.
                      </p>
                    ) : null}
                    {glossary.map((entry) => (
                      <div key={entry.id} className="flex items-center gap-2">
                        <Input
                          value={entry.find}
                          onChange={(event) =>
                            updateGlossaryEntry(entry.id, { find: event.target.value })
                          }
                          placeholder="Find"
                          aria-label="Find text"
                          aria-invalid={entry.replace.trim() !== "" && !entry.find.trim()}
                          className="h-8"
                        />
                        <MoveRight className="size-3.5 shrink-0 text-muted-foreground" />
                        <Input
                          value={entry.replace}
                          onChange={(event) =>
                            updateGlossaryEntry(entry.id, { replace: event.target.value })
                          }
                          placeholder="Replace"
                          aria-label="Replace with"
                          className="h-8"
                        />
                        <Switch
                          checked={entry.enabled}
                          onCheckedChange={(checked) =>
                            updateGlossaryEntry(entry.id, { enabled: checked })
                          }
                          aria-label="Enable replacement"
                        />
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label="Remove replacement"
                          onClick={() => removeGlossaryEntry(entry.id)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                  {incompleteGlossaryCount > 0 ? (
                    <p className="text-[11px] leading-relaxed text-status-warning">
                      {incompleteGlossaryCount} pair
                      {incompleteGlossaryCount === 1 ? " is" : "s are"} missing the text to
                      find — {incompleteGlossaryCount === 1 ? "it is" : "they are"} skipped during
                      transcription until you fill {incompleteGlossaryCount === 1 ? "it" : "them"} in.
                    </p>
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={addGlossaryEntry}
                  >
                    <Plus className="size-3.5" />
                    Add pair
                  </Button>
                </Section>

                <Separator />

                <Section
                  title="Whisper Arabic hint"
                  description="Editable initial_prompt vocabulary that improves Thai-to-Arabic code-switching accuracy."
                >
                  <Textarea
                    value={whisper.initialPrompt}
                    onChange={(event) => updateWhisper({ initialPrompt: event.target.value })}
                    rows={7}
                    spellCheck={false}
                    aria-label="Whisper Arabic hint"
                    className="font-mono text-xs leading-relaxed"
                  />
                </Section>

                <Separator />

                <Section
                  title="Transcription model"
                  description="How accurately speech is transcribed on this computer. Better models are slower."
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <FitBadge tier={hardwareTier} />
                    <span className="text-[11px] text-muted-foreground">
                      {whisperFitSentence(hardwareTier)}
                    </span>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Whisper model">
                      <Select
                        value={showCustomWhisperModel ? "custom" : whisper.model}
                        onValueChange={(value) => {
                          if (value === "custom") {
                            setCustomWhisperModel(true);
                            return;
                          }
                          setCustomWhisperModel(false);
                          updateWhisper({ model: value });
                        }}
                      >
                        <SelectTrigger className="w-full" aria-label="Whisper model">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {WHISPER_MODELS.map((item) => (
                            <SelectItem key={item.value} value={item.value}>
                              {item.label}
                            </SelectItem>
                          ))}
                          <SelectItem value="custom">Custom…</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label="Transcription precision">
                      <Select
                        value={whisper.computeType}
                        onValueChange={(value) =>
                          updateWhisper({
                            computeType: value as typeof whisper.computeType,
                          })
                        }
                      >
                        <SelectTrigger className="w-full" aria-label="Transcription precision">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="int8">Automatic (recommended)</SelectItem>
                          <SelectItem value="float16">GPU, more accurate</SelectItem>
                          <SelectItem value="float32">CPU, most compatible</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                  {showCustomWhisperModel ? (
                    <Field label="Custom model name" hint="Any Whisper model name">
                      <Input
                        value={whisper.model}
                        onChange={(event) => updateWhisper({ model: event.target.value })}
                        placeholder="large-v3-turbo"
                        aria-label="Custom transcription model"
                        spellCheck={false}
                      />
                    </Field>
                  ) : null}
                  <SwitchRow
                    label="Free up memory after transcription"
                    description="Releases the transcription model from GPU memory before rendering. No effect when transcription runs on the CPU."
                    checked={whisper.autoUnload}
                    onCheckedChange={(checked) => updateWhisper({ autoUnload: checked })}
                  />
                </Section>

                <Separator />

                <Section
                  title="GPU acceleration"
                  description="Optional. The app detects a supported GPU, then downloads a signed acceleration pack — no driver setup. Without it everything runs on the CPU, which is slower but always available. GPU capability also decides whether hardware encoding can be enabled under Editor & Export."
                >
                  <GpuAccelerationPanel summary={acceleration} />
                </Section>
              </div>
            </TabsContent>

            {/* -------------------------------- Editor ------------------------------- */}
            <TabsContent value="editor" className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              <div className="space-y-5">
                <Section
                  title="Interface"
                  description="Language of the app. Thai covers the add-lecture screen first; more screens follow."
                >
                  <Field label="Language">
                    <Select
                      value={uiLanguage}
                      onValueChange={(value) => setUiLanguage(value as UiLanguage)}
                    >
                      <SelectTrigger className="w-full" aria-label="Language">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="en">English</SelectItem>
                        <SelectItem value="th">ไทย</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </Section>

                <Separator />

                <Section
                  title="Cut buffer padding"
                  description="Extra headroom kept before and after detected speech so clips never cut mid-word."
                >
                  <NumberField
                    ariaLabel="Cut buffer padding"
                    value={editor.cutBufferSeconds}
                    onChange={(value) => updateEditor({ cutBufferSeconds: value })}
                    suffix=" s"
                    min={NUMERIC_LIMITS.cutBufferSeconds.min}
                    max={NUMERIC_LIMITS.cutBufferSeconds.max}
                    step={NUMERIC_LIMITS.cutBufferSeconds.step}
                  />
                </Section>

                <Separator />

                <Section
                  title="Filename template"
                  description="Pattern for exported MP4 names. Windows forbidden characters are sanitized automatically."
                >
                  <Field label="Template">
                    <Input
                      value={editor.filenameTemplate}
                      onChange={(event) => {
                        updateEditor({ filenameTemplate: event.target.value });
                        applyExportDefaults({ filenameTemplate: event.target.value });
                      }}
                      aria-label="Filename template"
                      spellCheck={false}
                      className="font-mono text-xs"
                    />
                  </Field>
                  <p className="break-all rounded-md border border-border bg-card/40 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground">
                    {sanitizeFileNameTemplate(editor.filenameTemplate)}
                  </p>
                  {templateTokens.length > 0 ? (
                    <p className="text-[11px] leading-relaxed text-status-warning">
                      Unknown placeholder
                      {templateTokens.length === 1 ? "" : "s"}{" "}
                      <span className="font-mono">{templateTokens.join(", ")}</span> —{" "}
                      {templateTokens.length === 1 ? "it is" : "they are"} written into the file name
                      as typed. Supported:{" "}
                      <span className="font-mono">
                        {TEMPLATE_TOKEN_HINTS.map((hint) => hint.token).join(" ")}
                      </span>
                      .
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-1">
                    {TEMPLATE_TOKEN_HINTS.map((hint) => (
                      <Button
                        key={hint.token}
                        type="button"
                        variant="outline"
                        size="xs"
                        title={hint.description}
                        onClick={() => {
                          const next = `${editor.filenameTemplate}${hint.token}`;
                          updateEditor({ filenameTemplate: next });
                          applyExportDefaults({ filenameTemplate: next });
                        }}
                        className="h-5 rounded px-1.5 font-mono text-[10px] font-normal text-foreground/80"
                      >
                        {hint.token}
                      </Button>
                    ))}
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    {project
                      ? "Saved as the default and applied to the open project now."
                      : "Saved as the default for new projects."}
                  </p>
                </Section>

                <Separator />

                <Section
                  title="Subtitles"
                  description="Language of the Thai explanation line. The Arabic verse line is always kept."
                >
                  <Field label="Subtitle language">
                    <Select
                      value={editor.language}
                      onValueChange={(value) => updateEditor({ language: value })}
                    >
                      <SelectTrigger className="w-full" aria-label="Subtitle language">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="th">Thai (with Arabic)</SelectItem>
                        <SelectItem value="en">English</SelectItem>
                        <SelectItem value="auto">Auto-detect</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </Section>

                <Separator />

                <Section title="Export defaults">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Target resolution">
                      <Select
                        value={editor.resolution}
                        onValueChange={(value) => {
                          const resolution = value as typeof editor.resolution;
                          updateEditor({ resolution });
                          applyExportDefaults({ resolution });
                        }}
                      >
                        <SelectTrigger className="w-full" aria-label="Target resolution">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="1080x1920">1080 × 1920 (9:16)</SelectItem>
                          <SelectItem value="1920x1080">1920 × 1080 (16:9)</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label="9:16 framing">
                      <Select
                        value={editor.framing}
                        onValueChange={(value) => {
                          const framing = value as typeof editor.framing;
                          updateEditor({ framing });
                          applyExportDefaults({ framing });
                        }}
                      >
                        <SelectTrigger className="w-full" aria-label="9:16 framing">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="blur-fill">Blurred background fill</SelectItem>
                          <SelectItem value="center-crop">Smart center crop</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                  <SwitchRow
                    label="Hardware encoding (GPU)"
                    description={
                      isGpuEncodingAvailable(acceleration)
                        ? "GPU ready — falls back to CPU encoding automatically if the driver refuses."
                        : "CPU encoding is in use. Enable GPU acceleration in the Glossary & Whisper tab to turn this on."
                    }
                    // Never claim GPU encoding is on while the hardware path is
                    // unavailable; the stored preference is kept for when it is.
                    checked={isGpuEncodingAvailable(acceleration) && editor.useNvenc}
                    disabled={!isGpuEncodingAvailable(acceleration)}
                    onCheckedChange={(checked) => {
                      updateEditor({ useNvenc: checked });
                      applyExportDefaults({ useNvenc: checked });
                    }}
                  />
                  <SwitchRow
                    label="Also export .SRT file"
                    description="Writes a soft-subtitle .srt next to every burned-in MP4."
                    checked={editor.exportSrt}
                    onCheckedChange={(checked) => {
                      updateEditor({ exportSrt: checked });
                      applyExportDefaults({ exportSrt: checked });
                    }}
                  />
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    {project
                      ? "These are the defaults for new projects; the change also applies to the open project right away."
                      : "These defaults seed every new project."}
                  </p>
                </Section>

                <Separator />

                <Section title="Keyboard shortcuts">
                  <div className="space-y-1.5">
                    {SHORTCUTS.map((shortcut) => (
                      <div
                        key={shortcut.keys}
                        className="flex items-center justify-between gap-4 rounded-md border border-border bg-card/30 px-2.5 py-1.5"
                      >
                        <span className="text-[11px] text-muted-foreground">
                          {shortcut.action}
                        </span>
                        <kbd className="rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-foreground/80">
                          {shortcut.keys}
                        </kbd>
                      </div>
                    ))}
                  </div>
                </Section>
              </div>
            </TabsContent>

            {/* ------------------------------- Storage ------------------------------- */}
            <TabsContent value="storage" className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              <div className="space-y-5">
                <Section
                  title="Auto-save & project folder"
                  description="Auto-save writes a .tafseer snapshot after every edit so a lecture can resume at Step 2 or 3."
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Auto-save interval">
                      <Select
                        value={String(storage.autosaveIntervalMs)}
                        onValueChange={(value) =>
                          updateStorage({ autosaveIntervalMs: Number(value) })
                        }
                      >
                        <SelectTrigger className="w-full" aria-label="Auto-save interval">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {withCurrentInterval(
                            AUTOSAVE_OPTIONS,
                            storage.autosaveIntervalMs,
                          ).map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label="Project folder" hint="Used by native save dialogs">
                      <div className="flex gap-2">
                        <Input
                          value={storage.projectFolder}
                          onChange={(event) =>
                            updateStorage({ projectFolder: event.target.value })
                          }
                          placeholder="Documents\\Tafseer Clipper"
                          aria-label="Project folder"
                          spellCheck={false}
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          className="shrink-0 gap-1.5"
                          disabled={!desktopRuntime}
                          title={
                            desktopRuntime
                              ? undefined
                              : "Available in the installed desktop app"
                          }
                          onClick={() => {
                            void openDirectory().then((folder) => {
                              if (folder) updateStorage({ projectFolder: folder });
                            });
                          }}
                        >
                          <FolderOpen className="size-3.5" />
                          Browse…
                        </Button>
                      </div>
                    </Field>
                  </div>

                  {lastAutosaveError ? (
                    <div className="flex items-start gap-2 rounded-md border border-status-warning/30 bg-status-warning/10 px-2.5 py-2 text-[11px] leading-relaxed text-status-warning">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                      <span>
                        Auto-save failed: {lastAutosaveError}
                        <span className="mt-0.5 block text-muted-foreground">
                          The .tafseer snapshot could not be written to disk. The lecture is still
                          in this window, but it will not survive a restart — use Ctrl + K → Save
                          project to keep a copy.
                        </span>
                      </span>
                    </div>
                  ) : null}
                </Section>

                <Separator />

                <Section
                  title="Engine & hardware"
                  description="Read-only snapshot of the running engine."
                >
                  <div className="rounded-md border border-border bg-card/40">
                    <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
                      <div className="flex items-center gap-2">
                        <SidecarStatusDot status={sidecar.status} />
                        <span className="text-xs text-foreground/90">
                          {SIDECAR_STATUS_LABEL[sidecar.status]}
                          {sidecar.status === "online" && health ? ` · v${health.version}` : ""}
                        </span>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Refresh engine status"
                        onClick={() => void refreshHealth()}
                      >
                        <RefreshCw
                          className={cn(
                            "size-3.5",
                            sidecar.status === "checking" && "animate-spin",
                          )}
                        />
                      </Button>
                    </div>
                    <dl className="divide-y divide-border text-[11px]">
                      <HealthRow
                        label="Engine version"
                        value={health ? `v${health.version}` : "—"}
                      />
                      <HealthRow
                        label="Acceleration"
                        value={health ? <GpuStatusLine summary={acceleration} /> : "—"}
                      />
                      <HealthRow
                        label="Transcription"
                        value={health ? (acceleration.transcription === "gpu" ? "GPU" : "CPU") : "—"}
                      />
                      <HealthRow
                        label="Encoding"
                        value={health ? (acceleration.encoding === "gpu" ? "GPU" : "CPU") : "—"}
                      />
                      <HealthRow
                        label="GPU memory"
                        value={
                          health ? (
                            <NumberFlow
                              value={health.vram_mb}
                              suffix=" MB"
                              format={{ maximumFractionDigits: 0 }}
                            />
                          ) : (
                            "—"
                          )
                        }
                      />
                      <HealthRow
                        label="Whisper"
                        value={
                          health
                            ? `${health.whisper.model} · ${health.whisper.loaded ? "loaded" : "unloaded"}`
                            : "—"
                        }
                      />
                      <HealthRow
                        label="ffmpeg"
                        value={
                          health
                            ? health.ffmpeg_available
                              ? "Available"
                              : "Missing"
                            : "—"
                        }
                      />
                    </dl>
                    {sidecar.error ? (
                      <p className="border-t border-border px-3 py-2 text-[11px] leading-relaxed text-destructive">
                        {sidecar.error}
                      </p>
                    ) : null}
                  </div>
                </Section>

                <Separator />

                <Section
                  title="Disk cache"
                  description="Temporary audio extracts and preview files created by the app."
                >
                  <div className="space-y-1.5 rounded-md border border-border bg-card/40 px-3 py-2">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="text-[11px] text-muted-foreground">Cache size</p>
                      <p
                        className="text-xs tabular-nums text-foreground/90"
                        aria-label={
                          typeof health?.disk_cache_bytes === "number"
                            ? formatBytes(health.disk_cache_bytes)
                            : "unavailable"
                        }
                      >
                        {typeof health?.disk_cache_bytes === "number" ? (
                          <NumberFlow
                            value={Math.round((health.disk_cache_bytes / 1024 / 1024) * 10) / 10}
                            suffix=" MB"
                            format={{ maximumFractionDigits: 1 }}
                          />
                        ) : (
                          "—"
                        )}
                      </p>
                    </div>
                    <p className="text-[11px] text-muted-foreground">Work directory</p>
                    <p className="break-all font-mono text-[11px] text-foreground/80">
                      {health?.work_dir ?? "—"}
                    </p>
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Temporary files are cleaned up automatically on startup: job folders older
                    than 24 hours and extracted audio older than 7 days are deleted, while saved
                    transcripts are kept.
                  </p>
                </Section>

                <Separator />

                <Section
                  title="Portable settings backup"
                  description="Export or import API keys, glossaries, prompts and style presets. Font files themselves are not included — only the list of imported faces."
                >
                  <div className="flex flex-wrap gap-2">
                    <input
                      ref={settingsInputRef}
                      type="file"
                      accept=".json,application/json"
                      className="hidden"
                      aria-label="Import settings file"
                      onChange={(event) => void handleSettingsImport(event.target.files)}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={handleExportSettings}
                    >
                      <Download className="size-3.5" />
                      Export settings (.json)
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => settingsInputRef.current?.click()}
                    >
                      <Upload className="size-3.5" />
                      Import settings (.json)
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1.5 text-muted-foreground"
                      onClick={() => setResetDialogOpen(true)}
                    >
                      <Trash2 className="size-3.5" />
                      Reset defaults
                    </Button>
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    The exported file contains API keys in plain text. Store it somewhere private
                    and never share it.
                  </p>
                </Section>

                <Separator />

                <Section
                  title="Updates"
                  description="Signed release updates for the installed desktop app. Nothing installs automatically."
                >
                  <div className="space-y-2 rounded-md border border-border bg-card/40 px-3 py-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="space-y-0.5">
                        <p className="text-[11px] text-muted-foreground">App version</p>
                        <p className="text-xs tabular-nums text-foreground/90">
                          {updater.currentVersion
                            ? `v${updater.currentVersion}`
                            : desktopRuntime
                              ? "Shown after an update check"
                              : "Desktop app only"}
                        </p>
                      </div>
                      <Badge variant="outline" className="text-[10px]">
                        {desktopRuntime ? "Desktop" : "Browser"}
                      </Badge>
                    </div>

                    {desktopRuntime ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1.5"
                          onClick={() => void handleCheckForUpdates()}
                          disabled={updaterBusy || installingUpdate}
                        >
                          {updater.phase === "checking" ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="size-3.5" />
                          )}
                          Check for updates
                        </Button>
                        {updater.phase === "available" ? (
                          <Button
                            size="sm"
                            className="gap-1.5"
                            onClick={() => void handleInstallUpdate()}
                            disabled={installingUpdate || updaterBusy}
                          >
                            {installingUpdate ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Download className="size-3.5" />
                            )}
                            Install &amp; restart
                          </Button>
                        ) : null}
                      </div>
                    ) : null}

                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      {desktopRuntime
                        ? updaterStatusText(updater)
                        : "Updates are available in the installed desktop app."}
                    </p>
                    {updater.phase === "available" && updater.notes ? (
                      <p className="whitespace-pre-line text-[11px] leading-relaxed text-muted-foreground/80">
                        {updater.notes}
                      </p>
                    ) : null}
                  </div>
                </Section>

                <Separator />

                <Section
                  title="Diagnostics"
                  description="Copy a support bundle with versions, paths and the last engine health snapshot."
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => void handleCopyDiagnostics()}
                      disabled={diagnosticsBusy}
                    >
                      {diagnosticsBusy ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Copy className="size-3.5" />
                      )}
                      Copy diagnostics
                    </Button>
                    <span className="text-[11px] text-muted-foreground">
                      Diagnostics to the clipboard · API keys excluded
                    </span>
                  </div>
                </Section>
              </div>
            </TabsContent>
          </Tabs>
        </Drawer.Content>
      </Drawer.Portal>

      {/* ----------------------------- Preset dialogs ----------------------------- */}
      <Dialog open={presetDialogOpen} onOpenChange={setPresetDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Save style preset</DialogTitle>
            <DialogDescription>
              Snapshots the current Arabic and Thai typography.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={presetName}
            onChange={(event) => setPresetName(event.target.value)}
            placeholder="Preset name"
            autoFocus
          />
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setPresetDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!presetName.trim()}
              onClick={() => {
                const name = presetName.trim();
                createPreset(name);
                setPresetDialogOpen(false);
                toast.success("Style preset saved", { description: name });
              }}
            >
              Save preset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renamingId !== null} onOpenChange={(open) => !open && setRenamingId(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename preset</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            placeholder="Preset name"
          />
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setRenamingId(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={renameUnchanged}
              onClick={() => {
                if (renamingId) renamePreset(renamingId, renameValue);
                setRenamingId(null);
                toast.success("Preset renamed", { description: renameValue.trim() });
              }}
            >
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deletingId !== null} onOpenChange={(open) => !open && setDeletingId(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete preset?</DialogTitle>
            <DialogDescription>
              This removes the saved theme. Current typography stays as it is.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setDeletingId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                if (deletingId) deletePreset(deletingId);
                setDeletingId(null);
                toast.success("Preset deleted");
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Reset all settings?</DialogTitle>
            <DialogDescription>
              Restores the default dark studio configuration and clears every API key, imported
              font reference, glossary pair, style preset and prompt preset. Export a backup first
              if you need any of them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setResetDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                resetSettings();
                syncOpenProjectExportDefaults();
                setResetDialogOpen(false);
                toast.success("Settings reset to defaults");
              }}
            >
              Reset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Drawer.Root>
  );
}

function HealthRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right text-foreground/85">{value}</dd>
    </div>
  );
}

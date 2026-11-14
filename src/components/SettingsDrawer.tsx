import { useMemo, useRef, useState, type ReactNode } from "react";
import { Drawer } from "vaul";
import NumberFlow from "@number-flow/react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Bot,
  Copy,
  Download,
  HardDrive,
  Languages,
  Loader2,
  MoveRight,
  Pencil,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
  Type,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "cn";

import { GpuAccelerationPanel, GpuStatusLine } from "@/components/GpuAcceleration";
import { SidecarStatusDot } from "@/components/SidecarStatusDot";
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
import { importFonts, SIDECAR_URL, verifyArabic } from "@/lib/api";
import { describeAcceleration, isGpuEncodingAvailable } from "@/lib/acceleration";
import { buildDiagnostics, copyText } from "@/lib/diagnostics";
import { sanitizeFileNameTemplate } from "@/lib/filenameTemplate";
import { formatBytes } from "@/lib/format";
import { loadImportedFonts } from "@/lib/fonts";
import { isTauriRuntime } from "@/lib/media";
import { buildProviderFor, describeProviderGap } from "@/lib/providers";
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
import { useSettingsStore, type EngineMode } from "@/store/settingsStore";
import type { SettingsTab } from "@/store/uiStore";
import { useUiStore } from "@/store/uiStore";

/* -------------------------------------------------------------------------- */
/* Layout helpers                                                              */
/* -------------------------------------------------------------------------- */

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-[13px] font-medium text-foreground">{title}</h3>
        {description ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
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
      <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </div>
  );
}

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
  return (
    <div className="flex items-center gap-3">
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([next]) => onChange(next)}
        aria-label={ariaLabel}
      />
      <span className="w-14 shrink-0 text-right text-xs tabular-nums text-foreground/90">
        <NumberFlow
          value={value}
          suffix={suffix}
          format={{ maximumFractionDigits: step < 1 ? 2 : 0 }}
        />
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Content constants                                                           */
/* -------------------------------------------------------------------------- */

const TABS: { value: SettingsTab; label: string; icon: LucideIcon }[] = [
  { value: "providers", label: "AI Providers", icon: Bot },
  { value: "fonts", label: "Fonts & Style", icon: Type },
  { value: "glossary", label: "Glossary & Whisper", icon: Languages },
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

function withCurrentColor(
  options: { value: string; label: string }[],
  current: string,
): { value: string; label: string }[] {
  return options.some((option) => option.value === current)
    ? options
    : [...options, { value: current, label: `Custom (${current})` }];
}

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
    setTranscriptionMode,
    setAnalysisMode,
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

  const fontFamilies = useMemo(() => {
    const families = new Set(SYSTEM_FONTS);
    for (const font of importedFonts) families.add(font.family);
    return [...families].sort((a, b) => a.localeCompare(b));
  }, [importedFonts]);

  const health = sidecar.health;
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
        toast.error("Sidecar unreachable", {
          description: current.sidecar.error ?? `Start backend.exe on ${SIDECAR_URL}.`,
        });
        return;
      }

      const gap = describeProviderGap(current, "fast");
      if (gap) {
        toast.error("Provider is not configured", {
          description: `Add ${gap} below, then test again.`,
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

      toast.success("Provider reachable", {
        description: `${result.model || "The model"} answered · ${
          result.correction_applied ? "correction applied" : "text unchanged"
        }`,
      });
    } catch (error) {
      toast.error("Provider check failed", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTestingConnection(false);
    }
  }

  async function handleSettingsImport(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    try {
      const result = importSettings(await file.text());
      if (result.ok) toast.success("Settings imported");
      else toast.error("Import failed", { description: result.error });
    } catch (error) {
      toast.error("Import failed", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (settingsInputRef.current) settingsInputRef.current.value = "";
    }
  }

  function handleExportSettings() {
    downloadJson(exportSettings(), "tafseer-settings.json");
    toast.success("Settings exported", {
      description: "API keys, fonts, glossary and presets included.",
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
          description: "Paste the JSON into the support report. No API keys are included.",
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
            <div className="overflow-x-auto border-b border-border px-3">
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
                <Section
                  title="Engine routing"
                  description="All provider calls run inside the FastAPI sidecar. The frontend only sends configuration."
                >
                  <Field label="Transcription engine">
                    <Select
                      value={transcriptionMode}
                      onValueChange={(value) => setTranscriptionMode(value as EngineMode)}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="local">Local Faster-Whisper (on this machine)</SelectItem>
                        <SelectItem value="cloud">Cloud STT API</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Topic analysis engine">
                    <Select
                      value={analysisMode}
                      onValueChange={(value) => setAnalysisMode(value as EngineMode)}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="cloud">Unified cloud API</SelectItem>
                        <SelectItem value="local">Local Ollama</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </Section>

                <Separator />

                <Section
                  title="Unified cloud API"
                  description="OpenAI-compatible endpoint used for Step 2 clip reasoning and Step 3 Arabic verification."
                >
                  <Field label="Base URL">
                    <Input
                      value={cloud.baseUrl}
                      onChange={(event) => updateCloud({ baseUrl: event.target.value })}
                      placeholder="https://api.openai.com/v1"
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </Field>
                  <Field label="API key">
                    <Input
                      type="password"
                      value={cloud.apiKey}
                      onChange={(event) => updateCloud({ apiKey: event.target.value })}
                      placeholder="sk-…"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </Field>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Reasoning model (Step 2)">
                      <Input
                        value={cloud.reasoningModel}
                        onChange={(event) =>
                          updateCloud({ reasoningModel: event.target.value })
                        }
                        placeholder="gpt-4.1 / qwen3:14b"
                        spellCheck={false}
                      />
                    </Field>
                    <Field label="Fast text model (Step 3)">
                      <Input
                        value={cloud.fastTextModel}
                        onChange={(event) => updateCloud({ fastTextModel: event.target.value })}
                        placeholder="gpt-4.1-mini / qwen3:4b"
                        spellCheck={false}
                      />
                    </Field>
                  </div>
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
                      Pings the sidecar, then sends one small /verify-arabic probe with the
                      configured provider.
                    </span>
                  </div>
                </Section>

                <Separator />

                <Section
                  title="Local Ollama"
                  description="OpenAI-compatible local runtime for offline clip discovery."
                >
                  <Field label="Ollama URL">
                    <Input
                      value={ollama.baseUrl}
                      onChange={(event) => updateOllama({ baseUrl: event.target.value })}
                      placeholder="http://localhost:11434/v1"
                      spellCheck={false}
                    />
                  </Field>
                  <Field label="Model id">
                    <Input
                      value={ollama.model}
                      onChange={(event) => updateOllama({ model: event.target.value })}
                      placeholder="qwen3:14b"
                      spellCheck={false}
                    />
                  </Field>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] leading-relaxed text-muted-foreground">
                      Model detection is not part of the six-endpoint sidecar contract — enter the
                      model id exactly as Ollama reports it (<span className="font-mono">ollama list</span>).
                    </span>
                  </div>
                </Section>

                <Separator />

                <Section
                  title="Cloud STT API"
                  description="Optional external speech-to-text endpoint used when the transcription engine is set to Cloud."
                >
                  <Field label="Base URL">
                    <Input
                      value={cloudStt.baseUrl}
                      onChange={(event) => updateCloudStt({ baseUrl: event.target.value })}
                      placeholder="https://api.openai.com/v1"
                      spellCheck={false}
                    />
                  </Field>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="API key">
                      <Input
                        type="password"
                        value={cloudStt.apiKey}
                        onChange={(event) => updateCloudStt({ apiKey: event.target.value })}
                        placeholder="sk-…"
                        autoComplete="off"
                      />
                    </Field>
                    <Field label="Model">
                      <Input
                        value={cloudStt.model}
                        onChange={(event) => updateCloudStt({ model: event.target.value })}
                        placeholder="whisper-1"
                        spellCheck={false}
                      />
                    </Field>
                  </div>
                </Section>
              </div>
            </TabsContent>

            {/* -------------------------------- Fonts -------------------------------- */}
            <TabsContent value="fonts" className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              <div className="space-y-5">
                <Section
                  title="Custom font importer"
                  description="Fonts are copied into the sidecar's fonts/ directory so FFmpeg .ass burn-in resolves Thai and Uthmani Arabic reliably."
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
                        <SelectTrigger className="w-full">
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
                  <Field
                    label="Font size"
                    hint={
                      <NumberFlow
                        value={arabic.fontSize}
                        suffix=" px"
                        format={{ maximumFractionDigits: 0 }}
                      />
                    }
                  >
                    <NumberField
                      ariaLabel="Arabic font size"
                      value={arabic.fontSize}
                      onChange={(value) => updateArabic({ fontSize: value })}
                      suffix=" px"
                      min={24}
                      max={120}
                    />
                  </Field>
                  <Field
                    label="Harakat line-height padding"
                    hint={
                      <NumberFlow
                        value={arabic.lineHeightPad}
                        format={{ minimumFractionDigits: 1, maximumFractionDigits: 2 }}
                      />
                    }
                  >
                    <NumberField
                      ariaLabel="Arabic harakat padding"
                      value={arabic.lineHeightPad}
                      onChange={(value) => updateArabic({ lineHeightPad: value })}
                      suffix="×"
                      min={1}
                      max={1.8}
                      step={0.05}
                    />
                  </Field>
                  <Field
                    label="Outline width"
                    hint={
                      <NumberFlow
                        value={arabic.outlineWidth}
                        suffix=" px"
                        format={{ maximumFractionDigits: 1 }}
                      />
                    }
                  >
                    <NumberField
                      ariaLabel="Arabic outline width"
                      value={arabic.outlineWidth}
                      onChange={(value) => updateArabic({ outlineWidth: value })}
                      suffix=" px"
                      min={0}
                      max={8}
                      step={0.5}
                    />
                  </Field>
                  <Field
                    label="Box opacity"
                    hint={
                      <NumberFlow
                        value={Math.round(arabic.boxOpacity * 100)}
                        suffix="%"
                        format={{ maximumFractionDigits: 0 }}
                      />
                    }
                  >
                    <NumberField
                      ariaLabel="Arabic box opacity"
                      value={Math.round(arabic.boxOpacity * 100)}
                      onChange={(value) => updateArabic({ boxOpacity: value / 100 })}
                      suffix="%"
                      min={0}
                      max={100}
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
                        <SelectTrigger className="w-full">
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
                  <Field
                    label="Font size"
                    hint={
                      <NumberFlow
                        value={thai.fontSize}
                        suffix=" px"
                        format={{ maximumFractionDigits: 0 }}
                      />
                    }
                  >
                    <NumberField
                      ariaLabel="Thai font size"
                      value={thai.fontSize}
                      onChange={(value) => updateThai({ fontSize: value })}
                      suffix=" px"
                      min={20}
                      max={96}
                    />
                  </Field>
                  <Field
                    label="Outline width"
                    hint={
                      <NumberFlow
                        value={thai.outlineWidth}
                        suffix=" px"
                        format={{ maximumFractionDigits: 1 }}
                      />
                    }
                  >
                    <NumberField
                      ariaLabel="Thai outline width"
                      value={thai.outlineWidth}
                      onChange={(value) => updateThai({ outlineWidth: value })}
                      suffix=" px"
                      min={0}
                      max={8}
                      step={0.5}
                    />
                  </Field>
                  <Field
                    label="Box opacity"
                    hint={
                      <NumberFlow
                        value={Math.round(thai.boxOpacity * 100)}
                        suffix="%"
                        format={{ maximumFractionDigits: 0 }}
                      />
                    }
                  >
                    <NumberField
                      ariaLabel="Thai box opacity"
                      value={Math.round(thai.boxOpacity * 100)}
                      onChange={(value) => updateThai({ boxOpacity: value / 100 })}
                      suffix="%"
                      min={0}
                      max={100}
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
                  description="One-click visual themes applied to the dual-line preview and the FFmpeg .ass burn-in."
                >
                  <div className="space-y-1.5">
                    {presets.map((preset) => (
                      <div
                        key={preset.id}
                        className={cn(
                          "flex items-center gap-1.5 rounded-md border px-2.5 py-2",
                          preset.id === activePresetId
                            ? "border-ring/40 bg-accent/40"
                            : "border-border bg-card/40",
                        )}
                      >
                        <Button
                          variant="ghost"
                          className="h-auto min-w-0 flex-1 flex-col items-start justify-start gap-0 px-0 py-0 text-left font-normal hover:bg-transparent"
                          onClick={() => {
                            applyPreset(preset.id);
                            toast.success("Preset applied", { description: preset.name });
                          }}
                        >
                          <span className="block truncate text-xs font-medium text-foreground">
                            {preset.name}
                          </span>
                          <span className="text-[11px] text-muted-foreground">
                            Arabic {preset.arabic.fontSize}px · Thai {preset.thai.fontSize}px
                          </span>
                        </Button>
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
                    ))}
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
                    className="font-mono text-xs leading-relaxed"
                  />
                </Section>

                <Separator />

                <Section
                  title="GPU acceleration"
                  description="Optional. The app detects a supported GPU, then downloads a signed acceleration pack — no driver setup. Without it everything runs on the CPU, which is slower but always available."
                >
                  <GpuAccelerationPanel summary={acceleration} />
                </Section>

                <Separator />

                <Section
                  title="Whisper model"
                  description="Local transcription model and precision. Larger models are more accurate and slower; the CPU path is unaffected by GPU precision."
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Whisper model">
                      <Input
                        value={whisper.model}
                        onChange={(event) => updateWhisper({ model: event.target.value })}
                        placeholder="large-v3-turbo"
                        spellCheck={false}
                      />
                    </Field>
                    <Field label="Compute precision">
                      <Select
                        value={whisper.computeType}
                        onValueChange={(value) =>
                          updateWhisper({
                            computeType: value as typeof whisper.computeType,
                          })
                        }
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="int8">Automatic (recommended)</SelectItem>
                          <SelectItem value="float16">High precision (GPU)</SelectItem>
                          <SelectItem value="float32">Compatibility</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                  <SwitchRow
                    label="Unload Whisper from GPU memory after Step 1"
                    description="Frees GPU memory before encoding starts. No effect when transcription runs on the CPU."
                    checked={whisper.autoUnload}
                    onCheckedChange={(checked) => updateWhisper({ autoUnload: checked })}
                  />
                </Section>
              </div>
            </TabsContent>

            {/* -------------------------------- Editor ------------------------------- */}
            <TabsContent value="editor" className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              <div className="space-y-5">
                <Section
                  title="Cut buffer padding"
                  description="Extra headroom kept before and after detected speech so clips never cut mid-word."
                >
                  <NumberField
                    ariaLabel="Cut buffer padding"
                    value={editor.cutBufferSeconds}
                    onChange={(value) => updateEditor({ cutBufferSeconds: value })}
                    suffix=" s"
                    min={0}
                    max={1.5}
                    step={0.05}
                  />
                </Section>

                <Separator />

                <Section
                  title="Subtitle line wrapping"
                  description="Thai has no inter-word spaces, so cues are broken with dictionary-aware word segmentation before the .ass is written (WrapStyle 2 honours only explicit breaks)."
                >
                  <Field
                    label="Max characters per line"
                    hint={
                      <NumberFlow
                        value={editor.maxCharsPerLine}
                        suffix=" chars"
                        format={{ maximumFractionDigits: 0 }}
                      />
                    }
                  >
                    <NumberField
                      ariaLabel="Max characters per line"
                      value={editor.maxCharsPerLine}
                      onChange={(value) => updateEditor({ maxCharsPerLine: Math.round(value) })}
                      suffix=" chars"
                      min={20}
                      max={80}
                    />
                  </Field>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Applies to the Thai line in every cue; Arabic is never character-wrapped.
                  </p>
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
                      spellCheck={false}
                      className="font-mono text-xs"
                    />
                  </Field>
                  <p className="break-all rounded-md border border-border bg-card/40 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground">
                    {sanitizeFileNameTemplate(editor.filenameTemplate)}
                  </p>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    {project
                      ? "Saved as the default and applied to the open project now."
                      : "Saved as the default for new projects."}
                  </p>
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
                        <SelectTrigger className="w-full">
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
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="blur-fill">Blurred background fill</SelectItem>
                          <SelectItem value="center-crop">Smart center crop</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                  <Field label="Subtitle language">
                    <Select
                      value={editor.language}
                      onValueChange={(value) => updateEditor({ language: value })}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="th">Thai (with Arabic)</SelectItem>
                        <SelectItem value="en">English</SelectItem>
                        <SelectItem value="auto">Auto-detect</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <SwitchRow
                    label="Hardware encoding (GPU)"
                    description={
                      isGpuEncodingAvailable(acceleration)
                        ? "GPU ready — falls back to CPU encoding automatically if the driver refuses."
                        : "CPU fallback (slower). Enable GPU acceleration in the Glossary & Whisper tab."
                    }
                    checked={editor.useNvenc}
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
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {AUTOSAVE_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label="Project folder" hint="Used by native save dialogs">
                      <Input
                        value={storage.projectFolder}
                        onChange={(event) =>
                          updateStorage({ projectFolder: event.target.value })
                        }
                        placeholder="Documents\\Tafseer Clipper"
                        spellCheck={false}
                      />
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
                  title="Sidecar & hardware"
                  description="Read-only snapshot from GET /health."
                >
                  <div className="rounded-md border border-border bg-card/40">
                    <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
                      <div className="flex items-center gap-2">
                        <SidecarStatusDot status={sidecar.status} />
                        <span className="text-xs text-foreground/90">
                          {sidecar.status === "online"
                            ? `Online${health ? ` · v${health.version}` : ""}`
                            : sidecar.status === "checking"
                              ? "Checking…"
                              : sidecar.status === "offline"
                                ? "Offline"
                                : "Not checked"}
                        </span>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Refresh sidecar health"
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
                  description="Temporary WAV extracts and preview files created by the sidecar."
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
                    The sidecar prunes its own scratch space on startup: generated job folders
                    older than 24 h and extracted WAVs older than 7 days are deleted, while saved
                    transcripts are kept. There is no manual clear button in the six-endpoint
                    contract.
                  </p>
                </Section>

                <Separator />

                <Section
                  title="Portable settings backup"
                  description="Export or import API keys, custom fonts, glossaries, prompts and style presets."
                >
                  <div className="flex flex-wrap gap-2">
                    <input
                      ref={settingsInputRef}
                      type="file"
                      accept=".json,application/json"
                      className="hidden"
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
                </Section>

                <Separator />

                <Section
                  title="Updates"
                  description="Signed release updates for the installed desktop app. Nothing installs automatically."
                >
                  <div className="space-y-2 rounded-md border border-border bg-card/40 px-3 py-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="space-y-0.5">
                        <p className="text-[11px] text-muted-foreground">Current version</p>
                        <p className="text-xs tabular-nums text-foreground/90">
                          {health ? `v${health.version}` : "Unavailable — sidecar offline"}
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
                  description="Copy a support bundle with versions, paths and the last sidecar health snapshot."
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
                      JSON to the clipboard · API keys excluded
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
              onClick={() => {
                createPreset(presetName);
                setPresetDialogOpen(false);
                toast.success("Style preset saved");
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
              onClick={() => {
                if (renamingId) renamePreset(renamingId, renameValue);
                setRenamingId(null);
                toast.success("Preset renamed");
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
              Restores the default dark studio configuration, style presets, prompt presets and
              glossary.
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

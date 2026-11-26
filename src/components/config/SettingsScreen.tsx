import { L } from "@/lib/i18n";
/**
 * Full-page Settings screen, styled like a preferences window: a left sidebar
 * listing every section, and a content pane showing the selected one. There is
 * deliberately no wizard footer — sections are jumped to directly from the
 * sidebar, and L("Back to app") closes the screen.
 */

import { useRef, useState } from "react";
import NumberFlow from "@number-flow/react";
import { toast } from "sonner";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  Keyboard,
  KeyRound,
  Languages,
  Loader2,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  Upload,
  Cpu,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GpuAccelerationPanel, GpuStatusLine } from "@/components/GpuAcceleration";
import { FitBadge } from "@/components/FitBadge";
import {
  AUTOSAVE_OPTIONS,
  SHORTCUTS,
  Field,
  ModelSelect,
  SecretInput,
  Section,
  downloadJson,
  settingsBackupFileName,
  updaterStatusText,
  withCurrentInterval,
} from "@/components/config/shared";
import { SegmentedToggle } from "@/components/SegmentedToggle";
import { SidecarStatusDot, SIDECAR_STATUS_LABEL } from "@/components/SidecarStatusDot";
import { listModels } from "@/lib/api";
import { describeProviderGap, fitSentence } from "@/lib/providers";
import { describeAcceleration } from "@/lib/acceleration";
import { useAppVersion } from "@/lib/appVersion";
import { buildDiagnostics, copyText } from "@/lib/diagnostics";
import { formatBytes } from "@/lib/format";
import { loadImportedFonts } from "@/lib/fonts";
import { isTauriRuntime, openDirectory, openExternalUrl } from "@/lib/media";
import {
  checkForUpdates,
  downloadAndInstall,
  getPendingUpdate,
  getUpdaterStatus,
  RELEASES_URL,
  relaunchApp,
  useUpdaterStatus,
} from "@/lib/updater";
import { useProjectStore } from "@/store/projectStore";
import {
  useSettingsStore,
  type DecisionFormat,
  type DecisionSlotId,
  type DecisionSlotMode,
  type UiLanguage,
} from "@/store/settingsStore";
import { useUiStore, type SettingsSection } from "@/store/uiStore";
import { cn } from "cn";

function getSections(): { id: SettingsSection; label: string; icon: LucideIcon }[] {
  return [
  { id: "connection", label: L("AI connection"), icon: KeyRound },
  { id: "gpu", label: L("GPU acceleration"), icon: Cpu },
  { id: "storage", label: L("Storage & cache"), icon: FolderOpen },
  { id: "engine", label: L("Engine & diagnostics"), icon: Activity },
  { id: "language", label: L("Language"), icon: Languages },
  { id: "backup", label: L("Backup & reset"), icon: Save },
  { id: "updates", label: L("Updates"), icon: Download },
    { id: "shortcuts", label: L("Keyboard shortcuts"), icon: Keyboard },
  ];
}

function getSectionDescriptions(): Record<SettingsSection, string> {
  return {
  connection: L("One AI connection for clip finding and cloud speech-to-text — cloud or on this computer."),
  gpu: L("Optional hardware acceleration. Everything falls back to the CPU automatically."),
  storage: L("Auto-save, the project folder and the temporary disk cache."),
  engine: L("Live status of the processing engine, plus a copyable support bundle."),
  language: L("Display language of the app."),
  backup: L("Export or import every setting, or reset to defaults."),
  updates: L("Signed release updates for the installed desktop app."),
    shortcuts: L("Keyboard shortcuts used across the studio."),
  };
}

export function SettingsScreen() {
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);
  const settingsSection = useUiStore((state) => state.settingsSection);
  const openSettings = useUiStore((state) => state.openSettings);

  return (
    <div className="fixed inset-x-0 bottom-0 top-[var(--titlebar-height)] z-40 flex bg-background">
      <aside className="flex w-60 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border px-3 py-4">
        <Button
          variant="ghost"
          size="sm"
          className="mr-1 justify-start gap-2 text-muted-foreground"
          onClick={() => setSettingsOpen(false)}
        >
          <ArrowLeft className="size-4" />
          {L("Back to app")}
        </Button>
        <p className="px-2 pb-2 pt-4 text-[10px] uppercase tracking-[0.2em] text-muted-foreground/70">
          {L("Settings")}
        </p>
        {getSections().map(({ id, label, icon: Icon }) => (
          <Button
            key={id}
            type="button"
            variant="ghost"
            size="sm"
            aria-current={settingsSection === id ? "true" : undefined}
            onClick={() => openSettings(id)}
            className={cn(
              "justify-start gap-2.5 font-normal",
              settingsSection === id
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {label}
          </Button>
        ))}
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-10 py-8">
          <header className="space-y-1 pb-6">
            <h1 className="text-lg font-medium text-foreground">
              {getSections().find((s) => s.id === settingsSection)?.label ?? L("Settings")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {getSectionDescriptions()[settingsSection]}
            </p>
          </header>
          <div className="space-y-5">
            {settingsSection === "connection" ? <ConnectionSection /> : null}
            {settingsSection === "gpu" ? <GpuSection /> : null}
            {settingsSection === "storage" ? <StorageSection /> : null}
            {settingsSection === "engine" ? <EngineSection /> : null}
            {settingsSection === "language" ? <LanguageSection /> : null}
            {settingsSection === "backup" ? <BackupSection /> : null}
            {settingsSection === "updates" ? <UpdatesSection /> : null}
            {settingsSection === "shortcuts" ? <ShortcutsSection /> : null}
          </div>
        </div>
      </main>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* AI connection (cloud + local)                                              */
/* -------------------------------------------------------------------------- */

function ConnectionSection() {
  const cloud = useSettingsStore((state) => state.cloud);
  const updateCloud = useSettingsStore((state) => state.updateCloud);
  const ollama = useSettingsStore((state) => state.ollama);
  const updateOllama = useSettingsStore((state) => state.updateOllama);
  const analysisMode = useSettingsStore((state) => state.analysisMode);
  const health = useSettingsStore((state) => state.sidecar.health);
  const refreshHealth = useSettingsStore((state) => state.refreshHealth);

  const [testingConnection, setTestingConnection] = useState(false);

  const hardwareTier = health?.hardware?.tier;
  const ollamaStatus = health?.providers?.ollama;
  const ollamaDetected = ollamaStatus?.detected === true;
  const providerGap = describeProviderGap({ analysisMode, ollama, cloud });

  /** Test Connection = sidecar health ping + a model-list probe. This proves
      the address and key work without spending tokens or depending on the
      model chosen for clip finding in Step 2. */
  async function handleTestConnection() {
    if (testingConnection) return;
    setTestingConnection(true);
    try {
      await refreshHealth({ force: true });
      const current = useSettingsStore.getState();
      if (current.sidecar.status !== "online" || !current.sidecar.health) {
        toast.error("The processing engine isn't responding", {
          description: current.sidecar.error ?? "Click Retry, or restart the app.",
        });
        return;
      }

      // Listing models needs only the address and key — never a generation
      // model. The health ping above covers the local/Ollama connection.
      const baseUrl = current.cloud.baseUrl.trim();
      const apiKey = current.cloud.apiKey.trim();
      const gap = !baseUrl ? "the AI service address" : !apiKey ? "the API key" : null;
      if (gap) {
        toast.error("The AI connection isn't set up yet", {
          description: `Add ${gap} above, then check again.`,
        });
        return;
      }

      const result = await listModels({ base_url: baseUrl, api_key: apiKey });

      toast.success(L("Connected"), {
        description: result.models.length
          ? `${result.models.length} model${result.models.length === 1 ? "" : "s"} available · no tokens used`
          : "The service answered but lists no models. Check its model access.",
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
    toast(copied ? L("Download link copied") : "Open ollama.com/download", {
      description: "Install Ollama, then use Check again.",
    });
  }

  return (
    <>
      <Section
        title={L("Cloud (your AI account)")}
        description={L("An OpenAI-compatible connection. The server address and API key are entered here and nowhere else.")}
      >
        <Field label={L("Server address")}>
          <Input
            value={cloud.baseUrl}
            onChange={(event) => updateCloud({ baseUrl: event.target.value })}
            placeholder="https://api.openai.com/v1"
            aria-label="AI connection server address"
            spellCheck={false}
            autoComplete="off"
          />
        </Field>
        <Field label={L("API key")}>
          {/* Chromium logs a password-manager warning for a `type="password"`
              field outside a form; this one is inert (no implicit submits). */}
          <form onSubmit={(event) => event.preventDefault()}>
            <SecretInput
              label="Cloud API key"
              value={cloud.apiKey}
              onChange={(value) => updateCloud({ apiKey: value })}
              placeholder="sk-…"
            />
          </form>
        </Field>
        {providerGap ? (
          <p className="text-[11px] leading-relaxed text-status-warning">
            Not set up yet: add {providerGap}.
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
            {L("Test connection")}
          </Button>
          <span className="text-[11px] text-muted-foreground">
            {L("Checks the address and key, then lists available models. No tokens used.")}
            {L("Speech-to-text is checked when you transcribe.")}
          </span>
        </div>
      </Section>

      <Separator />

      <Section
        title={L("Local (this computer, Ollama)")}
        description={L("The offline engine used when a model selector is switched to “This computer”.")}
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
            {ollamaDetected ? L("Ollama found") : L("Ollama not found")}
          </Badge>
          <FitBadge tier={hardwareTier} />
          <Button
            variant="ghost"
            size="xs"
            className="h-5 text-muted-foreground"
            onClick={() => void refreshHealth({ force: true })}
          >
            {L("Check again")}
          </Button>
        </div>

        {hardwareTier ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            This computer: {fitSentence(hardwareTier)}
          </p>
        ) : null}

        <Field label={L("Server address")} hint="Default: http://localhost:11434/v1">
          <Input
            value={ollama.baseUrl}
            onChange={(event) => updateOllama({ baseUrl: event.target.value })}
            placeholder="http://localhost:11434/v1"
            aria-label={L("Ollama server address")}
            spellCheck={false}
            autoComplete="off"
          />
        </Field>

        {!ollamaDetected ? (
          <div className="space-y-2 rounded-md border border-border bg-card/40 px-3 py-2.5">
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Ollama isn't responding at the address above. If it is already installed, make
              sure it is running — start it from the tray icon, then press Check again. It is
              free and runs everything offline.
            </p>
            <ol className="list-decimal space-y-0.5 pl-4 text-[11px] leading-relaxed text-muted-foreground">
              <li>{L("Install Ollama.")}</li>
              <li>
                Pull any model with <span className="font-mono">ollama pull &lt;model&gt;</span>.
              </li>
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
                {L("Get Ollama")}
              </Button>
            </div>
          </div>
        ) : null}
      </Section>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Fast judgments                                                             */
/* -------------------------------------------------------------------------- */

const DECISION_SLOTS: {
  id: DecisionSlotId;
  title: string;
  hint: string;
  description: string;
}[] = [
  {
    id: "analysis",
    title: "Recitation & sentence breaks",
    hint: L("Step 1 · finds spoken Arabic and where sentences end"),
    description:
      "Classifies each transcript segment, so the lecture is grouped before you reach Find Clips.",
  },
];

type ProbeState = { status: "idle" | "running" | "ok" | "failed"; detail: string };

export function JudgmentsSection() {
  const decisionSlots = useSettingsStore((state) => state.decisionSlots);
  const updateDecisionSlot = useSettingsStore((state) => state.updateDecisionSlot);
  const cloud = useSettingsStore((state) => state.cloud);
  const ollama = useSettingsStore((state) => state.ollama);
  const [probes, setProbes] = useState<Record<DecisionSlotId, ProbeState>>({
    analysis: { status: "idle", detail: "" },
  });

  const setProbe = (id: DecisionSlotId, next: ProbeState) =>
    setProbes((current) => ({ ...current, [id]: next }));

  async function test(slot: DecisionSlotId) {
    const config = decisionSlots[slot];
    const model = config.model.trim();
    const baseUrl = (config.mode === "local" ? ollama.baseUrl : cloud.baseUrl).trim();
    if (!model || !baseUrl) {
      setProbe(slot, {
        status: "failed",
        detail: !model ? "Choose a model first." : "Add the connection address first.",
      });
      return;
    }
    setProbe(slot, { status: "running", detail: "" });
    try {
      const result = await listModels({
        base_url: baseUrl,
        api_key: config.mode === "local" ? "" : cloud.apiKey || null,
        probe_model: model,
        endpoint_style: config.format,
        endpoint_url: config.endpointUrl.trim() || null,
        timeout: cloud.timeout || null,
      });
      const probe = result.probe;
      if (!probe) {
        setProbe(slot, {
          status: "failed",
          detail: "The engine could not test this model.",
        });
      } else if (!probe.ok) {
        setProbe(slot, { status: "failed", detail: probe.detail || "No answer." });
      } else {
        const confidence =
          typeof probe.confidence === "number" ? ` (${Math.round(probe.confidence * 100)}%)` : "";
        const detected =
          probe.format === "systemone" || probe.format === "decisions"
            ? probe.format
            : null;
        // Auto means "measure once and remember": the next run uses the saved
        // result instead of probing again.
        if (detected && config.format === "auto") {
          updateDecisionSlot(slot, { format: detected });
        }
        const via =
          probe.format === "decisions"
            ? "Decisions"
            : probe.format === "systemone"
              ? "System One"
              : "";
        setProbe(slot, {
          status: "ok",
          detail: `Answered correctly${confidence}${via ? ` · ${via}` : ""}.`,
        });
      }
    } catch (error) {
      setProbe(slot, {
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return (
    <Section
      title={L("Analysis model")}
      description="A fast model that finds spoken Arabic and sentence boundaries during transcription. If no model is set or the service is unreachable, transcription falls back to the standard path."
    >
      <div className="space-y-3">
        {DECISION_SLOTS.map((slot) => {
          const config = decisionSlots[slot.id];
          const probe = probes[slot.id];
          const needsModel = !config.model.trim();
          return (
            <div
              key={slot.id}
              className="space-y-3 rounded-md border border-border bg-card/40 px-3 py-3"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-0.5">
                  <p className="text-xs font-medium text-foreground/90">{slot.title}</p>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    {slot.hint}
                  </p>
                </div>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {slot.description}
              </p>

              <SegmentedToggle<DecisionSlotMode>
                label={`Where ${slot.title} runs`}
                value={config.mode}
                options={[
                  { value: "local", label: L("This computer") },
                  { value: "cloud", label: L("Your AI account") },
                ]}
                onChange={(mode) => updateDecisionSlot(slot.id, { mode, model: "" })}
              />

              <Field
                label={L("Model")}
                hint="Only familiar fast-judgment models are listed. Type the exact name below if yours isn't shown."
              >
                <ModelSelect
                  source={config.mode === "local" ? "ollama" : "cloud"}
                  filter="decision"
                  value={config.model}
                  onChange={(model) => updateDecisionSlot(slot.id, { model })}
                  label={`${slot.title} model`}
                />
              </Field>
              <Dialog>
                <DialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-0 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    {L("Advanced")}
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Advanced · {slot.title}</DialogTitle>
                    <DialogDescription>
                      Leave the format on Detect automatically unless Test could
                      not find your service. Change the URL only when your
                      provider uses a different judgment route.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    <Field label="Format" hint="How the app asks this service for judgments.">
                      <Select
                        value={config.format}
                        onValueChange={(format) =>
                          updateDecisionSlot(slot.id, {
                            format: format as DecisionFormat,
                          })
                        }
                      >
                        <SelectTrigger
                          className="w-full"
                          aria-label={`${slot.title} format`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">Detect automatically</SelectItem>
                          <SelectItem value="systemone">System One</SelectItem>
                          <SelectItem value="decisions">OpenAI Decisions</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field
                      label="Judgment URL"
                      hint="Optional. Paste the full address only if the automatic one fails."
                    >
                      <Input
                        value={config.endpointUrl}
                        onChange={(event) =>
                          updateDecisionSlot(slot.id, {
                            endpointUrl: event.target.value,
                          })
                        }
                        placeholder="https://service.example/v1/decisions"
                        aria-label={`${slot.title} judgment URL`}
                      />
                    </Field>
                  </div>
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button variant="outline">{L("Done")}</Button>
                    </DialogClose>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={needsModel || probe.status === "running"}
                  onClick={() => void test(slot.id)}
                >
                  {probe.status === "running" ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="size-3.5" />
                  )}
                  Test
                </Button>
                {needsModel ? (
                  <span className="text-[11px] text-status-warning">
                    No model chosen yet — this step uses the standard path.
                  </span>
                ) : probe.status === "idle" ? (
                  <span className="text-[11px] text-muted-foreground">
                    {config.mode === "local" ? L("Runs on this computer") : L("Runs on your AI account")}
                  </span>
                ) : (
                  <span
                    className={cn(
                      "text-[11px]",
                      probe.status === "failed" ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {probe.detail}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {L("Leaving a switch off keeps today's behavior exactly: the step uses its regular model, or its built-in rules.")}
      </p>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* GPU acceleration                                                           */
/* -------------------------------------------------------------------------- */

function GpuSection() {
  const health = useSettingsStore((state) => state.sidecar.health);
  const acceleration = describeAcceleration(health);
  return (
    <Section
      title={L("Acceleration pack")}
      description="Optional. The app detects a supported GPU, then downloads a signed acceleration pack — no driver setup. Without it everything runs on the CPU, which is slower but always available. GPU capability also decides whether hardware encoding can be enabled in the Export configuration."
    >
      <GpuAccelerationPanel summary={acceleration} />
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Storage & cache                                                            */
/* -------------------------------------------------------------------------- */

function StorageSection() {
  const storage = useSettingsStore((state) => state.storage);
  const updateStorage = useSettingsStore((state) => state.updateStorage);
  const health = useSettingsStore((state) => state.sidecar.health);
  const lastAutosaveError = useProjectStore((state) => state.lastAutosaveError);

  const desktopRuntime = isTauriRuntime();

  return (
    <>
      <Section
        title={L("Auto-save & project folder")}
        description={L("Auto-save writes a .tafseer snapshot after every edit so a lecture can resume at Step 2 or 3.")}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={L("Auto-save interval")}>
            <Select
              value={String(storage.autosaveIntervalMs)}
              onValueChange={(value) => updateStorage({ autosaveIntervalMs: Number(value) })}
            >
              <SelectTrigger className="w-full" aria-label={L("Auto-save interval")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {withCurrentInterval(AUTOSAVE_OPTIONS, storage.autosaveIntervalMs).map(
                  (option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </Field>
          <Field label={L("Project folder")} hint={L("Used by native save dialogs")}>
            <div className="flex gap-2">
              <Input
                value={storage.projectFolder}
                onChange={(event) => updateStorage({ projectFolder: event.target.value })}
                placeholder="Documents\\Tafseer Clipper"
                aria-label={L("Project folder")}
                spellCheck={false}
              />
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 gap-1.5"
                disabled={!desktopRuntime}
                title={desktopRuntime ? undefined : "Available in the installed desktop app"}
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
        title={L("Disk cache")}
        description={L("Temporary audio extracts and preview files created by the app.")}
      >
        <div className="space-y-1.5 rounded-md border border-border bg-card/40 px-3 py-2">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-[11px] text-muted-foreground">{L("Cache size")}</p>
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
          <p className="text-[11px] text-muted-foreground">{L("Work directory")}</p>
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
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Engine & diagnostics                                                       */
/* -------------------------------------------------------------------------- */

function EngineSection() {
  const sidecar = useSettingsStore((state) => state.sidecar);
  const refreshHealth = useSettingsStore((state) => state.refreshHealth);
  const lastAutosaveError = useProjectStore((state) => state.lastAutosaveError);
  const storage = useSettingsStore((state) => state.storage);

  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const health = sidecar.health;
  const acceleration = describeAcceleration(health);
  /** Installed app version; the bundled engine can lag behind after an update. */
  const appVersion = useAppVersion();

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
        toast.success(L("Diagnostics copied"), {
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
    <>
      <Section title={L("Engine & hardware")} description={L("Read-only snapshot of the running app and engine.")}>
        <div className="rounded-md border border-border bg-card/40">
          <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
            <div className="flex items-center gap-2">
              <SidecarStatusDot status={sidecar.status} />
              <span className="text-xs text-foreground/90">
                {SIDECAR_STATUS_LABEL[sidecar.status]}
                {sidecar.status === "online" && health
                  ? ` · v${appVersion ?? health.version}`
                  : ""}
              </span>
            </div>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Refresh engine status"
              onClick={() => void refreshHealth()}
            >
              <RefreshCw
                className={cn("size-3.5", sidecar.status === "checking" && "animate-spin")}
              />
            </Button>
          </div>
          <dl className="divide-y divide-border text-[11px]">
            <HealthRow
              label={L("App version")}
              value={appVersion ? `v${appVersion}` : health ? `v${health.version}` : "—"}
            />
            {health && appVersion && health.version !== appVersion ? (
              <HealthRow label={L("Engine version")} value={`v${health.version}`} />
            ) : null}
            <HealthRow
              label={L("Acceleration")}
              value={health ? <GpuStatusLine summary={acceleration} /> : "—"}
            />
            <HealthRow
              label={L("Transcription")}
              value={health ? (acceleration.transcription === "gpu" ? "GPU" : "CPU") : "—"}
            />
            <HealthRow
              label={L("Encoding")}
              value={health ? (acceleration.encoding === "gpu" ? "GPU" : "CPU") : "—"}
            />
            <HealthRow
              label={L("GPU memory")}
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
              value={health ? (health.ffmpeg_available ? L("Available") : L("Missing")) : "—"}
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
        title={L("Diagnostics")}
        description={L("Copy a support bundle with versions, paths and the last engine health snapshot.")}
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
            {L("Copy diagnostics")}
          </Button>
          <span className="text-[11px] text-muted-foreground">
            Diagnostics to the clipboard · API keys excluded
          </span>
        </div>
      </Section>
    </>
  );
}

function HealthRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right text-foreground/85">{value}</dd>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Language                                                                   */
/* -------------------------------------------------------------------------- */

function LanguageSection() {
  const uiLanguage = useSettingsStore((state) => state.uiLanguage);
  const setUiLanguage = useSettingsStore((state) => state.setUiLanguage);
  return (
    <Field label={L("Display language")}>
      <Select value={uiLanguage} onValueChange={(value) => setUiLanguage(value as UiLanguage)}>
        <SelectTrigger className="w-full" aria-label={L("Language")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="en">English</SelectItem>
          <SelectItem value="th">ไทย</SelectItem>
        </SelectContent>
      </Select>
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        {L(
          "Interface text is translated where it reads naturally; technical names and shortcuts stay in English.",
        )}
      </p>
    </Field>
  );
}

/* -------------------------------------------------------------------------- */
/* Backup & reset                                                             */
/* -------------------------------------------------------------------------- */

function BackupSection() {
  const exportSettings = useSettingsStore((state) => state.exportSettings);
  const importSettings = useSettingsStore((state) => state.importSettings);
  const resetSettings = useSettingsStore((state) => state.resetSettings);
  const applyExportDefaults = useProjectStore((state) => state.applyExportDefaults);

  const settingsInputRef = useRef<HTMLInputElement>(null);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);

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

  async function handleSettingsImport(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    try {
      const result = importSettings(await file.text());
      if (result.ok) {
        syncOpenProjectExportDefaults();
        // A backup carries font names, not font files; re-register the ones
        // that are actually present so the Step 3 preview can resolve them.
        const { importedFonts: restoredFonts } = useSettingsStore.getState();
        if (restoredFonts.length > 0) void loadImportedFonts(restoredFonts);
        toast.success(L("Settings imported"), {
          description:
            restoredFonts.length > 0
              ? "Font names were restored — re-import any .ttf/.otf files that are missing."
              : undefined,
        });
      } else {
        toast.error(L("Import failed"), { description: result.error });
      }
    } catch (error) {
      toast.error(L("Import failed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (settingsInputRef.current) settingsInputRef.current.value = "";
    }
  }

  function handleExportSettings() {
    downloadJson(exportSettings(), settingsBackupFileName());
    toast.success(L("Settings exported"), {
      description: "Includes API keys in plain text — keep the file private.",
    });
  }

  return (
    <>
      <Section
        title={L("Portable settings backup")}
        description={L("Export or import API keys, glossaries, prompts and style presets. Font files themselves are not included — only the list of imported faces.")}
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
          <Button variant="outline" size="sm" className="gap-1.5" onClick={handleExportSettings}>
            <Download className="size-3.5" />
            {L("Export settings (.json)")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => settingsInputRef.current?.click()}
          >
            <Upload className="size-3.5" />
            {L("Import settings (.json)")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground"
            onClick={() => setResetDialogOpen(true)}
          >
            <Trash2 className="size-3.5" />
            {L("Reset defaults")}
          </Button>
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {L("The exported file contains API keys in plain text. Store it somewhere private and never share it.")}
        </p>
      </Section>

      <Dialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{L("Reset all settings?")}</DialogTitle>
            <DialogDescription>
              {L("Restores the default dark studio configuration and clears every API key, imported font reference, glossary pair, style preset and prompt preset. Export a backup first if you need any of them.")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setResetDialogOpen(false)}>
              {L("Cancel")}
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
              {L("Reset")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Updates                                                                    */
/* -------------------------------------------------------------------------- */

function UpdatesSection() {
  const updater = useUpdaterStatus();
  const desktopRuntime = isTauriRuntime();
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const updaterBusy = updater.phase === "checking" || updater.phase === "downloading";

  async function handleCheckForUpdates() {
    if (getUpdaterStatus().phase === "checking") return;
    const result = await checkForUpdates();
    if ("error" in result) {
      toast.error("Update check failed", { description: result.error });
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
    toast.success(L("You are up to date"), {
      description: result.currentVersion
        ? `Tafseer Clipper v${result.currentVersion} is the latest release.`
        : "No newer release was announced.",
    });
  }

  async function handleInstallUpdate() {
    if (installingUpdate) return;
    const pending = getPendingUpdate();
    if (!pending) {
      toast.error(L("No update is staged"), {
        description: "Check for updates again before installing.",
      });
      return;
    }
    setInstallingUpdate(true);
    try {
      const result = await downloadAndInstall(pending);
      if ("error" in result) {
        toast.error(L("Update failed"), { description: result.error });
        return;
      }
      toast.success(L("Update installed"), {
        description: "Restarting Tafseer Clipper to finish the install.",
      });
      try {
        await relaunchApp();
      } catch (error) {
        toast.error(L("Restart failed"), {
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

  return (
    <Section
      title={L("Release channel")}
      description={L("Download the latest release for the installed desktop app. Nothing installs automatically.")}
    >
      <div className="space-y-2 rounded-md border border-border bg-card/40 px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-0.5">
            <p className="text-[11px] text-muted-foreground">{L("App version")}</p>
            <p className="text-xs tabular-nums text-foreground/90">
              {updater.currentVersion
                ? `v${updater.currentVersion}`
                : desktopRuntime
                  ? L("Shown after an update check")
                  : L("Desktop app only")}
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
              {L("Check for updates")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-muted-foreground"
              onClick={() => void openExternalUrl(RELEASES_URL)}
            >
              <ExternalLink className="size-3.5" />
              {L("View all releases")}
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
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Shortcuts                                                                  */
/* -------------------------------------------------------------------------- */

function ShortcutsSection() {
  return (
    <Section title={L("All shortcuts")} description={L("Used across the studio.")}>
      <div className="space-y-1.5">
        {SHORTCUTS.map((shortcut) => (
          <div
            key={shortcut.keys}
            className="flex items-center justify-between gap-4 rounded-md border border-border bg-card/30 px-2.5 py-1.5"
          >
            <div className="min-w-0 space-y-0.5">
              <p className="text-[11px] text-muted-foreground">{shortcut.action}</p>
              <p className="text-[10px] leading-relaxed text-muted-foreground/70">
                {L("Used in:")} {L(shortcut.where)}
              </p>
            </div>
            <kbd className="shrink-0 rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-foreground/80">
              {shortcut.keys}
            </kbd>
          </div>
        ))}
      </div>
    </Section>
  );
}

import { L } from "@/lib/i18n";
/**
 * Full-page "<Stage> configuration" screen.
 *
 * Rendered inside the content area: the recent-lectures bar and the stepper
 * stay in place and the stages stay clickable. The wizard step is kept
 * mounted underneath (hidden), so anything running — a transcription, a
 * render — keeps going. A Back button returns to the step.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ArrowLeft, Loader2, MoveRight, Pencil, Plus, Save, Trash2, Upload } from "lucide-react";

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
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GpuStatusLine } from "@/components/GpuAcceleration";
import { FitBadge } from "@/components/FitBadge";
import { SegmentedToggle } from "@/components/SegmentedToggle";
import { SubtitleFrame } from "@/components/subtitles/SubtitleFrame";
import { importFonts } from "@/lib/api";
import { describeAcceleration } from "@/lib/acceleration";
import {
  sanitizeFileNameTemplate,
  TEMPLATE_TOKEN_HINTS,
  unknownTemplateTokens,
} from "@/lib/filenameTemplate";
import { loadImportedFonts } from "@/lib/fonts";
import { STEP_LABELS, type FramingMode, type Resolution, type WizardStep } from "@/lib/projectTypes";
import { describeProviderGap, resolveSttConnection, whisperFitSentence } from "@/lib/providers";
import {
  nudgeVerticalOffset,
  resolveAssStyles,
  type AssStyle,
  type SubtitleLine,
} from "@/lib/subtitleStyles";
import type { HardwareTier } from "@/lib/api";
import { NUMERIC_LIMITS } from "@/lib/settingsLimits";
import { useProjectStore } from "@/store/projectStore";
import {
  BUILTIN_PRESET_IDS,
  useSettingsStore,
  type ArabicStyle,
  type EditorDefaults,
  type EngineMode,
  type StylePreset,
  type ThaiStyle,
} from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";
import { JudgmentsSection } from "@/components/config/SettingsScreen";
import { cn } from "cn";

import {
  ARABIC_COLORS,
  BOX_OPACITY_PERCENT,
  ColorSwatchField,
  Field,
  LineWidthHint,
  ModelSelect,
  NumberField,
  OUTLINE_COLORS,
  Section,
  SecretInput,
  SwitchRow,
  SYSTEM_FONTS,
  THAI_COLORS,
  presetMatchesStyle,
} from "@/components/config/shared";

const STAGE_DESCRIPTIONS: Record<WizardStep, string> = {
  1: L("Speech-to-text engine and model. Changes save automatically."),
  2: L("Clip finding engine, model and cut buffer. Changes save automatically."),
  3: L("Fonts, Arabic and Thai typography, style presets, and Arabic verification. Changes save automatically."),
  4: L("File names, subtitles and export defaults. Changes save automatically."),
};

/**
 * The fixed sample line the Subtitles config preview draws. It is deliberately
 * generic — the preview exists to judge type, colour and placement, so it must
 * not depend on a session, a clip or anything that has been detected.
 */
const PREVIEW_ARABIC = "إِنَّ مَعَ الْعُسْرِ يُسْرًا";
const PREVIEW_THAI = "แท้จริงความยากลำบากนั้นมีทางออกเสมอ";

export function StageConfig({ step }: { step: WizardStep }) {
  const closeConfig = useUiStore((state) => state.closeConfig);

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex items-center gap-4 border-b border-border px-6 py-4">
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-muted-foreground"
          onClick={closeConfig}
        >
          <ArrowLeft className="size-4" />
          {L("Back")}
        </Button>
        <Separator orientation="vertical" className="h-6" />
        <div className="space-y-0.5">
          <h1 className="text-sm font-medium text-foreground">
            {L(`${STEP_LABELS[step]} configuration`)}
          </h1>
          <p className="text-xs text-muted-foreground">{STAGE_DESCRIPTIONS[step]}</p>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-5 px-8 py-6">
          {step === 1 ? <Stage1Config /> : null}
          {step === 2 ? <Stage2Config /> : null}
          {step === 3 ? <Stage3Config /> : null}
          {step === 4 ? <Stage4Config /> : null}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Stage 1 · Upload & Transcribe                                              */
/* -------------------------------------------------------------------------- */

function Stage1Config() {
  const transcriptionMode = useSettingsStore((state) => state.transcriptionMode);
  const setTranscriptionMode = useSettingsStore((state) => state.setTranscriptionMode);
  const cloud = useSettingsStore((state) => state.cloud);
  const cloudStt = useSettingsStore((state) => state.cloudStt);
  const updateCloudStt = useSettingsStore((state) => state.updateCloudStt);
  const whisper = useSettingsStore((state) => state.whisper);
  const updateWhisper = useSettingsStore((state) => state.updateWhisper);
  const glossary = useSettingsStore((state) => state.glossary);
  const addGlossaryEntry = useSettingsStore((state) => state.addGlossaryEntry);
  const updateGlossaryEntry = useSettingsStore((state) => state.updateGlossaryEntry);
  const removeGlossaryEntry = useSettingsStore((state) => state.removeGlossaryEntry);
  const health = useSettingsStore((state) => state.sidecar.health);

  /** Where Cloud STT uploads: a dedicated speech service, or the AI connection. */
  const sttConnection = resolveSttConnection({ transcriptionMode, cloud, cloudStt });
  const [sttOpen, setSttOpen] = useState(
    () => cloudStt.baseUrl.trim() !== "" || cloudStt.apiKey.trim() !== "",
  );

  const hardwareTier: HardwareTier | undefined = health?.hardware?.tier;
  /** Vendor-neutral acceleration state derived from GET /health. */
  const acceleration = describeAcceleration(health);

  /**
   * Rows where the replacement is typed but the match text is missing cannot
   * be applied (Step 1 skips them). They survive a restart now, so the panel
   * has to say why they are inert instead of letting them look active.
   */
  const incompleteGlossaryCount = glossary.filter(
    (entry) => entry.replace.trim() !== "" && !entry.find.trim(),
  ).length;

  return (
    <>
      <Section
        title={L("Speech-to-text")}
        description="Where transcription runs, and which model it uses. Cloud mode fetches the model list live from the configured speech service."
      >
        <SegmentedToggle<"local" | "cloud">
          label="Speech-to-text engine"
          value={transcriptionMode}
          options={[
            { value: "local", label: L("This computer") },
            { value: "cloud", label: L("AI service (cloud)") },
          ]}
          onChange={setTranscriptionMode}
        />

        {transcriptionMode === "local" ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <FitBadge tier={hardwareTier} />
              <span className="text-[11px] text-muted-foreground">
                {whisperFitSentence(hardwareTier)}
              </span>
            </div>
            <Field label="Model on this computer" hint="Fetched from this machine">
              <ModelSelect
                source="whisper-local"
                label="Local speech-to-text model"
                value={whisper.model}
                onChange={(value) => updateWhisper({ model: value })}
              />
            </Field>
            <Field label="Transcription precision" hint="Precision only">
              <Select
                value={whisper.computeType}
                onValueChange={(value) =>
                  updateWhisper({ computeType: value as typeof whisper.computeType })
                }
              >
                <SelectTrigger className="w-full" aria-label="Transcription precision">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="int8">Standard (recommended)</SelectItem>
                  <SelectItem value="float16">Higher precision</SelectItem>
                  <SelectItem value="float32">Highest precision</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              Transcription uses the GPU automatically when available and falls back to the CPU
              otherwise. Higher precision may be reduced on the CPU.
            </p>
            <SwitchRow
              label="Free up memory after transcription"
              description="Releases the transcription model from GPU memory before rendering. No effect when transcription runs on the CPU."
              checked={whisper.autoUnload}
              onCheckedChange={(checked) => updateWhisper({ autoUnload: checked })}
            />
            <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-card/40 px-3 py-2">
              <GpuStatusLine summary={acceleration} />
            </div>
          </>
        ) : (
          <>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {sttConnection.dedicated
                ? "Uploads the lecture audio to the speech service below."
                : "Uses the AI connection saved in Settings. If that account has no speech-to-text API, add a separate speech service here."}
            </p>
            <Field
              label="Cloud model"
              hint={sttConnection.dedicated ? "From the speech service" : L("From your AI connection")}
            >
              <ModelSelect
                source="cloud"
                label="Cloud speech-to-text model"
                filter="transcribe"
                connection={sttConnection.dedicated ? sttConnection : undefined}
                value={cloudStt.model}
                onChange={(value) => updateCloudStt({ model: value })}
              />
            </Field>
            <SwitchRow
              label="Use the same model for Arabic recitation"
              description="A short Arabic-only clip is re-transcribed when the lecture contains Qur'an, hadith or an Arabic quote. Turn this off if this model cannot transcribe Arabic well."
              checked={!cloudStt.arabicModel.trim()}
              onCheckedChange={(checked) =>
                updateCloudStt({ arabicModel: checked ? "" : cloudStt.model })
              }
            />
            {cloudStt.arabicModel.trim() ? (
              <Field label="Arabic recitation model" hint="Used only for the Arabic pass">
                <ModelSelect
                  source="cloud"
                  label="Arabic recitation model"
                  filter="transcribe"
                  connection={sttConnection.dedicated ? sttConnection : undefined}
                  value={cloudStt.arabicModel}
                  onChange={(value) => updateCloudStt({ arabicModel: value })}
                />
              </Field>
            ) : null}
            {sttOpen ? (
              <>
                <Field label="Speech service address" hint="OpenAI-compatible">
                  <Input
                    value={cloudStt.baseUrl}
                    onChange={(event) => updateCloudStt({ baseUrl: event.target.value })}
                    placeholder="https://api.openai.com/v1"
                    aria-label="Speech service address"
                    spellCheck={false}
                    autoComplete="off"
                  />
                </Field>
                <Field label="Speech service API key">
                  <form onSubmit={(event) => event.preventDefault()}>
                    <SecretInput
                      label="Speech service API key"
                      value={cloudStt.apiKey}
                      onChange={(value) => updateCloudStt({ apiKey: value })}
                      placeholder="sk-…"
                    />
                  </form>
                </Field>
                <div>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      updateCloudStt({ baseUrl: "", apiKey: "" });
                      setSttOpen(false);
                    }}
                  >
                    Use the AI connection for speech instead
                  </Button>
                </div>
              </>
            ) : (
              <div>
                <Button variant="outline" size="xs" onClick={() => setSttOpen(true)}>
                  Use a different speech service
                </Button>
              </div>
            )}
          </>
        )}
      </Section>

      <Separator />

      <Section
        title="Thai–Arabic spelling glossary"
        description="Applied automatically after transcription to fix common spelling variants."
      >
        <div className="space-y-2">
          {glossary.length === 0 ? (
            <p className="text-xs text-muted-foreground">No replacement pairs yet.</p>
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
        <Button variant="outline" size="sm" className="gap-1.5" onClick={addGlossaryEntry}>
          <Plus className="size-3.5" />
          Add pair
        </Button>
      </Section>

      <Separator />

      <JudgmentsSection />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Stage 2 · Find Clips                                                       */
/* -------------------------------------------------------------------------- */

/** Cloud gap note for the AI-model section (first missing connection field). */
function GapNote() {
  const cloud = useSettingsStore((state) => state.cloud);
  const ollama = useSettingsStore((state) => state.ollama);
  const analysisMode = useSettingsStore((state) => state.analysisMode);
  const gap = describeProviderGap({ analysisMode, ollama, cloud });
  if (analysisMode !== "cloud" || !gap) return null;
  return (
    <p className="text-[11px] leading-relaxed text-status-warning">
      Clip finding isn't set up yet: add {gap}.
    </p>
  );
}

function Stage2Config() {
  const analysisMode = useSettingsStore((state) => state.analysisMode);
  const setAnalysisMode = useSettingsStore((state) => state.setAnalysisMode);
  const cloud = useSettingsStore((state) => state.cloud);
  const ollama = useSettingsStore((state) => state.ollama);
  const updateCloud = useSettingsStore((state) => state.updateCloud);
  const updateOllama = useSettingsStore((state) => state.updateOllama);
  const editor = useSettingsStore((state) => state.editor);
  const updateEditor = useSettingsStore((state) => state.updateEditor);

  const engineLabel = analysisMode === "cloud" ? L("AI service (cloud)") : L("This computer");

  return (
    <>
      <Section
        title={L("AI model")}
        description="Clip finding engine and model. Changing the model applies to the next search."
      >
        <SegmentedToggle<EngineMode>
          label="Clip finding engine"
          value={analysisMode}
          options={[
            { value: "local", label: L("This computer") },
            { value: "cloud", label: "Your AI account" },
          ]}
          onChange={setAnalysisMode}
        />
        <Field label="Finding model" hint={engineLabel}>
          {analysisMode === "cloud" ? (
            <ModelSelect
              source="cloud"
              label="Cloud AI model"
              filter="text"
              value={cloud.model}
              onChange={(value) => updateCloud({ model: value })}
            />
          ) : (
            <ModelSelect
              source="ollama"
              label="Local AI model"
              filter="text"
              value={ollama.model}
              onChange={(value) => updateOllama({ model: value })}
            />
          )}
        </Field>

        {analysisMode === "local" && !ollama.model.trim() ? (
          <p className="text-[11px] leading-relaxed text-status-warning">
            Clip finding won't work until you choose a model. Ollama detection lives in
            Settings → AI connection.
          </p>
        ) : null}
        {analysisMode === "cloud" ? (
          <GapNote />
        ) : null}
      </Section>

      <Separator />

      <Section
        title={L("Cut buffer padding")}
        description="Extra headroom kept before and after detected speech so clips never cut mid-word."
      >
        <NumberField
          ariaLabel={L("Cut buffer padding")}
          value={editor.cutBufferSeconds}
          onChange={(value) => updateEditor({ cutBufferSeconds: value })}
          suffix=" s"
          min={NUMERIC_LIMITS.cutBufferSeconds.min}
          max={NUMERIC_LIMITS.cutBufferSeconds.max}
          step={NUMERIC_LIMITS.cutBufferSeconds.step}
        />
      </Section>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Stage 3 · Subtitles                                                        */
/* -------------------------------------------------------------------------- */

interface NumberLimits {
  min: number;
  max: number;
  step: number;
}

/** A numeric style control in the inspector's stacked label + slider rhythm. */
function StyleNumberField({
  label,
  ariaLabel,
  value,
  onChange,
  limits,
  suffix,
}: {
  label: string;
  ariaLabel?: string;
  value: number;
  onChange: (value: number) => void;
  limits: NumberLimits;
  suffix: string;
}) {
  return (
    <NumberField
      layout="stacked"
      ariaLabel={ariaLabel ?? label}
      displayLabel={label}
      value={value}
      onChange={onChange}
      suffix={suffix}
      min={limits.min}
      max={limits.max}
      step={limits.step}
    />
  );
}

/** Font-family row: label on the left, compact trigger on the right. */
function FontFamilyField({
  label,
  ariaLabel,
  value,
  families,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  value: string;
  families: string[];
  onChange: (value: string) => void;
}) {
  const options = useMemo(
    () => (value && !families.includes(value) ? [value, ...families] : families),
    [families, value],
  );
  return (
    <div className="flex items-center justify-between gap-3">
      <Label className="text-[11px] font-medium text-foreground/80">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger
          className="h-7 w-[62%] border-border bg-card/40 text-[11px]"
          aria-label={ariaLabel}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((family) => (
            <SelectItem key={family} value={family} className="text-xs">
              {family}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** A bold on/off row in the same label-left, control-right rhythm. */
function StyleSwitchRow({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[11px] font-medium text-foreground/80">{label}</span>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label={label}
      />
    </div>
  );
}

/** An uppercase inspector section heading with a hairline above it. */
function ControlSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2.5 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <p className="text-[9px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
        {title}
      </p>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

/**
 * A preset library thumbnail: the sample line drawn in that preset's own
 * colours and weight. It is a miniature of the preview, not a screenshot —
 * the point is to tell the themes apart at a glance.
 */
function PresetSwatch({ preset }: { preset: StylePreset }) {
  const arabicSize = Math.round(Math.min(11, Math.max(7, preset.arabic.fontSize * 0.16)) * 10) / 10;
  const thaiSize = Math.round(Math.min(8, Math.max(5.5, preset.thai.fontSize * 0.16)) * 10) / 10;
  return (
    <div className="relative flex aspect-video w-full flex-col items-center justify-end gap-[2px] overflow-hidden rounded-[4px] border border-border bg-[#1b1f23] pb-[7%]">
      <span
        dir="rtl"
        lang="ar"
        className="w-full truncate px-1 text-center leading-tight"
        style={{
          fontFamily: `'${preset.arabic.fontFamily}', 'Noto Naskh Arabic', serif`,
          fontSize: `${arabicSize}px`,
          fontWeight: preset.arabic.bold ? 700 : 400,
          color: preset.arabic.color,
          backgroundColor:
            preset.arabic.boxOpacity > 0
              ? `rgba(0, 0, 0, ${preset.arabic.boxOpacity})`
              : undefined,
        }}
      >
        {PREVIEW_ARABIC}
      </span>
      <span
        lang="th"
        className="w-full truncate px-1 text-center leading-tight"
        style={{
          fontFamily: `'${preset.thai.fontFamily}', 'Leelawadee UI', 'Tahoma', sans-serif`,
          fontSize: `${thaiSize}px`,
          fontWeight: preset.thai.bold ? 700 : 400,
          color: preset.thai.color,
          backgroundColor:
            preset.thai.boxOpacity > 0
              ? `rgba(0, 0, 0, ${preset.thai.boxOpacity})`
              : undefined,
        }}
      >
        {PREVIEW_THAI}
      </span>
    </div>
  );
}

function PresetGrid({
  presets,
  editingPresetId,
  onPick,
}: {
  presets: StylePreset[];
  editingPresetId: string | null;
  onPick: (preset: StylePreset) => void;
}) {
  if (presets.length === 0) {
    return (
      <p className="px-1 py-4 text-center text-[11px] leading-relaxed text-muted-foreground">
        No presets in this group yet.
      </p>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      {presets.map((preset) => {
        const editing = preset.id === editingPresetId;
        return (
          <Button
            key={preset.id}
            type="button"
            variant="ghost"
            onClick={() => onPick(preset)}
            aria-pressed={editing}
            className={cn(
              "h-auto min-w-0 flex-col items-stretch justify-start gap-1.5 rounded-md border p-1.5 text-left font-normal whitespace-normal focus-visible:ring-2 focus-visible:ring-ring",
              editing
                ? "border-ring/50 bg-accent/40 hover:bg-accent/40 dark:hover:bg-accent/40"
                : "border-border bg-card/40 hover:border-ring/30 hover:bg-accent/20 dark:hover:bg-accent/20",
            )}
          >
            <PresetSwatch preset={preset} />
            <span className="min-w-0">
              <span className="block truncate text-[10px] font-medium text-foreground">
                {preset.name}
              </span>
              <span className="block truncate text-[9px] tabular-nums text-muted-foreground">
                AR {preset.arabic.fontSize} · TH {preset.thai.fontSize}
              </span>
            </span>
          </Button>
        );
      })}
    </div>
  );
}

/**
 * The left rail: the preset library, split into the app's built-in themes and
 * the user's saved ones. Picking a card makes that preset the one being edited.
 */
function PresetLibraryPanel({
  presets,
  editingPresetId,
  onPick,
  onNew,
  className,
}: {
  presets: StylePreset[];
  editingPresetId: string | null;
  onPick: (preset: StylePreset) => void;
  onNew: () => void;
  className?: string;
}) {
  const [tab, setTab] = useState<"builtin" | "saved">(() =>
    editingPresetId && !BUILTIN_PRESET_IDS.has(editingPresetId) ? "saved" : "builtin",
  );
  const builtin = presets.filter((preset) => BUILTIN_PRESET_IDS.has(preset.id));
  const saved = presets.filter((preset) => !BUILTIN_PRESET_IDS.has(preset.id));

  useEffect(() => {
    if (!editingPresetId) return;
    setTab(BUILTIN_PRESET_IDS.has(editingPresetId) ? "builtin" : "saved");
  }, [editingPresetId]);

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col gap-2.5 rounded-lg border border-border bg-card/40 p-2.5",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {L("Presets")}
        </p>
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {presets.length}
        </span>
      </div>
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as "builtin" | "saved")}
        className="flex min-h-0 flex-1 flex-col gap-2"
      >
        <TabsList variant="line" className="w-full">
          <TabsTrigger value="builtin" className="flex-1 text-[11px]">
            Built-in · {builtin.length}
          </TabsTrigger>
          <TabsTrigger value="saved" className="flex-1 text-[11px]">
            Saved · {saved.length}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="builtin" className="min-h-0 flex-1 overflow-y-auto">
          <PresetGrid
            presets={builtin}
            editingPresetId={editingPresetId}
            onPick={onPick}
          />
        </TabsContent>
        <TabsContent value="saved" className="min-h-0 flex-1 overflow-y-auto">
          <PresetGrid presets={saved} editingPresetId={editingPresetId} onPick={onPick} />
        </TabsContent>
      </Tabs>
      <Button
        variant="outline"
        size="sm"
        className={cn(
          "w-full gap-1.5 border-dashed text-[11px] text-muted-foreground",
          editingPresetId === null && "border-ring/50 bg-accent/30 text-foreground",
        )}
        onClick={onNew}
      >
        <Plus className="size-3.5" />
        {L("New preset")}
      </Button>
    </div>
  );
}

/** The centre canvas: the live export frame on a near-black surface. */
function StylePreviewCanvas({
  aspect,
  framing = "blur-fill",
  styles,
  onAspectChange,
  showClip,
  onShowClipChange,
  clipAvailable,
  clip,
  offsets,
  onNudgeLine,
  className,
}: {
  aspect: Resolution;
  framing?: FramingMode;
  styles: { arabic: AssStyle; thai: AssStyle };
  onAspectChange: (resolution: Resolution) => void;
  showClip: boolean;
  onShowClipChange: (value: boolean) => void;
  clipAvailable: boolean;
  clip: { sourcePath: string; clipStart: number } | null;
  offsets: { arabic: number; thai: number };
  onNudgeLine: (kind: SubtitleLine, deltaExportPx: number) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-col gap-2.5 rounded-lg border border-border bg-black p-3",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {L("Preview")}
        </p>
        <div className="flex items-center gap-2">
          <label
            className={cn(
              "flex items-center gap-1.5 text-[10px] text-muted-foreground",
              !clipAvailable && "opacity-50",
            )}
            title={
              clipAvailable
                ? "Show a paused frame of the selected clip from Step 3"
                : "Approve a clip in Step 2 to enable this view"
            }
          >
            <Switch
              checked={showClip && clipAvailable}
              disabled={!clipAvailable}
              onCheckedChange={onShowClipChange}
              aria-label={L("Show clip")}
              size="sm"
            />
            {L("Show clip")}
          </label>
          <SegmentedToggle<Resolution>
            label="Preview aspect"
            value={aspect}
            options={[
              { value: "1080x1920", label: "9:16" },
              { value: "1920x1080", label: "16:9" },
            ]}
            onChange={onAspectChange}
            className="w-fit"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <SubtitleFrame
          resolution={aspect}
          framing={framing}
          styles={styles}
          arabic={PREVIEW_ARABIC}
          thai={PREVIEW_THAI}
          video={showClip ? clip : null}
          interactive
          offsets={offsets}
          onNudgeLine={onNudgeLine}
          className="h-full w-full"
        />
      </div>
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        <Badge variant="outline" className="text-[10px] font-normal tabular-nums">
          Arabic {styles.arabic.size}px
        </Badge>
        <Badge variant="outline" className="text-[10px] font-normal tabular-nums">
          Thai {styles.thai.size}px
        </Badge>
      </div>
      <p className="text-center text-[10px] leading-relaxed text-muted-foreground">
        {L("Sample line at export size. Drag a line or use ↑↓ to move it.")}
      </p>
    </div>
  );
}

/** The right rail: one language's typography at a time, in inspector rows. */
function StyleControlsPanel({
  arabic,
  thai,
  editor,
  resolution,
  fontFamilies,
  modified,
  onArabicChange,
  onThaiChange,
  onEditorChange,
  className,
}: {
  arabic: ArabicStyle;
  thai: ThaiStyle;
  editor: EditorDefaults;
  resolution: Resolution;
  fontFamilies: string[];
  modified: boolean;
  onArabicChange: (patch: Partial<ArabicStyle>) => void;
  onThaiChange: (patch: Partial<ThaiStyle>) => void;
  onEditorChange: (patch: Partial<EditorDefaults>) => void;
  className?: string;
}) {
  const [tab, setTab] = useState<"arabic" | "thai">("arabic");

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col rounded-lg border border-border bg-card/40",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {L("Controls")}
        </p>
        {modified ? (
          <Badge variant="outline" className="text-[9px] text-status-warning">
            {L("Modified")}
          </Badge>
        ) : null}
      </div>
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as "arabic" | "thai")}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList variant="line" className="mx-3 mt-2 w-[calc(100%-1.5rem)]">
          <TabsTrigger value="arabic" className="flex-1 text-[11px]">
            {L("Arabic")}
          </TabsTrigger>
          <TabsTrigger value="thai" className="flex-1 text-[11px]">
            {L("Thai")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="arabic" className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="space-y-4">
            <ControlSection title={L("Typography")}>
              <FontFamilyField
                label={L("Font family")}
                ariaLabel="Arabic font family"
                value={arabic.fontFamily}
                families={fontFamilies}
                onChange={(value) => onArabicChange({ fontFamily: value })}
              />
              <ColorSwatchField
                label={L("Color")}
                value={arabic.color}
                onChange={(value) => onArabicChange({ color: value })}
                options={ARABIC_COLORS}
              />
              <ColorSwatchField
                label={L("Outline color")}
                value={arabic.outlineColor}
                onChange={(value) => onArabicChange({ outlineColor: value })}
                options={OUTLINE_COLORS}
              />
              <StyleNumberField
                label={L("Font size")}
                ariaLabel="Arabic font size"
                value={arabic.fontSize}
                onChange={(value) => onArabicChange({ fontSize: value })}
                limits={NUMERIC_LIMITS.arabicFontSize}
                suffix=" px"
              />
              <StyleNumberField
                label={L("Outline width")}
                ariaLabel="Arabic outline width"
                value={arabic.outlineWidth}
                onChange={(value) => onArabicChange({ outlineWidth: value })}
                limits={NUMERIC_LIMITS.arabicOutlineWidth}
                suffix=" px"
              />
              <StyleNumberField
                label="Harakat padding"
                ariaLabel="Arabic harakat padding"
                value={arabic.lineHeightPad}
                onChange={(value) => onArabicChange({ lineHeightPad: value })}
                limits={NUMERIC_LIMITS.arabicLineHeightPad}
                suffix="×"
              />
              <StyleNumberField
                label={L("Box opacity")}
                ariaLabel="Arabic box opacity"
                value={Math.round(arabic.boxOpacity * 100)}
                onChange={(value) => onArabicChange({ boxOpacity: value / 100 })}
                limits={BOX_OPACITY_PERCENT}
                suffix="%"
              />
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] font-medium text-foreground/80">Vertical offset</span>
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                    {arabic.verticalOffset > 0
                      ? `+${Math.round(arabic.verticalOffset)}`
                      : Math.round(arabic.verticalOffset)}{" "}
                    px
                  </span>
                  {arabic.verticalOffset !== 0 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="h-5 px-1.5 text-[10px]"
                      onClick={() => onArabicChange({ verticalOffset: 0 })}
                    >
                      {L("Reset")}
                    </Button>
                  ) : null}
                </div>
              </div>
              <StyleSwitchRow
                label={L("Bold")}
                checked={arabic.bold}
                onCheckedChange={(checked) => onArabicChange({ bold: checked })}
              />
            </ControlSection>
          </div>
        </TabsContent>

        <TabsContent value="thai" className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="space-y-4">
            <ControlSection title={L("Typography")}>
              <FontFamilyField
                label={L("Font family")}
                ariaLabel="Thai font family"
                value={thai.fontFamily}
                families={fontFamilies}
                onChange={(value) => onThaiChange({ fontFamily: value })}
              />
              <ColorSwatchField
                label={L("Color")}
                value={thai.color}
                onChange={(value) => onThaiChange({ color: value })}
                options={THAI_COLORS}
              />
              <ColorSwatchField
                label={L("Outline color")}
                value={thai.outlineColor}
                onChange={(value) => onThaiChange({ outlineColor: value })}
                options={OUTLINE_COLORS}
              />
              <StyleNumberField
                label={L("Font size")}
                ariaLabel="Thai font size"
                value={thai.fontSize}
                onChange={(value) => onThaiChange({ fontSize: value })}
                limits={NUMERIC_LIMITS.thaiFontSize}
                suffix=" px"
              />
              <StyleNumberField
                label={L("Outline width")}
                ariaLabel="Thai outline width"
                value={thai.outlineWidth}
                onChange={(value) => onThaiChange({ outlineWidth: value })}
                limits={NUMERIC_LIMITS.thaiOutlineWidth}
                suffix=" px"
              />
              <StyleNumberField
                label={L("Box opacity")}
                ariaLabel="Thai box opacity"
                value={Math.round(thai.boxOpacity * 100)}
                onChange={(value) => onThaiChange({ boxOpacity: value / 100 })}
                limits={BOX_OPACITY_PERCENT}
                suffix="%"
              />
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] font-medium text-foreground/80">Vertical offset</span>
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                    {thai.verticalOffset > 0
                      ? `+${Math.round(thai.verticalOffset)}`
                      : Math.round(thai.verticalOffset)}{" "}
                    px
                  </span>
                  {thai.verticalOffset !== 0 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="h-5 px-1.5 text-[10px]"
                      onClick={() => onThaiChange({ verticalOffset: 0 })}
                    >
                      {L("Reset")}
                    </Button>
                  ) : null}
                </div>
              </div>
              <StyleSwitchRow
                label={L("Bold")}
                checked={thai.bold}
                onCheckedChange={(checked) => onThaiChange({ bold: checked })}
              />
            </ControlSection>

            <ControlSection title={L("Line breaking")}>
              <StyleNumberField
                label={L("Max characters per line")}
                ariaLabel={L("Max characters per line")}
                value={editor.maxCharsPerLine}
                onChange={(value) =>
                  onEditorChange({ maxCharsPerLine: Math.round(value) })
                }
                limits={NUMERIC_LIMITS.maxCharsPerLine}
                suffix=" chars"
              />
              <div className="space-y-1.5">
                <span className="text-[11px] font-medium text-foreground/80">
                  {L("Lines per subtitle")}
                </span>
                <SegmentedToggle<"1" | "2">
                  label={L("Lines per subtitle")}
                  value={String(editor.subtitleMaxLines) as "1" | "2"}
                  options={[
                    { value: "2", label: L("Two") },
                    { value: "1", label: L("One") },
                  ]}
                  onChange={(value) =>
                    onEditorChange({ subtitleMaxLines: value === "1" ? 1 : 2 })
                  }
                  className="w-full"
                />
              </div>
              <LineWidthHint
                fontFamily={thai.fontFamily}
                fontSize={thai.fontSize}
                maxChars={editor.maxCharsPerLine}
                bold={thai.bold}
                resolution={resolution}
                onUseSuggestion={(chars) =>
                  onEditorChange({ maxCharsPerLine: chars })
                }
              />
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                Thai has no inter-word spaces, so cues are broken with
                dictionary-aware word segmentation before the .ass is written.
                Arabic is never character-wrapped.
              </p>
            </ControlSection>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * The live preview styles for a given frame shape, resolved from the editor's
 * current Arabic/Thai settings — the same merge the sidecar performs, so what
 * a preview shows is what the render burns in.
 */
function resolveSubtitleStyles(
  resolution: Resolution,
  arabic: ArabicStyle,
  thai: ThaiStyle,
) {
  return resolveAssStyles(
    resolution,
    {
      font: arabic.fontFamily,
      size: arabic.fontSize,
      primaryColor: arabic.color,
      outline: arabic.outlineWidth,
      outlineColor: arabic.outlineColor,
      boxOpacity: arabic.boxOpacity,
      bold: arabic.bold,
      lineHeightPad: arabic.lineHeightPad,
      verticalOffset: arabic.verticalOffset,
    },
    {
      font: thai.fontFamily,
      size: thai.fontSize,
      primaryColor: thai.color,
      outline: thai.outlineWidth,
      outlineColor: thai.outlineColor,
      boxOpacity: thai.boxOpacity,
      bold: thai.bold,
      lineHeightPad: 1.2,
      verticalOffset: thai.verticalOffset,
    },
  );
}

function Stage3Config() {
  const arabic = useSettingsStore((state) => state.arabic);
  const thai = useSettingsStore((state) => state.thai);
  const updateArabic = useSettingsStore((state) => state.updateArabic);
  const updateThai = useSettingsStore((state) => state.updateThai);
  const presets = useSettingsStore((state) => state.presets);
  const activePresetId = useSettingsStore((state) => state.activePresetId);
  const createPreset = useSettingsStore((state) => state.createPreset);
  const renamePreset = useSettingsStore((state) => state.renamePreset);
  const deletePreset = useSettingsStore((state) => state.deletePreset);
  const applyPreset = useSettingsStore((state) => state.applyPreset);
  const updatePreset = useSettingsStore((state) => state.updatePreset);
  const importedFonts = useSettingsStore((state) => state.importedFonts);
  const fontsDir = useSettingsStore((state) => state.fontsDir);
  const setImportedFonts = useSettingsStore((state) => state.setImportedFonts);
  const editor = useSettingsStore((state) => state.editor);
  const updateEditor = useSettingsStore((state) => state.updateEditor);

  const project = useProjectStore((state) => state.project);

  const fontInputRef = useRef<HTMLInputElement>(null);
  const [importingFonts, setImportingFonts] = useState(false);

  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  /** Aspect chosen inside the Add-preset window; preview-only, never saved. */
  const [presetAspect, setPresetAspect] = useState<Resolution>(editor.resolution);
  /** View-only clip frame in the preset preview; never saved in a preset. */
  const [showClip, setShowClip] = useState(false);
  const presetSnapshotRef = useRef<{
    arabic: ArabicStyle;
    thai: ThaiStyle;
    activePresetId: string | null;
    maxCharsPerLine: number;
    subtitleMaxLines: 1 | 2;
  } | null>(null);

  const fontFamilies = useMemo(() => {
    const families = new Set(SYSTEM_FONTS);
    for (const font of importedFonts) families.add(font.family);
    return [...families].sort((a, b) => a.localeCompare(b));
  }, [importedFonts]);

  const activePreset = activePresetId
    ? (presets.find((item) => item.id === activePresetId) ?? null)
    : null;
  /** The live style drifted from the preset it claims to be. */
  const activePresetModified = activePreset
    ? !presetMatchesStyle(activePreset, arabic, thai)
    : false;

  const presetStyles = useMemo(
    () => resolveSubtitleStyles(presetAspect, arabic, thai),
    [presetAspect, arabic, thai],
  );

  const editingPreset = editingPresetId
    ? (presets.find((item) => item.id === editingPresetId) ?? null)
    : null;
  /** The live style drifted from the preset open in the editor. */
  const editingPresetModified = editingPreset
    ? !presetMatchesStyle(editingPreset, arabic, thai)
    : false;

  /** A paused frame of the selected approved clip, when the session has one. */
  const approvedClips = useMemo(
    () => (project?.clips ?? []).filter((clip) => clip.approved),
    [project?.clips],
  );
  const previewClip =
    approvedClips.find((clip) => clip.id === project?.selectedClipId) ?? approvedClips[0] ?? null;
  const clipPreview =
    project?.sourcePath && previewClip
      ? { sourcePath: project.sourcePath, clipStart: previewClip.start }
      : null;

  /** Drag/arrow moves update the live style, so saving a preset captures them. */
  const nudgePreviewLine = (kind: SubtitleLine, delta: number) => {
    const state = useSettingsStore.getState();
    if (kind === "arabic") {
      updateArabic({
        verticalOffset: nudgeVerticalOffset(
          "arabic",
          presetAspect,
          state.arabic.verticalOffset,
          delta,
        ),
      });
    } else {
      updateThai({
        verticalOffset: nudgeVerticalOffset(
          "thai",
          presetAspect,
          state.thai.verticalOffset,
          delta,
        ),
      });
    }
  };

  function openPresetDialog(preset: StylePreset | null) {
    presetSnapshotRef.current = {
      arabic: { ...arabic },
      thai: { ...thai },
      activePresetId,
      maxCharsPerLine: editor.maxCharsPerLine,
      subtitleMaxLines: editor.subtitleMaxLines,
    };
    if (preset) {
      applyPreset(preset.id);
      setEditingPresetId(preset.id);
      setPresetName(preset.name);
    } else {
      setEditingPresetId(null);
      setPresetName("");
    }
    setPresetAspect(project?.export.resolution ?? editor.resolution);
    setPresetDialogOpen(true);
  }

  function cancelPresetDialog() {
    const snap = presetSnapshotRef.current;
    presetSnapshotRef.current = null;
    if (snap) {
      useSettingsStore.setState((state) => ({
        arabic: snap.arabic,
        thai: snap.thai,
        activePresetId: snap.activePresetId,
        editor: {
          ...state.editor,
          maxCharsPerLine: snap.maxCharsPerLine,
          subtitleMaxLines: snap.subtitleMaxLines,
        },
      }));
    }
    setPresetDialogOpen(false);
  }

  async function handleFontFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setImportingFonts(true);
    try {
      const result = await importFonts(Array.from(files));
      setImportedFonts(result.fonts, result.fonts_dir);
      // Make the new faces resolvable in the Step 3 preview (asset protocol).
      void loadImportedFonts(result.fonts);
      toast.success(L("Custom font imported"), {
        description: result.imported_fonts.join(", "),
      });
    } catch (error) {
      toast.error(L("Font import failed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setImportingFonts(false);
      if (fontInputRef.current) fontInputRef.current.value = "";
    }
  }

  return (
    <>
      <div className="space-y-5">
          <Section
            title={L("Style presets")}
            description={L("One-click themes applied to the preview and the exported subtitles. Open the live style editor to create a new preset or edit an existing one.")}
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
                            {L("Modified")}
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
                      aria-label={`Edit ${preset.name}`}
                      title="Edit preset style and name"
                      onClick={() => openPresetDialog(preset)}
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
              onClick={() => openPresetDialog(null)}
            >
              <Plus className="size-3.5" />
              {L("Add preset")}
            </Button>
          </Section>

          <Separator />

          <Section
            title={L("Fonts")}
            description={L("Fonts available to the app so exported subtitles always render Thai and Uthmani Arabic correctly. Import .TTF/.OTF files or remove ones you no longer need.")}
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
                {L("Import .TTF / .OTF")}
              </Button>
              <span className="text-[11px] text-muted-foreground">
                {importedFonts.length} font
                {importedFonts.length === 1 ? "" : "s"} available
              </span>
            </div>

            {importedFonts.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {importedFonts.map((font) => {
                  const key = `${font.family}::${font.style}`;
                  return (
                    <Badge
                      key={key}
                      variant="secondary"
                      className="font-normal"
                    >
                      {font.family}
                      <span className="ml-1 text-muted-foreground">{font.style}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="ml-1.5 size-4 rounded-sm p-0 text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent"
                        aria-label={`Remove ${font.family} ${font.style}`}
                        onClick={() =>
                          useSettingsStore.getState().removeImportedFont(key)
                        }
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    </Badge>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {L("No fonts imported yet — system fonts are used until you import.")}
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
            title={L("Arabic verification")}
            description={L("Checks each Arabic line in Step 3 against the Qur'an corpus offline. No AI model is used; non-Qur'an lines are reported for manual review.")}
          >
            <p className="text-xs leading-relaxed text-muted-foreground">
              {L("Arabic verification is fully offline — no model selection needed.")}
            </p>
          </Section>
      </div>

      {/* ----------------------------- Preset dialogs ----------------------------- */}
      {/* The style editor: a preset library on the left, the live export frame
          in the middle, and one language's typography on the right. Edits
          apply live in preview; Cancel / Escape reverts unsaved edits and
          Save snapshots the typography under a name. */}
      <Dialog
        open={presetDialogOpen}
        onOpenChange={(open) => {
          if (!open) cancelPresetDialog();
        }}
      >
        <DialogContent className="flex h-[min(92vh,840px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl">
          <DialogHeader className="shrink-0 space-y-3 border-b border-border px-5 py-4 pr-12 text-left sm:px-6">
            <div className="space-y-1">
              <DialogTitle>
                {editingPreset ? L("Edit style preset") : L("New style preset")}
              </DialogTitle>
              <DialogDescription>
                {editingPreset
                  ? "Adjust the typography and name, then save your changes to this preset."
                  : "Tune the Arabic and Thai lines against a live export preview, then save the look as a preset."}
              </DialogDescription>
            </div>
            <div className="max-w-sm space-y-1.5">
              <Label
                htmlFor="preset-name"
                className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground"
              >
                {L("Preset name")}
              </Label>
              <Input
                id="preset-name"
                value={presetName}
                onChange={(event) => setPresetName(event.target.value)}
                placeholder={L("e.g. Lecture gold")}
                aria-label={L("Preset name")}
                autoFocus
                className="h-9"
              />
            </div>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 lg:flex-row lg:overflow-hidden">
            <PresetLibraryPanel
              presets={presets}
              editingPresetId={editingPresetId}
              onPick={(preset) => {
                applyPreset(preset.id);
                setEditingPresetId(preset.id);
                setPresetName(preset.name);
                setPresetAspect(project?.export.resolution ?? editor.resolution);
              }}
              onNew={() => {
                setEditingPresetId(null);
                setPresetName("");
              }}
              className="shrink-0 lg:w-[240px] lg:min-h-0 lg:overflow-hidden"
            />

            <StylePreviewCanvas
              aspect={presetAspect}
              framing={project?.export.framing}
              styles={presetStyles}
              onAspectChange={setPresetAspect}
              showClip={showClip}
              onShowClipChange={setShowClip}
              clipAvailable={clipPreview !== null}
              clip={clipPreview}
              offsets={{ arabic: arabic.verticalOffset, thai: thai.verticalOffset }}
              onNudgeLine={nudgePreviewLine}
              className="min-h-[320px] flex-1 lg:min-h-0"
            />

            <StyleControlsPanel
              arabic={arabic}
              thai={thai}
              editor={editor}
              resolution={presetAspect}
              fontFamilies={fontFamilies}
              modified={editingPresetModified}
              onArabicChange={updateArabic}
              onThaiChange={updateThai}
              onEditorChange={updateEditor}
              className="shrink-0 lg:w-[320px] lg:min-h-0 lg:overflow-hidden"
            />
          </div>

          <DialogFooter className="shrink-0 flex-col gap-2 border-t border-border px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {L("Edits apply live while you tune the style.")}
            </p>
            <div className="flex items-center gap-2 sm:justify-end">
              <Button variant="ghost" size="sm" onClick={cancelPresetDialog}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!presetName.trim()}
                onClick={() => {
                  const name = presetName.trim();
                  presetSnapshotRef.current = null;
                  if (editingPresetId) {
                    updatePreset(editingPresetId);
                    renamePreset(editingPresetId, name);
                    setPresetDialogOpen(false);
                    toast.success(L("Style preset updated"), { description: name });
                  } else {
                    createPreset(name);
                    setPresetDialogOpen(false);
                    toast.success(L("Style preset saved"), { description: name });
                  }
                }}
              >
                {editingPreset ? L("Save changes") : L("Save preset")}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deletingId !== null} onOpenChange={(open) => !open && setDeletingId(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{L("Delete preset?")}</DialogTitle>
            <DialogDescription>
              {L("This removes the saved theme. Current typography stays as it is.")}
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
                toast.success(L("Preset deleted"));
              }}
            >
              {L("Delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Stage 4 · Export                                                           */
/* -------------------------------------------------------------------------- */

function Stage4Config() {
  const editor = useSettingsStore((state) => state.editor);
  const updateEditor = useSettingsStore((state) => state.updateEditor);
  const project = useProjectStore((state) => state.project);
  const applyExportDefaults = useProjectStore((state) => state.applyExportDefaults);

  const templateTokens = unknownTemplateTokens(editor.filenameTemplate);

  return (
    <>
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
              <SelectItem value="th">{L("Thai (with Arabic)")}</SelectItem>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="auto">{L("Auto-detect")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </Section>

    </>
  );
}

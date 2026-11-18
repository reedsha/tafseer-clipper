/**
 * Full-page "<Stage> configuration" screen.
 *
 * Rendered inside the content area: the recent-lectures bar and the stepper
 * stay in place and the stages stay clickable. The wizard step is kept
 * mounted underneath (hidden), so anything running — a transcription, a
 * render — keeps going. A Back button returns to the step.
 */

import { useMemo, useRef, useState } from "react";
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
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { GpuStatusLine } from "@/components/GpuAcceleration";
import { FitBadge } from "@/components/FitBadge";
import { SegmentedToggle } from "@/components/SegmentedToggle";
import { importFonts } from "@/lib/api";
import { describeAcceleration, isGpuEncodingAvailable } from "@/lib/acceleration";
import {
  sanitizeFileNameTemplate,
  TEMPLATE_TOKEN_HINTS,
  unknownTemplateTokens,
} from "@/lib/filenameTemplate";
import { loadImportedFonts } from "@/lib/fonts";
import { STEP_LABELS, type WizardStep } from "@/lib/projectTypes";
import { describeProviderGap, resolveSttConnection, whisperFitSentence } from "@/lib/providers";
import type { HardwareTier } from "@/lib/api";
import { NUMERIC_LIMITS } from "@/lib/settingsLimits";
import { useProjectStore } from "@/store/projectStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";
import { cn } from "cn";

import {
  ARABIC_COLORS,
  BOX_OPACITY_PERCENT,
  ColorSelect,
  Field,
  LineWidthHint,
  ModelSelect,
  NumberField,
  Section,
  SecretInput,
  SwitchRow,
  SYSTEM_FONTS,
  THAI_COLORS,
  presetMatchesStyle,
} from "@/components/config/shared";

const STAGE_DESCRIPTIONS: Record<WizardStep, string> = {
  1: "Speech-to-text engine, model and vocabulary. Changes save automatically.",
  2: "Clip finding uses the model chosen below, plus the cut buffer. Changes save automatically.",
  3: "Fonts, Arabic and Thai typography, style presets, and Arabic verification. Changes save automatically.",
  4: "File names, subtitles and export defaults. Changes save automatically.",
};

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
          Back
        </Button>
        <Separator orientation="vertical" className="h-6" />
        <div className="space-y-0.5">
          <h1 className="text-sm font-medium text-foreground">
            {STEP_LABELS[step]} configuration
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
        title="Speech-to-text"
        description="Where transcription runs, and which model it uses. Cloud mode fetches the model list live from the configured speech service."
      >
        <SegmentedToggle<"local" | "cloud">
          label="Speech-to-text engine"
          value={transcriptionMode}
          options={[
            { value: "local", label: "This computer" },
            { value: "cloud", label: "AI service (cloud)" },
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
            <Field label="Transcription precision">
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
                  <SelectItem value="int8">Automatic (recommended)</SelectItem>
                  <SelectItem value="float16">GPU, more accurate</SelectItem>
                  <SelectItem value="float32">CPU, most compatible</SelectItem>
                </SelectContent>
              </Select>
            </Field>
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
              hint={sttConnection.dedicated ? "From the speech service" : "From your AI connection"}
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
  const cloud = useSettingsStore((state) => state.cloud);
  const ollama = useSettingsStore((state) => state.ollama);
  const updateCloud = useSettingsStore((state) => state.updateCloud);
  const updateOllama = useSettingsStore((state) => state.updateOllama);
  const editor = useSettingsStore((state) => state.editor);
  const updateEditor = useSettingsStore((state) => state.updateEditor);

  const engineLabel = analysisMode === "cloud" ? "AI service (cloud)" : "This computer";

  return (
    <>
      <Section
        title="AI model"
        description="The model that reads the transcript and proposes clips. Changing it applies to the next search."
      >
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
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Stage 3 · Subtitles                                                        */
/* -------------------------------------------------------------------------- */

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
  const verificationProvider = useSettingsStore((state) => state.verificationProvider);
  const updateVerificationProvider = useSettingsStore((state) => state.updateVerificationProvider);

  const fontInputRef = useRef<HTMLInputElement>(null);
  const [importingFonts, setImportingFonts] = useState(false);

  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  /** Rename can only do something when the trimmed name is new and non-empty. */
  const renamingPreset = renamingId
    ? (presets.find((item) => item.id === renamingId) ?? null)
    : null;
  const renameUnchanged = !renameValue.trim() || renameValue.trim() === renamingPreset?.name;

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

  return (
    <>
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
        <Field label="Lines per subtitle" hint="Two keeps a full sentence together">
          <Select
            value={String(editor.subtitleMaxLines)}
            onValueChange={(value) =>
              updateEditor({ subtitleMaxLines: value === "1" ? 1 : 2 })
            }
          >
            <SelectTrigger className="w-full" aria-label="Lines per subtitle">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="2">Two lines (recommended)</SelectItem>
              <SelectItem value="1">One line</SelectItem>
            </SelectContent>
          </Select>
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

      <Separator />

      <Section
        title="Arabic verification"
        description="Checks the Uthmani Quranic/Hadith spelling of each Arabic line in Step 3. Used for Arabic spelling checks only and defaults to the Find Clips model."
      >
        <SegmentedToggle<"inherit" | "local" | "cloud">
          label="Verification model"
          value={verificationProvider.mode}
          options={[
            { value: "inherit", label: "Inherit" },
            { value: "local", label: "This computer" },
            { value: "cloud", label: "AI service" },
          ]}
          onChange={(mode) => updateVerificationProvider({ mode })}
        />
        {verificationProvider.mode === "inherit" ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Uses the same AI model chosen for clip finding. Change it in the Find Clips
            configuration.
          </p>
        ) : (
          <Field
            label="Model"
            hint={
              verificationProvider.mode === "cloud"
                ? "From your AI connection"
                : "Installed Ollama models"
            }
          >
            <ModelSelect
              source={verificationProvider.mode === "cloud" ? "cloud" : "ollama"}
              label="Arabic verification model"
              filter="text"
              value={verificationProvider.model}
              onChange={(value) => updateVerificationProvider({ model: value })}
            />
          </Field>
        )}
      </Section>

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
  const health = useSettingsStore((state) => state.sidecar.health);

  const acceleration = describeAcceleration(health);
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
              : "CPU encoding is in use. Enable GPU acceleration in Settings to turn this on."
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
    </>
  );
}

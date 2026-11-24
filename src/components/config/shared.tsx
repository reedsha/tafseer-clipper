/**
 * Shared building blocks for the configuration screens: the full-page
 * "<Stage> configuration" pages and the Settings screen. Extracted from the
 * former SettingsDrawer so the two surfaces cannot drift.
 */

import { useId, useEffect, useRef, useState, type ReactNode } from "react";
import NumberFlow from "@number-flow/react";
import {
  CheckIcon,
  ChevronDownIcon,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  SearchIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
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
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { listModels, type ModelDetail, type ModelKind } from "@/lib/api";
import { coerceToRange, NUMERIC_LIMITS } from "@/lib/settingsLimits";
import type { Resolution } from "@/lib/projectTypes";
import type { ArabicStyle, StylePreset, ThaiStyle } from "@/store/settingsStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";
import { cn } from "cn";
import { estimateThaiLineFit } from "@/lib/subtitleWidth";

export function Section({
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

export function Field({
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

export function SwitchRow({
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
export function SecretInput({
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
 * The exact-value read-out shared by both NumberFlow layouts. It stays an
 * animated NumberFlow (the contract's animated-number primitive) and doubles
 * as a trigger: clicking it opens a shadcn Popover so a precise value can be
 * typed instead of nudged.
 */
function NumberValueEditor({
  value,
  suffix,
  min,
  max,
  step,
  ariaLabel,
  onCommit,
  className,
}: {
  value: number;
  suffix: string;
  min: number;
  max: number;
  step: number;
  ariaLabel: string;
  onCommit: (value: number) => void;
  className?: string;
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
      onCommit(coerceToRange(parsed, value, { min, max, step }));
    }
    setOpen(false);
  }

  return (
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
          className={cn(
            "h-6 w-16 shrink-0 justify-end px-1.5 text-xs font-normal tabular-nums text-foreground/90",
            className,
          )}
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
  );
}

/**
 * Slider plus an exact-value read-out.
 *
 * `layout="row"` is the compact form used by the settings pages (slider and
 * read-out on one line). `layout="stacked"` is the inspector form used by the
 * style editor: label and read-out on the first line, the slider full width
 * beneath — the same row rhythm as a colour channel or mixer strip.
 */
export function NumberField({
  value,
  onChange,
  suffix,
  min,
  max,
  step = 1,
  ariaLabel,
  layout = "row",
  displayLabel,
}: {
  value: number;
  onChange: (value: number) => void;
  suffix: string;
  min: number;
  max: number;
  step?: number;
  ariaLabel: string;
  layout?: "row" | "stacked";
  /** Short visible label; `ariaLabel` stays the distinct accessible name. */
  displayLabel?: string;
}) {
  const slider = (
    <Slider
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={([next]) => onChange(next)}
      aria-label={ariaLabel}
    />
  );
  const editor = (
    <NumberValueEditor
      value={value}
      suffix={suffix}
      min={min}
      max={max}
      step={step}
      ariaLabel={ariaLabel}
      onCommit={onChange}
      className={
        layout === "stacked"
          ? "h-5 w-14 px-1 text-[11px] text-muted-foreground hover:text-foreground"
          : undefined
      }
    />
  );

  if (layout === "stacked") {
    return (
      <div className="space-y-1.5" data-vaul-no-drag>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] font-medium text-foreground/80">
            {displayLabel ?? ariaLabel}
          </span>
          {editor}
        </div>
        {slider}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3" data-vaul-no-drag>
      {slider}
      {editor}
    </div>
  );
}

/**
 * Width sanity check for the pair that decides how wide a Thai line renders:
 * `maxCharsPerLine` x the Thai font size. The `.ass` column is the frame
 * minus its side margins, so a line past it reaches the frame edge.
 */
export function LineWidthHint({
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
          {fit.room >= NUMERIC_LIMITS.maxCharsPerLine.min ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => onUseSuggestion(fit.suggestedMaxChars)}
            >
              Use {fit.suggestedMaxChars} chars
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function ColorSelect({
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

/**
 * Colour row in the inspector rhythm: label on the left, the current swatch
 * and its hex value on the right. The trigger opens a shadcn Popover with the
 * palette; the swatch itself is content colour, never a theme token.
 */
export function ColorSwatchField({
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
    <div className="flex items-center justify-between gap-3">
      <Label className="text-[11px] font-medium text-foreground/80">{label}</Label>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="h-6 gap-1.5 px-1.5 text-[11px] font-normal text-muted-foreground hover:text-foreground"
            aria-label={label}
          >
            <span
              className="size-3 rounded-full border border-border"
              style={{ backgroundColor: value }}
            />
            <span className="font-mono tabular-nums">{value}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-48 p-1">
          {withCurrentColor(options, value).map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
            >
              <span
                className="size-3 shrink-0 rounded-full border border-border"
                style={{ backgroundColor: option.value }}
              />
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              <span className="font-mono text-[10px] text-muted-foreground">
                {option.value}
              </span>
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
}

export const ARABIC_COLORS = [
  { value: "#dcb46e", label: "Warm gold" },
  { value: "#e2c07c", label: "Pale gold" },
  { value: "#f0f0ec", label: "Soft white" },
];

export const THAI_COLORS = [
  { value: "#f4f4f1", label: "Crisp white" },
  { value: "#efece4", label: "Warm white" },
  { value: "#dcb46e", label: "Gold" },
];

export const SYSTEM_FONTS = [
  "Leelawadee UI",
  "Tahoma",
  "Noto Naskh Arabic",
  "Traditional Arabic",
  "Segoe UI",
];

export const AUTOSAVE_OPTIONS = [
  { value: "0", label: "Off" },
  { value: "5000", label: "Every 5 seconds" },
  { value: "15000", label: "Every 15 seconds" },
  { value: "30000", label: "Every 30 seconds" },
  { value: "60000", label: "Every minute" },
];

export const SHORTCUTS = [
  {
    keys: "Space",
    action: "Play / pause",
    where: "Step 2 preview · Step 3 Output preview",
  },
  {
    keys: "J K L",
    action: "Shuttle backward / pause / forward",
    where: "Step 2 preview · Step 3 Output preview",
  },
  {
    keys: "← →",
    action: "Move the preview playhead 1 s",
    where: "Step 2 · waveform & trim",
  },
  {
    keys: "Shift ← →",
    action: "Nudge clip cut-in edge",
    where: "Step 2 · waveform & trim",
  },
  {
    keys: "Alt ← →",
    action: "Nudge clip cut-out edge",
    where: "Step 2 · waveform & trim",
  },
  {
    keys: "← →",
    action: "Previous / next subtitle cue",
    where: "Step 3 · Subtitle lines & Output preview",
  },
  {
    keys: "Enter",
    action: "Mark reviewed & go to next cue",
    where: "Step 3 · Subtitle lines",
  },
  {
    keys: "Escape",
    action: "Exit subtitle preview focus",
    where: "Step 3 · Output preview (focus mode)",
  },
  {
    keys: "Ctrl Enter",
    action: "Split subtitle at cursor",
    where: "Step 3 · Subtitle lines editor",
  },
  {
    keys: "Ctrl K",
    action: "Command palette",
    where: "Any step · Command palette",
  },
];

/** The 0–100 % view of the stored 0–1 box-opacity fraction. */
export const BOX_OPACITY_PERCENT = {
  min: NUMERIC_LIMITS.boxOpacity.min * 100,
  max: NUMERIC_LIMITS.boxOpacity.max * 100,
  step: NUMERIC_LIMITS.boxOpacity.step * 100,
};

/** True when every Arabic/Thai field still equals the saved preset. */
export function presetMatchesStyle(
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
export function settingsBackupFileName(now = new Date()): string {
  return `tafseer-settings-${now.toISOString().slice(0, 10)}.json`;
}

export function withCurrentColor(
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
export function withCurrentInterval(
  options: { value: string; label: string }[],
  currentMs: number,
): { value: string; label: string }[] {
  const value = String(currentMs);
  return options.some((option) => option.value === value)
    ? options
    : [...options, { value, label: formatIntervalLabel(currentMs) }];
}

export function downloadJson(text: string, fileName: string): void {
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
export function updaterStatusText(status: {
  phase: string;
  currentVersion?: string | null;
  version?: string | null;
  progress: number | null;
  message?: string | null;
  notes?: string | null;
}): ReactNode {
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

/**
 * Model chooser with no hard-coded lists. Cloud services are queried live
 * through the sidecar (`POST /list-models`); local choices come from what the
 * machine actually has (installed Ollama models / downloaded Whisper models,
 * both reported by `GET /health`). A "Custom…" escape hatch accepts any model
 * name the fetched or scanned list does not know yet.
 */
interface CloudCacheEntry {
  models: string[];
  details: ModelDetail[] | null;
}

const cloudModelCache = new Map<string, CloudCacheEntry>();

export type ModelSelectSource = "cloud" | "ollama" | "whisper-local";
export type ModelCapabilityFilter = "transcribe" | "text" | "decision";

/**
 * `POST /list-models` returns a flat list of IDs with no capability field, so
 * the model pickers classify by name. Whisper-family and other speech
 * recognition identifiers count as transcription models; the text picker
 * shows everything else (chat / completion LLMs).
 */
const TRANSCRIPTION_MODEL_PATTERN =
  /whisper|transcri|\basr\b|\bspeech\b|\bstt\b|\b(?:tiny|base|small|medium|large)-v\d/i;

/**
 * Mirrors `backend/main.py::_DECISION_MODEL_PATTERN`. The decision picker
 * narrows by this name pattern: only familiar decision-family ids are offered,
 * and non-matching ids are hidden. The "Custom model name…" free-text input is
 * the escape hatch for models with unfamiliar names.
 */
const DECISION_MODEL_PATTERN =
  /jev|decider|tev|laya|kev|nimble|strands-decider|systemone|system-one/i;

function isTranscriptionModel(name: string): boolean {
  return TRANSCRIPTION_MODEL_PATTERN.test(name);
}

function filterModels(
  names: string[],
  filter: ModelCapabilityFilter | undefined,
): string[] {
  if (!filter) return names;
  if (filter === "decision") {
    // Deliberate name-based narrowing: only familiar decision-family names are
    // offered. A model with an unfamiliar name cannot be proven capable by its
    // name alone, so it is hidden — the "Custom model name…" input below is the
    // escape hatch for those cases.
    return names.filter((name) => DECISION_MODEL_PATTERN.test(name));
  }
  return names.filter((name) =>
    filter === "transcribe" ? isTranscriptionModel(name) : !isTranscriptionModel(name),
  );
}

/**
 * Group the fetched model ids by capability for the picker. Transcribe/text
 * filters classify from the sidecar's `models_detail` metadata when present;
 * unknown-kind models are never silently dropped and surface in an "Other
 * models" expandable row. When no metadata at all is available (older sidecar)
 * we fall back to today's name-based heuristic and hide nothing. Decision
 * narrows strictly by name (see filterModels) and produces no "Other" group —
 * non-matching names are hidden, not bucketed.
 */
function buildModelGroups(
  names: string[],
  filter: ModelCapabilityFilter | undefined,
  detailById: Map<string, ModelKind>,
  hasDetailMeta: boolean,
): { main: string[]; unknown: string[] } {
  if (!filter) return { main: [...names], unknown: [] };
  if (filter === "decision") return { main: filterModels(names, "decision"), unknown: [] };
  if (hasDetailMeta) {
    const wanted = filter === "transcribe" ? "speech" : "text";
    const main: string[] = [];
    const unknown: string[] = [];
    for (const name of names) {
      const kind = detailById.get(name);
      if (kind === wanted) main.push(name);
      else if (kind === "unknown" || kind === undefined) unknown.push(name);
    }
    return { main, unknown };
  }
  return { main: filterModels(names, filter), unknown: [] };
}

export function ModelSelect({
  source,
  value,
  onChange,
  label,
  connection,
  filter,
}: {
  source: ModelSelectSource;
  value: string;
  onChange: (value: string) => void;
  label: string;
  /**
   * Connection override for `source === "cloud"` — used by the speech service,
   * which may be a different account from the AI connection. Omit to use the
   * shared AI connection saved in Settings.
   */
  connection?: { baseUrl: string; apiKey: string };
  /** Restrict the fetched models by capability (speech-to-text vs text LLM). */
  filter?: ModelCapabilityFilter;
}) {
  const cloud = useSettingsStore((state) => state.cloud);
  const health = useSettingsStore((state) => state.sidecar.health);
  const refreshHealth = useSettingsStore((state) => state.refreshHealth);
  const openSettings = useUiStore((state) => state.openSettings);

  const baseUrl = (connection?.baseUrl ?? cloud.baseUrl).trim();
  const apiKey = (connection?.apiKey ?? cloud.apiKey).trim();
  const dedicated = connection !== undefined;
  // Keys are part of the cache key: two accounts can share one base URL.
  // The server-side capability filter changes the returned list, so it is part
  // of the key too.
  const cacheKey = `${baseUrl}\u0000${apiKey}\u0000${filter ?? ""}`;

  const [fetched, setFetched] = useState<CloudCacheEntry | null>(() =>
    source === "cloud" ? (cloudModelCache.get(cacheKey) ?? null) : null,
  );
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [custom, setCustom] = useState(false);
  const [open, setOpen] = useState(false);
  const [showOthers, setShowOthers] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // The shared AI connection needs its key; a dedicated speech service may be
  // keyless (for example a local OpenAI-compatible server).
  const cloudReady = baseUrl !== "" && (dedicated || apiKey !== "");

  const load = (signal: AbortSignal) => {
    setFetching(true);
    setFetchError(null);
    return listModels(
      {
        base_url: baseUrl,
        api_key: apiKey,
        filter: filter === "decision" ? "decision" : undefined,
      },
      signal,
    )
      .then((result) => {
        const entry: CloudCacheEntry = {
          models: result.models,
          details: result.models_detail ?? null,
        };
        cloudModelCache.set(cacheKey, entry);
        setFetched(entry);
      })
      .catch((error: unknown) => {
        if (signal.aborted) return;
        setFetchError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!signal.aborted) setFetching(false);
      });
  };

  useEffect(() => {
    if (source !== "cloud") return;
    if (!cloudReady) {
      setFetched(null);
      setFetchError(null);
      return;
    }
    const cached = cloudModelCache.get(cacheKey);
    if (cached) {
      setFetched(cached);
      setFetchError(null);
      return;
    }
    // Debounce: the key/address inputs update the store per keystroke.
    let controller: AbortController | null = null;
    const timer = window.setTimeout(() => {
      controller = new AbortController();
      void load(controller.signal);
    }, 600);
    return () => {
      window.clearTimeout(timer);
      controller?.abort();
    };
    // `load` closes over the same connection fields listed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, cloudReady, baseUrl, apiKey, cacheKey]);

  const cloudEntry = source === "cloud" ? fetched : null;

  const allModels =
    source === "ollama"
      ? (health?.providers?.ollama?.models ?? [])
      : source === "whisper-local"
        ? (health?.providers?.whisper_local?.models ?? [])
        : (cloudEntry?.models ?? []);

  const detailSource =
    source === "ollama"
      ? (health?.providers?.ollama?.models_detail ?? null)
      : source === "cloud"
        ? (cloudEntry?.details ?? null)
        : null;
  const hasDetailMeta = Array.isArray(detailSource) && detailSource.length > 0;
  const detailById = new Map<string, ModelKind>();
  for (const detail of detailSource ?? []) {
    if (detail && typeof detail.id === "string") detailById.set(detail.id, detail.kind);
  }

  const groups = buildModelGroups(allModels, filter, detailById, hasDetailMeta);
  let main = groups.main;
  let unknown = groups.unknown;
  // Keep the current selection visible even when the filters hide it.
  if (value.trim() !== "" && allModels.includes(value) && !main.includes(value)) {
    main = [value, ...main];
  }

  const search = query.trim().toLowerCase();
  const mainMatches = search ? main.filter((name) => name.toLowerCase().includes(search)) : main;
  const otherMatches = search ? unknown.filter((name) => name.toLowerCase().includes(search)) : unknown;
  const totalVisible = main.length + unknown.length;
  const valueKnown = allModels.includes(value);
  const showCustomInput = custom || (value.trim() !== "" && !valueKnown);

  function refresh() {
    if (source === "cloud") {
      if (!cloudReady) return;
      cloudModelCache.delete(cacheKey);
      const controller = new AbortController();
      void load(controller.signal);
      return;
    }
    void refreshHealth({ force: true });
  }

  return (
    <div className="space-y-1.5">
      {source === "ollama" &&
      filter === "decision" &&
      health?.providers?.ollama?.detected &&
      !health.providers.decision_endpoint ? (
        <div className="rounded-md border border-status-warning/30 bg-status-warning/10 px-3 py-2.5">
          <p className="text-[11px] leading-relaxed text-status-warning">
            This local AI server is too old for fast judgments. Update Ollama, or
            choose “Your AI account” above.
          </p>
        </div>
      ) : null}
      {source === "cloud" && !cloudReady ? (
        <div className="space-y-2 rounded-md border border-status-warning/30 bg-status-warning/10 px-3 py-2.5">
          <p className="text-[11px] leading-relaxed text-status-warning">
            {dedicated
              ? "Add the speech service address above first — this list is fetched from that service."
              : "Add the server address and API key in Settings first — this list is fetched from that connection."}
          </p>
          {dedicated ? null : (
            <Button variant="outline" size="xs" onClick={() => openSettings("connection")}>
              Open Settings
            </Button>
          )}
        </div>
      ) : fetching ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-card/40 px-3 py-2.5 text-[11px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Fetching available models…
        </div>
      ) : fetchError ? (
        <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5">
          <p className="text-[11px] leading-relaxed text-destructive">{fetchError}</p>
          <Button variant="outline" size="xs" onClick={refresh}>
            <RefreshCw className="size-3" />
            Try again
          </Button>
        </div>
      ) : totalVisible === 0 ? (
        <div className="space-y-2 rounded-md border border-border bg-card/40 px-3 py-2.5">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {source === "whisper-local"
              ? "No speech models are downloaded on this computer yet. The first transcription downloads the model you type here."
              : source === "ollama"
                ? "Ollama isn't detected or has no models installed yet."
                : allModels.length > 0
                  ? filter === "transcribe"
                    ? "None of these models look like speech-to-text models. Type the exact name below if your provider names them differently."
                    : filter === "decision"
                      ? "No decision-style models found — type the exact name below."
                      : "All of these models look like speech-to-text models. Type the exact name below if your provider names them differently."
                  : "The service did not report any models."}
          </p>
          {source !== "cloud" ? (
            <Button variant="outline" size="xs" onClick={refresh}>
              <RefreshCw className="size-3" />
              Check again
            </Button>
          ) : null}
          <Input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="Type the model name"
            aria-label={`${label} (custom)`}
            spellCheck={false}
            className="text-xs"
          />
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Popover
              open={open}
              onOpenChange={(next) => {
                setOpen(next);
                if (!next) setQuery("");
              }}
            >
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={label}
                  className={cn(
                    "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50",
                    !value.trim() && "text-muted-foreground",
                  )}
                >
                  <span className="line-clamp-1 text-left">
                    {value.trim() || "Choose a model"}
                  </span>
                  <ChevronDownIcon className="size-4 shrink-0 opacity-50" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                collisionPadding={12}
                className="max-h-(--radix-popover-content-available-height) w-[var(--radix-popover-trigger-width)] overflow-hidden p-0"
                onOpenAutoFocus={(event) => {
                  event.preventDefault();
                  requestAnimationFrame(() => searchRef.current?.focus());
                }}
              >
                <div className="border-b p-2">
                  <div className="relative">
                    <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      ref={searchRef}
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Search models…"
                      aria-label={`Search ${label}`}
                      spellCheck={false}
                      className="h-8 pl-8 text-xs"
                    />
                  </div>
                </div>
                {/* A plain scroll container gives a definite cap that actually
                    scrolls. The shadcn ScrollArea Root only had max-height with
                    overflow:visible, so its size-full viewport grew to the full
                    list and the options painted outside the popover with no
                    way to reach them. */}
                <div className="max-h-60 overflow-y-auto overscroll-contain">
                  <div className="p-1">
                    {mainMatches.length === 0 && unknown.length === 0 ? (
                      <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                        {search
                          ? `No models match “${query.trim()}”.`
                          : "No models to choose from."}
                      </p>
                    ) : (
                      <>
                        {mainMatches.length > 0 ? (
                          <div role="listbox" aria-label={label}>
                            {mainMatches.map((model) => (
                              <button
                                key={model}
                                type="button"
                                role="option"
                                aria-selected={model === value}
                                onClick={() => {
                                  setCustom(false);
                                  onChange(model);
                                  setOpen(false);
                                }}
                                className={cn(
                                  "flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-xs outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground",
                                  model === value && "bg-accent/60",
                                )}
                              >
                                <span className="truncate">{model}</span>
                                {model === value ? (
                                  <CheckIcon className="size-3.5 shrink-0" />
                                ) : null}
                              </button>
                            ))}
                          </div>
                        ) : null}
                        {unknown.length > 0 ? (
                          <>
                            <button
                              type="button"
                              onClick={() => setShowOthers((current) => !current)}
                              aria-expanded={showOthers}
                              aria-label={`Other models (${unknown.length})`}
                              className="mt-1 flex w-full items-center justify-between gap-2 rounded-sm border-t border-border px-2 py-1.5 text-left text-xs text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
                            >
                              <span>Other models ({unknown.length})</span>
                              <ChevronDownIcon
                                className={cn(
                                  "size-3.5 transition-transform",
                                  showOthers && "rotate-180",
                                )}
                              />
                            </button>
                            {showOthers ? (
                              <div
                                role="listbox"
                                aria-label={`Other models for ${label}`}
                                className="pt-1"
                              >
                                {otherMatches.length > 0 ? (
                                  otherMatches.map((model) => (
                                    <button
                                      key={model}
                                      type="button"
                                      role="option"
                                      aria-selected={model === value}
                                      onClick={() => {
                                        setCustom(false);
                                        onChange(model);
                                        setOpen(false);
                                      }}
                                      className={cn(
                                        "flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-xs outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground",
                                        model === value && "bg-accent/60",
                                      )}
                                    >
                                      <span className="truncate">{model}</span>
                                      {model === value ? (
                                        <CheckIcon className="size-3.5 shrink-0" />
                                      ) : null}
                                    </button>
                                  ))
                                ) : (
                                  <p className="px-2 py-1.5 text-center text-[11px] text-muted-foreground">
                                    No other models match “{query.trim()}”.
                                  </p>
                                )}
                              </div>
                            ) : null}
                          </>
                        ) : null}
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setCustom(true);
                        setOpen(false);
                      }}
                      className="mt-1 flex w-full items-center gap-2 rounded-sm border-t border-border px-2 py-1.5 text-left text-xs text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
                    >
                      Custom model name…
                    </button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Refresh ${label} list`}
              title="Refresh the model list"
              onClick={refresh}
            >
              <RefreshCw className="size-3.5" />
            </Button>
          </div>
          {showCustomInput ? (
            <Input
              value={value}
              onChange={(event) => onChange(event.target.value)}
              placeholder="Type the exact model name"
              aria-label={`${label} (custom)`}
              spellCheck={false}
              className="text-xs"
            />
          ) : null}
        </>
      )}
    </div>
  );
}

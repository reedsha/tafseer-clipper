/**
 * Windows-safe filename templates.
 *
 * The sidecar owns the final name (`backend/main.py::_sanitize_filename` and
 * `_apply_template`). This module mirrors that logic so Step 4 can show the
 * editor the *exact* file name that will be written before the batch starts.
 * Keep both implementations in sync.
 */

/** Windows forbids these characters in a file name. */
const FORBIDDEN = /[<>:"/\\|?*]/g;

/**
 * Windows reserved device names. A name whose stem (text before the first dot)
 * matches one of these cannot be created, with or without an extension.
 */
const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * The sidecar also replaces ASCII control codes (U+0000-U+001F) with an
 * underscore. Written as an explicit code-point walk so the source file stays
 * free of literal control bytes.
 */
function replaceControlChars(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    out += code < 32 ? "_" : char;
  }
  return out;
}

/** Windows rejects names that end in a dot or a space. */
function stripTrailingDotsAndSpaces(value: string): string {
  return value.replace(/[. ]+$/, "");
}

/** Prefix a reserved device stem (`CON`, `COM1`, …) so the name is writable. */
function avoidReservedDeviceName(value: string): string {
  const stem = value.split(".")[0];
  return RESERVED_DEVICE_NAME.test(stem) ? `_${value}` : value;
}

/** Matches the sidecar's `_sanitize_filename`. */
export function sanitizeWindowsFileName(name: string, fallback = "file"): string {
  let cleaned = replaceControlChars(name).replace(FORBIDDEN, "_").trim();
  cleaned = cleaned.replace(/\s+/g, " ");
  cleaned = stripTrailingDotsAndSpaces(cleaned);
  cleaned = avoidReservedDeviceName(cleaned);
  return cleaned.slice(0, 150) || fallback;
}

/**
 * Sanitize a filename *template* the same way the sidecar sanitizes rendered
 * names, while keeping `{Token}` placeholders intact. Shared with the Settings
 * drawer so its preview matches the exported file names.
 */
export function sanitizeFileNameTemplate(template: string): string {
  let cleaned = replaceControlChars(template).replace(FORBIDDEN, "_");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return stripTrailingDotsAndSpaces(cleaned);
}


/** `Path(...).stem` — the source file name without its last extension. */
export function fileStem(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const slash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  const name = normalized.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** `Path(...).parent` — the folder that holds the file. */
export function fileParent(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const slash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (slash < 0) return "";
  return normalized.slice(0, slash);
}

export interface TemplateTokens {
  /** `{LectureName}` — the source video's stem. */
  lectureName: string;
  /** `{Title}` — the clip title. */
  title: string;
  /** Clip index, 0-based. */
  index: number;
  /** `{Resolution}` — e.g. `1080x1920`. */
  resolution: string;
}

/**
 * Resolve a filename template exactly like the sidecar's `_apply_template`.
 * `template` may contain `{LectureName}`, `{Title}`, `{Clip}`, `{Resolution}`
 * and generic zero-padded tokens such as `{01}` or `{001}`.
 */
export function applyFileNameTemplate(template: string, tokens: TemplateTokens): string {
  let rendered = template;
  rendered = rendered.split("{LectureName}").join(tokens.lectureName);
  rendered = rendered.split("{Title}").join(sanitizeWindowsFileName(tokens.title, "clip"));
  rendered = rendered.split("{Clip}").join(String(tokens.index + 1).padStart(2, "0"));
  rendered = rendered.split("{Resolution}").join(tokens.resolution);
  rendered = rendered.replace(/\{(\d{2,3})\}/g, (_match, digits: string) =>
    String(tokens.index + 1).padStart(digits.length, "0"),
  );
  return sanitizeWindowsFileName(rendered, `clip_${String(tokens.index + 1).padStart(2, "0")}`);
}

/**
 * Full output name for one clip, including the sidecar's `.mp4` fallback and
 * the duplicate-name guard. The guard is iterative: `_NN` suffixes keep
 * incrementing until the name is genuinely unused, so a clip titled `Intro_03`
 * can never collide with the generated `Intro_03.mp4`.
 */
export function resolveClipFileName(
  template: string,
  tokens: TemplateTokens,
  usedNames: Set<string>,
): string {
  let name = applyFileNameTemplate(template, tokens);
  if (!name.toLowerCase().endsWith(".mp4")) name += ".mp4";
  if (!usedNames.has(name)) {
    usedNames.add(name);
    return name;
  }

  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  // Start from the sidecar's `index + 1` suffix, then keep re-checking.
  let attempt = tokens.index + 1;
  let candidate = `${stem}_${String(attempt).padStart(2, "0")}${extension}`;
  while (usedNames.has(candidate)) {
    attempt += 1;
    candidate = `${stem}_${String(attempt).padStart(2, "0")}${extension}`;
  }
  usedNames.add(candidate);
  return candidate;
}

/** The sidecar's default output folder: `<source folder>\exports`. */
export function defaultOutputDirectory(sourcePath: string | null): string {
  if (!sourcePath) return "";
  const parent = fileParent(sourcePath);
  return parent ? `${parent}\\exports` : "exports";
}

export const TEMPLATE_TOKEN_HINTS: { token: string; description: string }[] = [
  { token: "{LectureName}", description: "Source video name" },
  { token: "{Title}", description: "Clip title" },
  { token: "{Clip}", description: "Clip number (01)" },
  { token: "{01}", description: "Zero-padded number" },
  { token: "{Resolution}", description: "1080x1920" },
];

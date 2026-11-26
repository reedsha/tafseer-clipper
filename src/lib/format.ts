/** Small formatting helpers shared by the wizard screens. */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export type ClockPrecision = boolean | "tenths" | "hundredths";

/** `12:34` or `1:02:03`, with optional tenths or hundredths (rounded before carry). */
export function formatClock(seconds: number, precision: ClockPrecision = false): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const digits =
    precision === "hundredths" ? 2 : precision === true || precision === "tenths" ? 1 : 0;
  const scale = 10 ** digits;
  const total = Math.round(safe * scale);
  const fraction = scale > 1 ? total % scale : 0;
  const whole = Math.floor(total / scale);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const wholeSeconds = whole % 60;
  const base =
    hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}`
      : `${minutes}:${String(wholeSeconds).padStart(2, "0")}`;
  return digits > 0 ? `${base}.${String(fraction).padStart(digits, "0")}` : base;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}

export function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^./\\]+$/, "");
}

export function fileNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || path;
}

export function relativeTime(timestamp: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/**
 * Lecture duration for the Recent Lectures surfaces, switching to minutes at
 * the hour boundary so a 45 s lecture never reads as "1 min". The caller
 * renders the parts with NumberFlow.
 */
export function formatLectureDuration(seconds: number): { value: number; suffix: string } {
  if (seconds >= 60) {
    return { value: Math.round(seconds / 60), suffix: " min" };
  }
  return { value: Math.max(0, Math.round(seconds)), suffix: " s" };
}

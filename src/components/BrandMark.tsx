import { cn } from "cn";

/**
 * The Tafseer Clipper brand mark: an eight-point (rub el hizb) frame with
 * diamond nodes, pointed arches, an open book and an eight-point star.
 *
 * Drawn with `currentColor` so chrome controls the tone — never hardcode a
 * colour here (AGENTS.md §2: chrome colours come from the token system).
 *
 * Two variants mirror the identity sheet:
 * - `bold`  — heavy strokes, simplified motif (two arches) for small chrome:
 *   header, dialogs, tray-scale UI. Thin detail turns to mud below ~48 px.
 * - `fine`  — full editorial detail (three arches) for large, calm surfaces:
 *   the startup splash and empty states.
 *
 * Geometry twin: `public/brand-mark.svg` (fine, hardcoded cream) and
 * `src-tauri/icons/icon-source.svg` (bold, on the cream tile). Keep all
 * three in sync when the mark evolves.
 */

interface BrandMarkProps {
  variant?: "bold" | "fine";
  className?: string;
}

const FRAME =
  "M48 6 58.5 22.6 77.7 18.3 73.4 37.5 90 48 73.4 58.5 77.7 77.7 58.5 73.4 48 90 37.5 73.4 18.3 77.7 22.6 58.5 6 48 22.6 37.5 18.3 18.3 37.5 22.6Z";

const STAR =
  "M48 16 49.4 21.1 54 18.5 51.4 23.1 56.5 24.5 51.4 25.9 54 30.5 49.4 27.9 48 33 46.6 27.9 42 30.5 44.6 25.9 39.5 24.5 44.6 23.1 42 18.5 46.6 21.1Z";

/* Arches rise from the book's top edge — the book is the visual floor. */
const ARCH_LEFT = "M30 58 30 44Q30 34 36 30Q42 34 42 44L42 58";
const ARCH_RIGHT = "M54 58 54 44Q54 34 60 30Q66 34 66 44L66 58";
/** Center arch: shorter, sits between the tall pair — fine variant only. */
const ARCH_CENTER = "M44 60 44 48Q44 43 48 40.5Q52 43 52 48L52 60";

const BOOK =
  "M26 57C33 54 42 55.5 48 60.5C54 55.5 63 54 70 57L70 70C63 67.5 54 68.5 48 74C42 68.5 33 67.5 26 70Z";
const BOOK_SPINE = "M48 62V73";

/** Small filled diamonds pinching the four cardinal points of the frame. */
const NODES: string[] = [
  "M48 1 52.5 6 48 11 43.5 6Z",
  "M95 48 90 52.5 85 48 90 43.5Z",
  "M48 95 43.5 90 48 85 52.5 90Z",
  "M1 48 6 43.5 11 48 6 52.5Z",
];

export function BrandMark({ variant = "bold", className }: BrandMarkProps) {
  const strokeWidth = variant === "bold" ? 5 : 2.75;
  const spineWidth = variant === "bold" ? 3 : 1.65;
  return (
    <svg
      viewBox="0 0 96 96"
      role="img"
      aria-label="Tafseer Clipper"
      className={cn("shrink-0", className)}
      fill="none"
    >
      <path d={FRAME} stroke="currentColor" strokeWidth={strokeWidth} strokeLinejoin="round" />
      {NODES.map((d) => (
        <path key={d} d={d} fill="currentColor" stroke="none" />
      ))}
      <path d={ARCH_LEFT} stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
      <path d={ARCH_RIGHT} stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
      {variant === "fine" ? (
        <path d={ARCH_CENTER} stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
      ) : null}
      <path d={BOOK} stroke="currentColor" strokeWidth={strokeWidth} strokeLinejoin="round" />
      <path d={BOOK_SPINE} stroke="currentColor" strokeWidth={spineWidth} strokeLinecap="round" />
      <path d={STAR} fill="currentColor" stroke="none" />
    </svg>
  );
}

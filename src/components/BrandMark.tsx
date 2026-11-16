import { cn } from "cn";

/**
 * The Tafseer Clipper brand mark: an eight-point (rub el hizb) frame with
 * diamond nodes, a pair of scissors resting on an open book.
 *
 * Drawn with `currentColor` so chrome controls the tone — never hardcode a
 * colour here (AGENTS.md §2: chrome colours come from the token system).
 *
 * Two variants mirror the identity sheet (same geometry, optical weight):
 * - `bold`  — heavy strokes for small chrome: header, dialogs, tray-scale UI.
 *   Thin detail turns to mud below ~48 px.
 * - `fine`  — lighter editorial strokes for large, calm surfaces: the startup
 *   splash and empty states.
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

/* Scissors cross just above the book and their rings rest on its top edge. */
const BLADE_A = "M43.7 22.7 54.9 47.7";
const BLADE_B = "M52.3 22.7 41.1 47.7";
const RING_LEFT = { cx: 39.2, cy: 50.2, r: 5.5 };
const RING_RIGHT = { cx: 56.8, cy: 50.2, r: 5.5 };
const PIVOT = { cx: 48, cy: 32.3, r: 2.75 };

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
      <path d={BLADE_A} stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
      <path d={BLADE_B} stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
      <circle {...RING_LEFT} stroke="currentColor" strokeWidth={strokeWidth} />
      <circle {...RING_RIGHT} stroke="currentColor" strokeWidth={strokeWidth} />
      <path d={BOOK} stroke="currentColor" strokeWidth={strokeWidth} strokeLinejoin="round" />
      <path d={BOOK_SPINE} stroke="currentColor" strokeWidth={spineWidth} strokeLinecap="round" />
      <circle {...PIVOT} fill="currentColor" stroke="none" />
    </svg>
  );
}

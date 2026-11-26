/**
 * Compose the "Export for AI chat" brief (Step 1): one self-contained markdown
 * file the editor pastes into a browser chat AI (Gemini, ChatGPT, ...) so the
 * clip search can run on a chat subscription instead of the API gateway. The
 * chat AI replies with the JSON shape Step 2's importer accepts.
 *
 * The three prompt blocks below are copied **verbatim** from
 * `backend/services/analyzer.py` (DEFAULT_BASE_PROMPT, CLIP_SYSTEM_RULES,
 * CLIP_SELECTION_RULES). `backend/test_phase1_e2e.py` reads this file and
 * asserts the backend strings still appear here, so the two cannot drift.
 */

import type { TranscriptSegment } from "./projectTypes";

export const DEFAULT_BASE_PROMPT =
  "You are a senior Islamic-studies video editor who cuts Tafseer lectures (Thai with Arabic Quranic recitation) into short social clips. You select self-contained, emotionally resonant passages that begin and end on a complete thought.";

export const CLIP_SYSTEM_RULES = `Return STRICT JSON only, with this exact shape:
{"clips": [{"start": <seconds>, "end": <seconds>, "title": "<short title, max 70 chars>", "rationale": "<one sentence>"}]}

Hard rules:
- Times are absolute seconds from the start of the lecture, floats.
- Every clip must start and end on a complete sentence; never cut mid-verse.
- Let the passage decide its length: never pad, trim or split a thought to hit a target length.
- Every clip must be at least 15 seconds long.
- Quality over quantity: return only passages you would genuinely publish. An empty list is a valid answer for a window that has no standalone moment.
- Clips must not overlap an excluded range.
- Arabic Quranic quotes belong inside the clip; do not start a clip in the middle of a recitation.
`;

export const CLIP_SELECTION_RULES = `Return STRICT JSON only, with this exact shape:
{"keep": [<candidate numbers, ascending>]}

Hard rules:
- Keep every candidate that clearly earns its place; drop every candidate that does not.
- When two candidates cover the same moment or repeat the same point, keep only the stronger one.
- There is no target count: do not pad the set to reach a number, and do not drop a strong moment to stay under one.
- Return {"keep": []} when no candidate earns its place; an empty selection is a valid editorial decision.
- Respect the refinement note and the session topic guide.
- Never output a number that is not in the candidate list.
`;

export interface AiBriefInput {
  projectName: string;
  /** The project's editable base prompt; empty falls back to the default. */
  basePrompt: string;
  /** Language code for titles/rationales, e.g. "th". */
  language: string;
  /** Session topic guide, when the project has one. */
  sessionGuide?: string;
  segments: TranscriptSegment[];
}

/** One transcript line, mirroring the sidecar's `_segment_line`. */
function segmentLine(segment: TranscriptSegment): string | null {
  const text = (segment.text || "").trim();
  if (!text) return null;
  const start = Number.isFinite(segment.start) ? segment.start : 0;
  const end = Number.isFinite(segment.end) ? segment.end : 0;
  return `[${start.toFixed(1)}-${end.toFixed(1)}] ${text}`;
}

export function buildAiBrief(input: AiBriefInput): string {
  const role = input.basePrompt.trim() || DEFAULT_BASE_PROMPT;
  const language = (input.language || "").trim();

  const rules = [CLIP_SYSTEM_RULES.trimEnd()];
  if (language) {
    rules.push(`- Write titles and rationales in the language '${language}'.`);
  }

  const transcript = input.segments
    .map(segmentLine)
    .filter((line): line is string => line !== null);

  const sections: string[] = [
    `# Clip-finding brief — ${input.projectName.trim() || "Lecture"}`,
    "Paste this file into a chat AI (Gemini, ChatGPT, ...), ask it to find clip moments in the lecture, then paste its JSON reply into Tafseer Clipper → Step 2 → Import.",
    "## Your role",
    role,
    "## Rules",
    rules.join("\n"),
    "## Accuracy",
    "- Use only the exact start/end values shown in the transcript labels; never invent or shift times.",
    "- Times are absolute seconds from the start of the lecture.",
    "- If this file is too large for one message, split the transcript into parts and return one JSON block per part.",
    "## Review pass",
    "After drafting your list, review it once:",
    "- Keep only passages that genuinely earn their place.",
    "- When two candidates cover the same moment or repeat the same point, keep only the stronger one.",
    "- There is no target count: do not pad the set, and do not drop a strong moment to stay under a number.",
    "Then reply with only the final JSON code block.",
  ];

  const sessionGuide = (input.sessionGuide || "").trim();
  if (sessionGuide) {
    sections.push("## Session topic guide", sessionGuide);
  }

  sections.push(
    "## Transcript",
    transcript.length > 0
      ? transcript.join("\n")
      : "(no transcript segments)",
    "## Output format",
    "Reply with only this JSON code block:",
    "",
    "```json",
    '{"clips": [{"start": 83.5, "end": 141.2, "title": "<short title, max 70 chars>", "rationale": "<one sentence>"}]}',
    "```",
  );

  return `${sections.join("\n\n")}\n`;
}

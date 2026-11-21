# ATOMIC_AUDIT.md — Exhaustive Codebase Audit: Bugs, Inconsistencies & Risks

> **Historical note (2026-11):** the `clip_scoring` decision slot described in this audit was retired. Step 2 is the writing model plus `sanitize_clips`; references below to `_discover_with_decisions` and `score_clip_candidates` describe code that no longer exists.

> **Audit Date:** November 2026  
> **Repository:** `tafseer-clipper` (Desktop Video Workstation for Long-Form Tafseer Lectures)  
> **Architecture:** Tauri v2 (Rust shell) + React 19 / TypeScript (Tailwind CSS, shadcn/ui, Radix, Zustand) + Python 3.12 FastAPI Sidecar (`backend.exe` onedir) + FFmpeg (`h264_nvenc` / `libx264`).  
> **Target Platform:** Windows 10/11 x64.  
> **Audit Standard:** Exhaustive line-by-line inspection across application code, native shell, mathematical models, Islamic text integrity, state machines, build systems, CI/CD pipelines, and packaging.

---

## Table of Contents

1. [Executive Summary & Risk Matrix](#1-executive-summary--risk-matrix)
2. [Domain & Qur'an Integrity Vulnerabilities](#2-domain--quran-integrity-vulnerabilities)
3. [Desktop Shell, Sandboxing & Native Runtime Risks (Tauri v2)](#3-desktop-shell-sandboxing--native-runtime-risks-tauri-v2)
4. [Backend Architecture & Python Sidecar Layer (`backend/`)](#4-backend-architecture--python-sidecar-layer-backend)
5. [Frontend Architecture, State Stores & Subtitle Studio (`src/`)](#5-frontend-architecture-state-stores--subtitle-studio-src)
6. [Build, Packaging, CI/CD & Release Engineering](#6-build-packaging-cicd--release-engineering)
7. [Comprehensive Inventory & Triage Matrix](#7-comprehensive-inventory--triage-matrix)
8. [Actionable Remediation Roadmap](#8-actionable-remediation-roadmap)

---

## 1. Executive Summary & Risk Matrix

Tafseer Clipper is a specialized desktop workstation engineered for video editors processing long-form Islamic lectures (primarily Thai speech interwoven with Arabic Qur'anic recitation). Its technical surface bridges a high-performance Rust shell, an electron-free Chromium webview (WebView2), a local Python AI sidecar running PyTorch/CTranslate2/Whisper, and an FFmpeg dual-stream rendering pipeline.

While the codebase exhibits high discipline regarding test coverage (130/130 Phase 1 E2E checks, 43/43 Playwright specs, 11/11 Rust unit tests passing) and strict dependency pinning, a microscopic audit reveals critical architectural vulnerabilities, religious integrity risks, platform edge cases, and state desynchronizations.

### Severity Summary

| Severity | Count | Primary Focus Areas |
| :--- | :---: | :--- |
| **CRITICAL** | 4 | Qur'anic verse false-positive overwrite via un-ordered bag-of-words; Tauri filesystem capability sandbox breakdown on secondary drives; Loopback port collision race at boot; Subtitle preview vs burned-in `.ass` typographical contract divergence. |
| **HIGH** | 8 | Clip finding model attribution suppression and architectural role inversion; Cloud decision model protocol mismatch (404 on standard OpenAI/Vercel gateways); Phrase-level Qur'an matching failure due to denominator dilution; Arabic Unicode Harakat code-point inflation in wrap math; FFmpeg filtergraph single-quote escaping corruption; Discovery window budget collapse on small clip counts; Incomplete recitation audio boundary midpoint removal; Orphaned cue memory leaks in project auto-save. |
| **MEDIUM** | 7 | Non-spacing diacritics assigned equal duration in cue math; Excessive canvas allocation spike on multi-hour lecture waveforms; Native Save/Open dialog absence in desktop runtime; Runtime disk cache accumulation without periodic eviction; CI release provenance attestation path mismatch; Release Please `Cargo.lock` desynchronization hazard; Cloud STT model override fallback in recitation recovery. |
| **LOW / CODE HEALTH** | 5 | Stale `SIDECAR_URL` static module evaluation; Unhandled `EMPTY_DISCOVERY` proposals edge case; Lack of Arabic horizontal line fit estimation in UI; Synchronous CPU-bound blocking risk in disconnect watcher; LocalStorage quota exhaustion risk on unbounded project activity history. |

---

## 2. Domain & Qur'an Integrity Vulnerabilities

Because the application processes sacred Qur'anic scripture, any corruption, incorrect verse attribution, or text mutilation constitutes a critical defect under [AGENTS.md](file:///C:/dev/tafseer-clipper/AGENTS.md).

### Issue 2.1: Un-ordered Bag-of-Words Anagram Overwrite Vulnerability
- **Severity:** `CRITICAL`
- **Source Locations:**
  - [backend/services/quran.py#L143-L189](file:///C:/dev/tafseer-clipper/backend/services/quran.py#L143-L189)
  - [backend/services/recitation.py#L88-L105](file:///C:/dev/tafseer-clipper/backend/services/recitation.py#L88-L105)
- **Mechanism:**
  In `quran.py`, `match_text(text)` scores candidate verses using:
  ```python
  intersection = len(query_set & verse.words)
  overlap = intersection / max(len(query_set), len(verse.words))
  ratio = SequenceMatcher(None, query, verse.normalized).ratio()
  score = max(overlap, ratio)
  ```
  `overlap` measures set intersection without preserving word sequence or grammatical syntax. If an STT transcription produces 4 common Arabic words (e.g., `["قال", "في", "الارض", "من"]`) that happen to match words in a 5-word verse in `quran.json`, `overlap` evaluates to `4 / 5 = 0.80`.
  Because `score = max(overlap, ratio)`, `score` becomes `0.80`, easily surpassing `threshold = 0.58`.
  In `recitation.py`:
  ```python
  match = quran.match_text(text)
  if match is not None:
      text = match.arabic
      reference = match.reference
      source = "quran"
  ```
  Unlike `corpus_gate` in `verify.py` (which strictly verifies `normalize_arabic(match.arabic) == normalize_arabic(stripped)`), `recitation.py` performs **no normalized equality check**. It unconditionally overwrites the spoken audio transcription with `match.arabic`.
- **Impact:**
  A speaker reciting a Hadith, a supplication (Du'a), or ordinary Arabic containing common Quranic vocabulary can be falsely recognized as a Qur'anic verse. The application replaces the spoken words with an unrelated Qur'an verse in the final subtitle track, presenting incorrect religious text to viewers.
- **Remediation:**
  Require that `score` incorporates word order (e.g., requiring monotonic index alignment or a minimum substring ratio `ratio >= 0.75`), or enforce that `recitation.py` only performs canonical replacement when `ratio >= 0.82` and sequential n-gram alignment is verified.

---

### Issue 2.2: Complete Failure of `quran.match_text` on Partial-Verse Recitations
- **Severity:** `HIGH`
- **Source Locations:**
  - [backend/services/quran.py#L174-L182](file:///C:/dev/tafseer-clipper/backend/services/quran.py#L174-L182)
  - [backend/services/verify.py#L64-L80](file:///C:/dev/tafseer-clipper/backend/services/verify.py#L64-L80)
- **Mechanism:**
  In Islamic lectures, scholars frequently recite a single sentence or clause from a long verse (e.g., reciting a 10-word passage from Ayat al-Kursi, Surah Al-Baqarah 2:255, which spans 50 words).
  In `quran.py`:
  1. `overlap = intersection / max(len(query_set), len(verse.words))`. If `len(query_set) == 10` and `len(verse.words) == 50`, the maximum possible overlap is `10 / 50 = 0.20`.
  2. `SequenceMatcher(None, query, verse.normalized).ratio()` computes `2 * M / (len(query) + len(verse))`. For a 60-char query against a 300-char verse, the ratio is bounded by `2 * 60 / (60 + 300) = 0.33`.
  3. Neither metric can ever reach `threshold = 0.58`.
  Furthermore, `corpus_gate` in `verify.py` demands:
  ```python
  if quran.normalize_arabic(match.arabic) != quran.normalize_arabic(stripped):
      return None
  ```
- **Impact:**
  Legitimate Qur'anic recitations of sub-verse clauses (the vast majority of recitations in Tafseer) will **never** match the bundled offline corpus. They are rejected by `corpus_gate` and forced into the expensive cloud LLM proofreading path or marked as `needs_model` in offline mode.
- **Remediation:**
  Implement local substring alignment (e.g., token-level sliding window or local SequenceMatcher matching `query` against sub-slices of `verse.normalized`) so that high-confidence sub-verse recitations are correctly recognized and attributed.

---

### Issue 2.3: Acoustic Recitation Boundary Midpoint Truncation Bug
- **Severity:** `HIGH`
- **Source Location:**
  - [backend/services/recitation.py#L150-L157](file:///C:/dev/tafseer-clipper/backend/services/recitation.py#L150-L157)
- **Mechanism:**
  In `recover_arabic`, segments to be replaced by the recovered Arabic span are filtered by:
  ```python
  removed = [
      segment
      for segment in ordered
      if segment.id not in removed_ids
      and start - 0.05 <= (segment.start + segment.end) / 2 <= end + 0.05
  ]
  ```
  If a boundary segment starts at `start - 2.5s` and extends into the recitation by `0.8s` (total span 3.3s), its midpoint is `(start - 2.5 + start + 0.8) / 2 = start - 0.85s`.
  Because `start - 0.85s < start - 0.05s`, this segment is **not removed**.
  The replacement segment is then calculated using:
  ```python
  start = min(segment.start for segment in removed)
  end = max(segment.end for segment in removed)
  ```
- **Impact:**
  1. The unremoved boundary segment remains in `ordered`, resulting in overlapping Thai speech and Arabic cues in the subtitle track.
  2. The replacement segment's start time collapses to the bounds of whatever segments were removed, rather than the acoustic boundary identified by the LLM audit (`slice_start`), causing timing jitter and clipped recitation subtitles.
- **Remediation:**
  Slice or split boundary segments that straddle `start` and `end`, or use range overlap detection (`segment.end > start and segment.start < end`) with acoustic boundary trimming.

---

### Issue 2.4: Arabic Unicode Harakat Code-Point Inflation in Subtitle Wrapping
- **Severity:** `HIGH`
- **Source Locations:**
  - [src/lib/subtitleWrap.ts#L181-L206](file:///C:/dev/tafseer-clipper/src/lib/subtitleWrap.ts#L181-L206)
  - [src/store/renderStore.ts#L169-L175](file:///C:/dev/tafseer-clipper/src/store/renderStore.ts#L169-L175)
- **Mechanism:**
  `wrapArabicText(text, maxChars)` wraps text based on string length:
  ```typescript
  if (current.length + 1 + word.length <= maxChars) {
    current += ` ${word}`;
  } else {
    out.push(current);
    current = word;
  }
  ```
  In JavaScript, `string.length` measures UTF-16 code units. In vocalized Arabic Qur'anic script, every consonant typically carries one or more combining diacritical marks (Tashkeel: Fatha `\u064E`, Damma `\u064F`, Kasra `\u0650`, Sukun `\u0652`, Shadda `\u0651`, Tanwin, Dagger Alef `\u0670`, Waqf marks `\u06D6-\u06ED`).
  In a fully vocalized verse such as:
  `بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ`
  there are only 4 words and 19 visual base glyphs, but **39 UTF-16 code units**.
  In `renderStore.ts`, `arabicMaxCharsPerLine` is calculated as:
  ```typescript
  const arabicMaxCharsPerLine = Math.max(
    16,
    Math.round(maxCharsPerLine * (settings.thai.fontSize / Math.max(1, settings.arabic.fontSize))),
  );
  ```
  For default Thai (size 44, 38 chars) and Arabic (size 64):
  `38 * (44 / 64) = 26` characters.
- **Impact:**
  Because the 4-word Bismillah has 39 code units, `wrapArabicText` treats it as exceeding the 26-character limit and aggressively breaks it across 2 or 3 lines. Visually short verses are needlessly fragmented into multi-line stacks that crowd the video preview and burned-in export.
- **Remediation:**
  Strip combining diacritics when evaluating line fit in `wrapArabicText` (e.g. `word.replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g, "").length`), or measure visual glyph clusters using `Intl.Segmenter(..., { granularity: 'grapheme' })`.

---

### Issue 2.5: Non-Spacing Diacritics Assigned Equal Acoustic Duration in Cue Math
- **Severity:** `MEDIUM`
- **Source Location:**
  - [src/lib/subtitleCues.ts#L153-L165](file:///C:/dev/tafseer-clipper/src/lib/subtitleCues.ts#L153-L165)
- **Mechanism:**
  In `buildLetters`:
  ```typescript
  const count = source.length;
  for (let index = 0; index < count; index += 1) {
    letters.push({
      char: source[index],
      start: start + ((end - start) * index) / count,
      end: start + ((end - start) * (index + 1)) / count,
      sentenceId: segment.sentence_id ?? null,
      segmentId: segment.id,
    });
  }
  ```
- **Impact:**
  If an Arabic word contains 3 root letters and 6 combining marks (length 9), each combining diacritic is assigned `1/9th` of the spoken audio duration. When words are reconstructed in `wordsFromLetters` or split by `splitByCaps`, the start and end timestamps of words become distorted by the presence or absence of diacritics. Furthermore, astral-plane Unicode surrogate pairs (e.g., rare Quranic annotation glyphs) are severed across separate `Letter` structures.
- **Remediation:**
  Iterate by Unicode grapheme clusters rather than raw UTF-16 indices, allocating duration proportional to base characters.

---

## 3. Desktop Shell, Sandboxing & Native Runtime Risks (Tauri v2)

The desktop shell is built on Tauri v2 (`src-tauri/src/lib.rs`, `main.rs`) running WebView2 on Windows.

### Issue 3.1: Tauri Filesystem Sandbox Violation on Custom Project Folders
- **Severity:** `CRITICAL`
- **Source Locations:**
  - [src-tauri/capabilities/default.json#L15-L55](file:///C:/dev/tafseer-clipper/src-tauri/capabilities/default.json#L15-L55)
  - [src/lib/projectFile.ts#L516-L545](file:///C:/dev/tafseer-clipper/src/lib/projectFile.ts#L516-L545)
  - [src/components/config/SettingsScreen.tsx#L255-L295](file:///C:/dev/tafseer-clipper/src/components/config/SettingsScreen.tsx#L255-L295)
- **Mechanism:**
  In `src-tauri/capabilities/default.json`, `tauri-plugin-fs` permissions (`fs:allow-read-text-file`, `fs:allow-write-text-file`, `fs:allow-mkdir`, `fs:allow-exists`, `fs:allow-remove`) are strictly scoped to:
  ```json
  "allow": [
    { "path": "$LOCALDATA/**" },
    { "path": "$APPDATA/**" },
    { "path": "$HOME/**" },
    { "path": "$DOCUMENT/**" }
  ]
  ```
  However, in `SettingsScreen.tsx`, the editor can configure `storage.projectFolder` to **any** location on the system (e.g., a secondary internal SSD `D:\TafseerProjects` or an external drive `E:\Lectures`).
  When `writeAutosaveFile` runs:
  ```typescript
  const folder = await resolveAutosaveFolder(projectFolder);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeTextFile(filePath, ...);
  ```
  The Tauri Rust IPC layer intercepts the command, checks the capability scope, and rejects the call with a security error (`Forbidden path`).
- **Impact:**
  Whenever a user selects a project folder on any non-system drive or outside the user profile, **durable disk auto-save fails completely**. `lastAutosaveError` is continuously populated, and closing or crashing the application results in total loss of unsaved project edits.
- **Remediation:**
  Either expand the capability scope in `default.json` to allow user-selected project directories, or use native file dialog permission elevation (`fs:allow-app-write` / scope extension API) when setting `storage.projectFolder`.

---

### Issue 3.2: Ephemeral Loopback Port Allocation Race Condition at Shell Startup
- **Severity:** `CRITICAL`
- **Source Locations:**
  - [src-tauri/src/lib.rs#L62-L73](file:///C:/dev/tafseer-clipper/src-tauri/src/lib.rs#L62-L73)
  - [src-tauri/src/lib.rs#L300-L315](file:///C:/dev/tafseer-clipper/src-tauri/src/lib.rs#L300-L315)
- **Mechanism:**
  In `src-tauri/src/lib.rs`:
  ```rust
  fn pick_free_loopback_port() -> Option<u16> {
      let listener = TcpListener::bind("127.0.0.1:0").ok()?;
      let port = listener.local_addr().ok()?.port();
      drop(listener);
      Some(port)
  }
  ```
  The listener is dropped immediately after obtaining the ephemeral port number. The port is then passed to `backend.exe` via CLI argument `--port <port>`.
  `backend.exe` is a PyInstaller onedir binary containing heavy libraries (PyTorch, CTranslate2, FastAPI). Cold process initialization takes between 2 to 5 seconds before Uvicorn binds to `127.0.0.1:<port>`.
- **Impact:**
  During that 2–5 second startup window, the port is completely unreserved. In multi-agent environments, CI test runners, or developer machines with dynamic port consumers, another process can bind to the port. When `backend.exe` attempts to bind, it crashes with `WinError 10048` (`WSAEADDRINUSE`). The webview remains waiting indefinitely at the splash gate, rendering the application inoperable.
- **Remediation:**
  Have the sidecar bind to `127.0.0.1:0` natively and write its assigned port to a temporary handshake file or stdout stream read by the Tauri parent process before injecting `__TAFSEER_SIDECAR_URL__`.

---

### Issue 3.3: Absence of Native Save/Open Dialog in Desktop Runtime
- **Severity:** `MEDIUM`
- **Source Locations:**
  - [src/lib/projectFile.ts#L337-L405](file:///C:/dev/tafseer-clipper/src/lib/projectFile.ts#L337-L405)
  - [src-tauri/capabilities/default.json#L12](file:///C:/dev/tafseer-clipper/src-tauri/capabilities/default.json#L12)
- **Mechanism:**
  In `projectFile.ts`, `saveProjectFile` and `openProjectFile` rely on:
  ```typescript
  const picker = (window as WindowWithFileSystemAccess).showSaveFilePicker;
  if (typeof picker === "function") { ... }
  downloadText(text, fileName);
  ```
  In Tauri WebView2 on Windows, the HTML5 File System Access API (`showSaveFilePicker`, `showOpenFilePicker`) is not supported or disabled. Consequently, clicking "Save project as..." (`Ctrl+S`) falls back to `downloadText`, which injects an `<a download>` DOM element.
- **Impact:**
  Instead of presenting the native Windows Save File dialog, WebView2 triggers a browser download event, dropping the `.tafseer` file into the user's `Downloads` directory without letting the user choose the target destination or folder. This violates the desktop workstation experience expected by video editors.
- **Remediation:**
  Import `@tauri-apps/plugin-dialog` in `projectFile.ts` and use `save({ filters: [{ name: "Tafseer Project", extensions: ["tafseer"] }] })` when `isDesktopRuntime()` is true.

---

### Issue 3.4: Premature Static Evaluation of `SIDECAR_URL`
- **Severity:** `LOW`
- **Source Location:**
  - [src/lib/api.ts#L45](file:///C:/dev/tafseer-clipper/src/lib/api.ts#L45)
- **Mechanism:**
  `export const SIDECAR_URL: string = resolveSidecarUrl();` is evaluated once at module evaluation time.
- **Impact:**
  If the webview script execution begins before the Tauri shell injects `window.__TAFSEER_SIDECAR_URL__` (or in test harnesses and HMR environments), `SIDECAR_URL` is permanently frozen to `http://127.0.0.1:8008` for the entire session.
- **Remediation:**
  Convert `SIDECAR_URL` into a dynamic function `getSidecarUrl()` or evaluate `resolveSidecarUrl()` on each request.

---

## 4. Backend Architecture & Python Sidecar Layer (`backend/`)

The backend is a FastAPI application packaged via PyInstaller (`backend/build_sidecar.spec`).

### Issue 4.1: Subtitle Styling & Metric Divergence Between Frontend and Backend Defaults
- **Severity:** `CRITICAL`
- **Source Locations:**
  - [src/lib/subtitleStyles.ts#L87-L150](file:///C:/dev/tafseer-clipper/src/lib/subtitleStyles.ts#L87-L150)
  - [backend/services/subtitle_gen.py#L145-L180](file:///C:/dev/tafseer-clipper/backend/services/subtitle_gen.py#L145-L180)
- **Mechanism:**
  There is a direct contradiction between the default subtitle styles defined in the frontend and those hardcoded in the Python sidecar:
  - **Frontend (`src/lib/subtitleStyles.ts`):**
    ```typescript
    // Arabic:
    font: "Noto Naskh Arabic", size: 64 (portrait) / 54 (landscape), primaryColor: "#dcb46e", lineHeightPad: 1.35
    // Thai:
    font: "Leelawadee UI", size: 44 (portrait) / 38 (landscape), primaryColor: "#f4f4f1", boxOpacity: 0.15
    ```
  - **Backend (`backend/services/subtitle_gen.py`):**
    ```python
    # Arabic:
    font="Tahoma", size=66, primary_color="#FFD37A", border_style=1
    # Thai:
    font="Leelawadee UI", size=44, primary_color="#FFFFFF", border_style=1 (no box opacity)
    ```
- **Impact:**
  While `renderStore.ts` passes explicit style specs during standard export, any invocation of `subtitle_gen.default_styles` in fallback workflows, backend unit testing, or automated jobs results in burned-in subtitles with completely different fonts (`Tahoma` vs `Noto Naskh Arabic`), different color temperatures (`#FFD37A` vs `#dcb46e`), and missing background box bounding. The burned video diverges visibly from the React Subtitle Monitor preview.
- **Remediation:**
  Align `backend/services/subtitle_gen.py:default_styles()` to match `src/lib/subtitleStyles.ts:defaultAssStyles()` exactly.

---

### Issue 4.2: Discovery Window Budget Collapse on Low `max_clips`
- **Severity:** `HIGH`
- **Source Location:**
  - [backend/services/analyzer.py#L610-L625](file:///C:/dev/tafseer-clipper/backend/services/analyzer.py#L610-L625)
- **Mechanism:**
  In `_discover_with_prompts`:
  ```python
  window_budget = min(MAX_DISCOVERY_WINDOWS, max(1, max_clips))
  windows = split_transcript_windows(segments, max_windows=window_budget)
  ```
  If an editor requests `max_clips = 1` or `max_clips = 2` on a 3-hour Tafseer lecture, `window_budget` collapses to 1 or 2 windows.
  In `split_transcript_windows`:
  ```python
  if len(windows) <= window_budget:
      return windows
  # Re-packs into at most window_budget contiguous groups
  ```
- **Impact:**
  For a 3-hour lecture (transcribing to ~100,000+ characters), setting `max_clips = 1` packs the **entire 3-hour transcript into a single LLM prompt**. This exceeds standard model context windows (especially local Ollama models with 8k or 16k context limits) or triggers prohibitive prompt-processing latency and token cutoff errors.
- **Remediation:**
  Decouple transcript chunk windowing from `max_clips`. The transcript should always be windowed into chunks that fit the provider's token context budget (`TRANSCRIPT_WINDOW_CHARS = 24_000`), regardless of how few clips the editor requested.

---

### Issue 4.3: FFmpeg Filtergraph Single-Quote Escaping & Literal Backslash Path Invalidation
- **Severity:** `HIGH`
- **Source Locations:**
  - [backend/services/renderer.py#L155-L166](file:///C:/dev/tafseer-clipper/backend/services/renderer.py#L155-L166)
  - [backend/services/renderer.py#L182-L185](file:///C:/dev/tafseer-clipper/backend/services/renderer.py#L182-L185)
- **Mechanism:**
  In `build_filtergraph`:
  ```python
  ass = f"ass=filename='{escape_filter_path(ass_path)}':fontsdir='{escape_filter_path(fonts_dir)}'"
  ```
  In `escape_filter_path`:
  ```python
  text = str(Path(path)).replace("\\", "/")
  text = text.replace(":", "\\:")
  for char in ("[", "]", ",", ";"):
      text = text.replace(char, "\\" + char)
  return text
  ```
  According to official FFmpeg filtergraph syntax documentation, **inside single quotes (`'...'`), the only character escaped by a backslash is the single quote `'` and the backslash `\` itself**.
  Any other character preceded by a backslash inside single quotes retains the backslash literally.
- **Impact:**
  When `escape_filter_path` produces `filename='C\:/work/\[clips\]/clip.ass'`, FFmpeg passes `C\:/work/\[clips\]/clip.ass` to the underlying Windows filesystem API. Windows cannot find a directory named `\[clips\]` (it is named `[clips]`), causing FFmpeg to fail with `Error opening subtitle file`.
- **Remediation:**
  Do not escape colons or brackets inside single-quoted filter values in FFmpeg. Only escape `'` and `\`.

---

### Issue 4.4: Permanent Disk Cache Accumulation During Runtime
- **Severity:** `MEDIUM`
- **Source Locations:**
  - [backend/main.py#L885-L930](file:///C:/dev/tafseer-clipper/backend/main.py#L885-L930)
  - [backend/main.py#L962](file:///C:/dev/tafseer-clipper/backend/main.py#L962)
- **Mechanism:**
  `_prune_work_dir()` is executed exclusively once during the FastAPI `lifespan` startup hook.
- **Impact:**
  Desktop video editors routinely leave editing workstations running for days. During continuous operation, temporary 16 kHz uncompressed WAV extracts (`audio/<uuid>.wav`, ~100-300 MB per lecture) and render job directories (`jobs/<uuid>/*.ass`) accumulate indefinitely in `%LOCALAPPDATA%`. There is no runtime periodic pruning or maximum disk-space quota.
- **Remediation:**
  Add a periodic background cleanup task (e.g. running every 60 minutes) or trigger pruning upon batch completion in `renderStore`.

---

### Issue 4.5: Orphaned Cue Track Memory Leak in Project Auto-Save
- **Severity:** `MEDIUM`
- **Source Location:**
  - [src/lib/taskResults.ts#L86-L114](file:///C:/dev/tafseer-clipper/src/lib/taskResults.ts#L86-L114)
- **Mechanism:**
  In `applyDiscovery`:
  ```typescript
  return {
    ...project,
    clips: merged,
    subtitles: payload.replaceAll ? {} : project.subtitles,
    selectedClipId,
  };
  ```
  When the editor triggers a re-roll (`replaceAll = false`), previous unapproved proposal clips are discarded from `project.clips`. However, their corresponding entries in `project.subtitles[clipId]` are **never cleaned up**.
- **Impact:**
  Over several re-roll cycles, `project.subtitles` accumulates dead clip IDs and orphan cue arrays, permanently bloating the `.tafseer` project file and increasing serialization overhead.
- **Remediation:**
  Prune `subtitles` keys so that only IDs present in `merged` are retained:
  ```typescript
  const validIds = new Set(merged.map(c => c.id));
  const cleanedSubtitles = Object.fromEntries(
    Object.entries(project.subtitles).filter(([id]) => validIds.has(id))
  );
  ```

---

### Issue 4.6: Cloud Decision Model Protocol Mismatch & 404 Dead-End (`/v1/systemone` vs Standard OpenAI Gateways)
- **Severity:** `HIGH`
- **Source Locations:**
  - [backend/services/decision.py#L47-L52](file:///C:/dev/tafseer-clipper/backend/services/decision.py#L47-L52)
  - [backend/services/decision.py#L771-L803](file:///C:/dev/tafseer-clipper/backend/services/decision.py#L771-L803)
  - [src/components/config/SettingsScreen.tsx#L450-L478](file:///C:/dev/tafseer-clipper/src/components/config/SettingsScreen.tsx#L450-L478)
- **Mechanism:**
  In `backend/services/decision.py`, the decision tier strictly assumes one of two proprietary wire formats:
  ```python
  WIRE_FORMAT_PATHS: dict[str, str] = {
      SYSTEMONE: "/v1/systemone",
      DECISIONS: "/v1/decisions",
  }
  ```
  When an editor configures "Your AI account" (cloud) for any Fast Judgment slot in `SettingsScreen.tsx`, the slot borrows the user's standard `cloud.baseUrl` (e.g., `https://ai-gateway.vercel.sh/v1` or `https://api.openai.com/v1`).
  When testing or querying the cloud decision model:
  1. `decision_endpoint` strips `/v1` and appends `/v1/decisions` or `/v1/systemone`.
  2. It issues a `POST` request to `https://ai-gateway.vercel.sh/v1/decisions` and `https://ai-gateway.vercel.sh/v1/systemone`.
  3. Real-world OpenAI gateways (Vercel AI Gateway, OpenAI, OpenRouter, Groq, Together, DeepInfra, Anthropic) **do not implement `/v1/decisions` or `/v1/systemone`**; they only support `/v1/chat/completions`.
  4. The gateway returns HTTP 404 Not Found.
  5. In `decision.py:798-803`, line 798 traps the 404 and raises:
     ```
     https://ai-gateway.vercel.sh/v1/systemone does not exist (404). This service may use the other decision format, or the address is wrong - press Test in Settings to detect it.
     ```
- **Impact:**
  - **No standard cloud provider can be used as a decision model.** Every attempt to test or run a cloud fast judgment slot with standard OpenAI-compatible gateways instantly crashes with a 404 error.
  - **Circular Dead-End UX:** The error message specifically tells the user to "press Test in Settings to detect it" — even though the user was *already* pressing Test in Settings. `detect_format()` tests both `/v1/decisions` and `/v1/systemone`, fails on both, and outputs this circular recommendation.
- **Remediation:**
  Implement a fallback transport adapter in `backend/services/decision.py` that translates typed decision questions (`noul`, `choice`, `score`) into standard `POST /v1/chat/completions` requests using structured JSON outputs (`response_format: { type: "json_object" }` or tool calls) when neither `/v1/decisions` nor `/v1/systemone` is supported by the gateway.

---

## 5. Frontend Architecture, State Stores & Subtitle Studio (`src/`)

The frontend is built with React 19 and Zustand state stores (`projectStore.ts`, `renderStore.ts`, `jobStore.ts`, `settingsStore.ts`).

### Issue 5.1: Excessive Canvas Allocation and Memory Spike on Long Lectures
- **Severity:** `MEDIUM`
- **Source Location:**
  - [src/components/WaveformBar.tsx#L158-L171](file:///C:/dev/tafseer-clipper/src/components/WaveformBar.tsx#L158-L171)
- **Mechanism:**
  In `WaveformBar.tsx`:
  ```typescript
  const width = wavesurfer.getWidth() || containerRef.current?.clientWidth || 640;
  const visibleSpan = Math.max(0.1, clipEnd - clipStart);
  wavesurfer.zoom(Math.max(1, width / visibleSpan));
  ```
  `wavesurfer.zoom(minPxPerSec)` sets the horizontal pixel density across the **entire audio duration**.
  For a 30-second clip in a 3-hour lecture (10,800 seconds):
  `width / visibleSpan = 640 / 30 = 21.3 px/s`.
  The total virtual canvas width created by wavesurfer.js is:
  `10,800 * 21.3 = 230,040 pixels`.
- **Impact:**
  Attempting to allocate hundreds of thousands of horizontal pixels in HTML5 `<canvas>` elements severely strains browser memory in WebView2, frequently hitting maximum canvas texture dimension limits (typically 32,767 px) and causing visual glitching or renderer memory crashes.
- **Remediation:**
  Render only the active clip window's precomputed waveform peaks in a fixed-size canvas rather than zooming an entire 3-hour audio timeline.

---

### Issue 5.2: Lack of Arabic Column Fit Estimation and Visual Overflow Safeguards
- **Severity:** `LOW`
- **Source Location:**
  - [src/lib/subtitleWidth.ts#L66-L100](file:///C:/dev/tafseer-clipper/src/lib/subtitleWidth.ts#L66-L100)
- **Mechanism:**
  `subtitleWidth.ts` provides `estimateThaiLineFit` and warns the user in Settings when Thai lines exceed frame columns. However, there is **zero column fit estimation for Arabic text**.
- **Impact:**
  Editors configuring large Arabic font sizes (e.g., 72px–80px) on 1080x1920 vertical video receive no visual warning if verses exceed the margin bounds (`1080 - 54 - 54 = 972 px`), leading to text clipping in libass rendering.
- **Remediation:**
  Add `estimateArabicLineFit` utilizing a representative vocalized Qur'anic sample text.

---

### Issue 5.3: Silent Drop on Empty Discovery Re-roll
- **Severity:** `LOW`
- **Source Location:**
  - [src/lib/taskResults.ts#L98-L102](file:///C:/dev/tafseer-clipper/src/lib/taskResults.ts#L98-L102)
- **Mechanism:**
  In `applyDiscovery`:
  ```typescript
  if (fresh.length === 0) return project;
  ```
  If `replaceAll` is `true` (user requested "Find clips again" / start over) and the LLM returns 0 clips, `applyDiscovery` returns `project` completely unchanged without resetting old clips or surfacing why the action had no visible effect.
- **Impact:**
  The user is left with no feedback as to why clicking "Find clips again" failed to update the deck.
- **Remediation:**
  Explicitly notify the user via Sonner toast when discovery returns no valid candidates.

---

### Issue 5.4: Clip Finding Model Attribution Suppression & Discovery Role Inversion (Decision Model vs LLM)
- **Severity:** `HIGH`
- **Source Locations:**
  - [src/steps/Step2Discovery.tsx#L443-L447](file:///C:/dev/tafseer-clipper/src/steps/Step2Discovery.tsx#L443-L447)
  - [src/steps/Step2Discovery.tsx#L471-L473](file:///C:/dev/tafseer-clipper/src/steps/Step2Discovery.tsx#L471-L473)
  - [backend/services/analyzer.py#L1035-L1138](file:///C:/dev/tafseer-clipper/backend/services/analyzer.py#L1035-L1138)
  - [backend/main.py#L2039-L2047](file:///C:/dev/tafseer-clipper/backend/main.py#L2039-L2047)
- **Mechanism:**
  This issue comprises an explicit frontend UI mislabeling bug compounded by an architectural role inversion:
  
  1. **Frontend Attribution Suppression Bug ([src/steps/Step2Discovery.tsx#L443-L473](file:///C:/dev/tafseer-clipper/src/steps/Step2Discovery.tsx#L443-L473)):**
     When the editor triggers clip finding with a `clip_scoring` decision model configured:
     ```typescript
     const decisionRoute = decisionActivityFor(settings, "clip_scoring");
     const activityId = useAiActivityStore.getState().start(
       decisionRoute
         ? { task: "clip-finding", ...decisionRoute }
         : aiRouteFor(settings, "clip-finding"),
     );
     // ...
     useAiActivityStore
       .getState()
       .finish(activityId, "done", decisionRoute ? undefined : result.model || undefined);
     ```
     Line 473 explicitly suppresses `result.model` (the actual generative reasoning model that produced titles and rationales, e.g. `gpt-4o` or `gemini-1.5-pro`). The developer noted in an inline comment:
     `// With a fast-judgment slot the first pass is the ranking model, so the report's writing model would mislabel the run.`
     Consequently, the UI progress banner and recent activity card display:
     `[Clip finding] <decision_model> · Fast judgments`
     The generative LLM is completely hidden from the user. Even if the decision model fails with HTTP 404 and the backend transparently falls back to the full generative LLM, line 473 **still suppresses `result.model`**, misleading the editor into believing their tiny 0.5B/1B decision model performed the entire multi-hour lecture analysis.

  2. **Architectural Role Inversion ([backend/services/analyzer.py#L1035-L1138](file:///C:/dev/tafseer-clipper/backend/services/analyzer.py#L1035-L1138)):**
     The user's mental model is that the decision model is an accelerator assisting the LLM. In `_discover_with_decisions`, however, the roles are completely inverted:
     - Python heuristically slices candidate time windows from pauses (`generate_clip_candidates`).
     - The **decision model alone** scores every candidate window (`score_clip_candidates`).
     - Candidates are sorted strictly by `rank_score`, and the top `max_clips` are picked as finalists.
     - The generative LLM is **demoted to a post-hoc title writer** (`title_candidates`). It never gets to review the lecture transcript, understand the thematic progression of the Tafseer, or decide which moments are spiritually and pedagogically coherent.
- **Impact:**
  - **Severe Confusion:** Editors see small decision models (intended for rapid boolean checks) attributed as the primary intelligence finding clips.
  - **Subpar Clip Quality:** Complex, long-form Islamic lectures cannot be meaningfully curated by small probability-scoring models evaluating mechanically sliced pause windows in isolation. High-value teaching arcs are dropped while uninspired segments score high on generic silence boundaries.
- **Remediation:**
  - In `Step2Discovery.tsx`, report both models in AI activity (or report the primary reasoning LLM as the main engine and indicate that fast scoring assisted it).
  - Re-architect Step 2 discovery so that the reasoning LLM maintains semantic ownership over clip discovery, using the decision model for candidate pre-filtering or ranking assistance rather than complete autonomous clip selection.

---

## 6. Build, Packaging, CI/CD & Release Engineering

The release pipeline produces a signed NSIS installer with bundled dependencies (`release.yml`, `scripts/build-release.ps1`, `src-tauri/tauri.conf.json`).

### Issue 6.1: Path Discrepancy in `release.yml` for Build Provenance Attestation
- **Severity:** `MEDIUM`
- **Source Locations:**
  - [.github/workflows/release.yml#L141-L144](file:///C:/dev/tafseer-clipper/.github/workflows/release.yml#L141-L144)
  - [.github/workflows/release.yml#L162-L166](file:///C:/dev/tafseer-clipper/.github/workflows/release.yml#L162-L166)
- **Mechanism:**
  In `release.yml`, checksum generation handles both standard and custom cargo target paths:
  ```powershell
  $bundle = "src-tauri\target\release\bundle\nsis"
  if (-not (Test-Path $bundle)) { $bundle = ".cargo-target\release\bundle\nsis" }
  ```
  However, the subsequent `actions/attest-build-provenance` step is hardcoded:
  ```yaml
  - name: Attest build provenance
    uses: actions/attest-build-provenance@...
    with:
      subject-path: "src-tauri/target/release/bundle/nsis/*.exe"
  ```
- **Impact:**
  If the build environment or runner sets `CARGO_TARGET_DIR = .cargo-target`, the provenance attestation action fails because `src-tauri/target/release/bundle/nsis/*.exe` does not exist, causing the release pipeline to fail after the installer has already been compiled.
- **Remediation:**
  Use a variable for the bundle directory or output path in `release.yml`.

---

### Issue 6.2: `Cargo.lock` and `Cargo.toml` Version Desynchronization Hazard
- **Severity:** `MEDIUM`
- **Source Locations:**
  - [release-please-config.json#L8-L15](file:///C:/dev/tafseer-clipper/release-please-config.json#L8-L15)
  - [.github/workflows/ci.yml#L125-L145](file:///C:/dev/tafseer-clipper/.github/workflows/ci.yml#L125-L145)
- **Mechanism:**
  Per [AGENTS.md](file:///C:/dev/tafseer-clipper/AGENTS.md), Release Please updates version strings across `package.json`, `tauri.conf.json`, `Cargo.toml`, and `config.py`. However, Release Please **cannot update `src-tauri/Cargo.lock`**.
  CI strictly enforces `cargo check --locked` and `cargo test --locked`.
- **Impact:**
  When a release PR is generated by Release Please, the root package version in `Cargo.toml` diverges from `Cargo.lock`. Merging the release PR without manually running `cargo check` to update `Cargo.lock` causes CI to fail immediately (this previously broke release PR run 44560412674).
- **Remediation:**
  Add a pre-commit or CI check that verifies `Cargo.lock` is in sync with `Cargo.toml` on all PRs.

---

## 7. Comprehensive Inventory & Triage Matrix

| ID | Domain / Component | Severity | Description | File & Line Reference |
| :--- | :--- | :---: | :--- | :--- |
| **QRN-01** | Qur'an & Recitation | **CRITICAL** | Un-ordered Bag-of-Words Anagram Overwrite Vulnerability in `recitation.py` | [backend/services/quran.py#L174-L182](file:///C:/dev/tafseer-clipper/backend/services/quran.py#L174-L182) |
| **TAU-01** | Desktop Shell (Tauri) | **CRITICAL** | Filesystem Sandbox Violation on Custom Project Folders (`D:\`, `E:\`) | [src-tauri/capabilities/default.json#L15-L55](file:///C:/dev/tafseer-clipper/src-tauri/capabilities/default.json#L15-L55) |
| **TAU-02** | Desktop Shell (Tauri) | **CRITICAL** | Ephemeral Loopback Port Allocation Race Condition at Shell Startup | [src-tauri/src/lib.rs#L62-L73](file:///C:/dev/tafseer-clipper/src-tauri/src/lib.rs#L62-L73) |
| **SUB-01** | Subtitle Typography | **CRITICAL** | Typography & Color Contract Divergence Between Frontend and Backend Defaults | [subtitle_gen.py#L145-L180](file:///C:/dev/tafseer-clipper/backend/services/subtitle_gen.py#L145-L180) vs [subtitleStyles.ts#L87-L150](file:///C:/dev/tafseer-clipper/src/lib/subtitleStyles.ts#L87-L150) |
| **QRN-02** | Qur'an & Recitation | **HIGH** | Complete Failure of `quran.match_text` on Partial-Verse Recitations | [backend/services/quran.py#L174-L182](file:///C:/dev/tafseer-clipper/backend/services/quran.py#L174-L182) |
| **QRN-03** | Qur'an & Recitation | **HIGH** | Acoustic Recitation Boundary Midpoint Truncation Bug | [backend/services/recitation.py#L150-L157](file:///C:/dev/tafseer-clipper/backend/services/recitation.py#L150-L157) |
| **TXT-01** | Subtitle Math | **HIGH** | Arabic Unicode Harakat Code-Point Inflation in Subtitle Wrapping | [src/lib/subtitleWrap.ts#L181-L206](file:///C:/dev/tafseer-clipper/src/lib/subtitleWrap.ts#L181-L206) |
| **FFM-01** | Video Rendering | **HIGH** | FFmpeg Filtergraph Single-Quote Escaping & Literal Backslash Path Invalidation | [backend/services/renderer.py#L155-L166](file:///C:/dev/tafseer-clipper/backend/services/renderer.py#L155-L166) |
| **AI-01** | Clip Discovery | **HIGH** | Discovery Window Budget Collapse on Low `max_clips` (Context Overflow) | [backend/services/analyzer.py#L610-L625](file:///C:/dev/tafseer-clipper/backend/services/analyzer.py#L610-L625) |
| **DEC-01** | Decision Tier | **HIGH** | Cloud Decision Model Protocol Mismatch & 404 Dead-End (`/v1/systemone` vs OpenAI Gateways) | [backend/services/decision.py#L771-L803](file:///C:/dev/tafseer-clipper/backend/services/decision.py#L771-L803) |
| **DEC-02** | Clip Discovery / UI | **HIGH** | Clip Finding Model Attribution Suppression & Discovery Role Inversion (Decision vs LLM) | [src/steps/Step2Discovery.tsx#L443-L473](file:///C:/dev/tafseer-clipper/src/steps/Step2Discovery.tsx#L443-L473) |
| **MEM-01** | State & Storage | **HIGH** | Orphaned Cue Track Memory Leak in Project Auto-Save File | [src/lib/taskResults.ts#L86-L114](file:///C:/dev/tafseer-clipper/src/lib/taskResults.ts#L86-L114) |
| **WAV-01** | Audio UI | **MEDIUM** | Excessive Canvas Allocation and Memory Spike on Long Lectures | [src/components/WaveformBar.tsx#L158-L171](file:///C:/dev/tafseer-clipper/src/components/WaveformBar.tsx#L158-L171) |
| **TAU-03** | Desktop Shell (Tauri) | **MEDIUM** | Absence of Native Save/Open Dialog in Desktop Runtime (HTML Download Fallback) | [src/lib/projectFile.ts#L337-L405](file:///C:/dev/tafseer-clipper/src/lib/projectFile.ts#L337-L405) |
| **FS-01** | Backend Lifecycle | **MEDIUM** | Permanent Disk Cache Accumulation During Runtime (Pruning only on startup) | [backend/main.py#L885-L930](file:///C:/dev/tafseer-clipper/backend/main.py#L885-L930) |
| **CICD-01** | CI / CD | **MEDIUM** | Path Discrepancy in `release.yml` for Build Provenance Attestation | [.github/workflows/release.yml#L162-L166](file:///C:/dev/tafseer-clipper/.github/workflows/release.yml#L162-L166) |
| **CICD-02** | Release Engineering | **MEDIUM** | `Cargo.lock` and `Cargo.toml` Version Desynchronization Hazard | [release-please-config.json#L8-L15](file:///C:/dev/tafseer-clipper/release-please-config.json#L8-L15) |
| **CUE-01** | Subtitle Math | **MEDIUM** | Non-Spacing Diacritics Assigned Equal Acoustic Duration in Cue Math | [src/lib/subtitleCues.ts#L153-L165](file:///C:/dev/tafseer-clipper/src/lib/subtitleCues.ts#L153-L165) |
| **API-01** | Transport | **LOW** | Premature Static Evaluation of `SIDECAR_URL` | [src/lib/api.ts#L45](file:///C:/dev/tafseer-clipper/src/lib/api.ts#L45) |
| **UI-01** | Subtitle Studio | **LOW** | Lack of Arabic Column Fit Estimation and Visual Overflow Safeguards | [src/lib/subtitleWidth.ts#L66-L100](file:///C:/dev/tafseer-clipper/src/lib/subtitleWidth.ts#L66-L100) |
| **DISC-01** | Wizard Flow | **LOW** | Silent Drop on Empty Discovery Re-roll (`fresh.length === 0`) | [src/lib/taskResults.ts#L98-L102](file:///C:/dev/tafseer-clipper/src/lib/taskResults.ts#L98-L102) |
| **ASYNC-01** | Backend Concurrency | **LOW** | Disconnect Poller Starvation on Synchronous CPU-bound Operations | [backend/main.py#L1680-L1715](file:///C:/dev/tafseer-clipper/backend/main.py#L1680-L1715) |
| **STOR-01** | Local Storage | **LOW** | Unbounded `recentProjects` and LocalStorage Quota Depletion Risk | [src/store/projectStore.ts#L370-L385](file:///C:/dev/tafseer-clipper/src/store/projectStore.ts#L370-L385) |

---

## 8. Actionable Remediation Roadmap

To ensure that the workstation meets production-grade reliability and strict religious integrity standards, fixes should proceed in the following prioritized phases:

### Phase 1: Critical Religious & Filesystem Integrity (Immediate)
1. **Fix QRN-01 (Bag-of-Words Verse Overwrite):**
   Update `match_text` in `backend/services/quran.py` to require ordered sequence alignment (`ratio >= 0.82`) before declaring a match, and forbid unconditional verse replacement in `backend/services/recitation.py` without normalized equality verification.
2. **Fix TAU-01 (Filesystem Sandbox on Secondary Drives):**
   Update `src-tauri/capabilities/default.json` to grant permissions for user-selected project drives, or implement scoped permission elevation so that durable auto-saves work on any local drive.
3. **Fix SUB-01 (Subtitle Typography Divergence):**
   Synchronize `backend/services/subtitle_gen.py:default_styles()` with `src/lib/subtitleStyles.ts:defaultAssStyles()`, setting `Noto Naskh Arabic` (size 64) and Thai box opacity (0.15) as the canonical backend defaults.
4. **Fix TAU-02 (Loopback Port Startup Race):**
   Pass `127.0.0.1:0` to `backend.exe` and establish a dynamic port handshake over stdout or temporary file to guarantee atomic port reservation.

### Phase 2: Core Algorithm & Subtitle Precision
1. **Fix QRN-02 & QRN-03 (Partial-Verse Matching & Boundary Slicing):**
   Implement sliding-window token alignment for sub-verse quotes in `quran.py` and enforce proper audio segment splitting in `recitation.py`.
2. **Fix TXT-01 & CUE-01 (Arabic Tashkeel Code-Point Math):**
   Strip non-spacing diacritics before evaluating line length in `src/lib/subtitleWrap.ts` and allocate character durations based on base Unicode grapheme clusters in `src/lib/subtitleCues.ts`.
3. **Fix FFM-01 (FFmpeg Filtergraph Escaping):**
   Refine `escape_filter_path` in `backend/services/renderer.py` to prevent emitting `\:` and `\[` inside single-quoted filter values.
4. **Fix AI-01 (Discovery Window Context Budget):**
   Decouple transcript chunk windowing from `max_clips` in `backend/services/analyzer.py`.
5. **Fix DEC-01 (Cloud Decision Model Protocol Mismatch):**
   Add a transport adapter in `backend/services/decision.py` that translates typed decision questions into standard `POST /v1/chat/completions` structured JSON calls when cloud gateways (OpenAI, Vercel, OpenRouter) return 404 on `/v1/systemone` and `/v1/decisions`.
6. **Fix DEC-02 (Clip Finding Attribution & Discovery Architecture):**
   In `src/steps/Step2Discovery.tsx`, do not suppress `result.model` in `aiActivityStore.finish`. Display the primary reasoning model with a badge indicating fast-judgment ranking assistance. Rebalance `_discover_with_decisions` so that the reasoning LLM maintains semantic ownership over clip boundary discovery.

### Phase 3: Desktop UX, Cache & Release Pipeline Hardening
1. **Fix TAU-03 (Native File Dialog):**
   Integrate `@tauri-apps/plugin-dialog` in `src/lib/projectFile.ts` for desktop runtime save/open workflows.
2. **Fix FS-01 & MEM-01 (Disk & Memory Garbage Collection):**
   Add a 60-minute runtime disk prune timer in `backend/main.py` and filter orphaned subtitle keys in `src/lib/taskResults.ts`.
3. **Fix WAV-01 (Waveform Canvas Allocation Spike):**
   Restrict wavesurfer rendering to the active clip's window or use precomputed peaks downsampling.
4. **Fix CICD-01 & CICD-02 (Release Provenance & Lockfile Sync):**
   Harmonize the artifact subject path in `.github/workflows/release.yml` and add an automated pre-release `Cargo.lock` synchronization check.

"""Read-only Qur'an corpus and fuzzy verse matching.

The corpus is bundled from the user-provided Qur'an export as
``backend/data/quran.json`` (6,236 verses, Arabic + Thai translation, no audio).
It is used only for *Qur'an* candidates from the recitation recovery pass and
Step 3 Arabic verification: matching recovered Arabic against the canonical text
lets us replace an STT transcription with the exact verse and show an editor a
verifiable reference, or flag a line as needing review.

Hadith and general Arabic quotes are not in this corpus; they are left for the
editor (or a future classifier) to handle.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import unicodedata
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

import config
from config import RESOURCE_DIR

logger = logging.getLogger("tafseer.quran")

CORPUS_PATH = RESOURCE_DIR / "data" / "quran.json"
MIN_MATCH_WORDS = 2

#: Arabic diacritics (Harakat, tanwin, shadda, sukun, superscript alef, Quranic
#: annotation marks) and the tatweel elongation.
_DIACRITICS = re.compile(r"[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]")
_NON_ARABIC = re.compile(r"[^\u0621-\u063A\u0641-\u064A\s]")
_SPACES = re.compile(r"\s+")

_TRANSLATION = str.maketrans(
    {
        "أ": "ا",
        "إ": "ا",
        "آ": "ا",
        "ٱ": "ا",
        "ى": "ي",
        "ئ": "ي",
        "ؤ": "و",
        "ة": "ه",
        "ک": "ك",
        "ی": "ي",
    }
)

#: Uthmani -> Imlaei pre-map for the dagger alef (waw/ya + superscript alef).
# _DAGGER_ALEF applied via str.replace (multi-char keys).

#: Vocative prefix splitting: Uthmani joins يٰٓأَيُّهَا into one token.
_VOCATIVE_SPLIT = re.compile(r"يا(?=ايها|اهل|قوم|بني|عباد)")

#: Non-Quranic formula guardrail markers.
_NON_QURANIC_MARKERS = re.compile(
    r"(?:قال\s+رسول\s+الله|رواه\s+البخاري|رواه\s+مسلم|رضي\s+الله|"
    r"صلى\s+الله\s+عليه\s+وسلم|عليه\s+السلام|اللهم\s+إني|رضي\s+الله\s+عنهم|"
    r"رضي\s+الله\s+عنها|رضي\s+الله\s+عنه)"
)

#: Phonetic consonant bucketing (acoustically close letters).
_PHONETIC_BUCKETS = str.maketrans(
    {
        "ص": "س",
        "س": "س",
        "ط": "ت",
        "ت": "ت",
        "ض": "د",
        "د": "د",
        "ظ": "ز",
        "ذ": "ز",
        "ز": "ز",
        "ق": "ك",
        "ك": "ك",
        "ح": "ه",
        "ه": "ه",
        "ع": "ا",
        "ء": "ا",
        "ا": "ا",
    }
)
_VOWELS_TO_STRIP = "وياء"


@dataclass(frozen=True, slots=True)
class QuranMatch:
    surah: int
    ayah: int
    arabic: str
    thai: str
    score: float

    @property
    def reference(self) -> str:
        return f"{self.surah}:{self.ayah}"


@dataclass(frozen=True, slots=True)
class _Verse:
    surah: int
    ayah: int
    arabic: str
    thai: str
    orth: str
    orth_words: tuple[str, ...]
    phon: str
    phon_words: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class _Window:
    start_surah: int
    start_ayah: int
    end_surah: int
    end_ayah: int
    arabic: str
    thai: str
    orth_words: tuple[str, ...]
    phon_words: tuple[str, ...]

    @property
    def reference(self) -> str:
        if self.start_surah == self.end_surah:
            if self.start_ayah == self.end_ayah:
                return f"{self.start_surah}:{self.start_ayah}"
            return f"{self.start_surah}:{self.start_ayah}-{self.end_ayah}"
        return f"{self.start_surah}:{self.start_ayah}-{self.end_surah}:{self.end_ayah}"


@dataclass(slots=True)
class _Candidate:
    orth_words: tuple[str, ...]
    phon_words: tuple[str, ...]
    reference: str
    arabic: str
    thai: str
    arabic_words: tuple[str, ...]


@dataclass(slots=True)
class MatchSpanResult:
    tier: str  # auto | rescue | reject | uncertain
    score_orthographic: float
    score_phonetic: float
    reference: str
    start_word: int
    end_word: int
    matched_canonical: str
    candidate_arabic: str
    candidate_thai: str


# --------------------------------------------------------------------------- #
# Normalization
# --------------------------------------------------------------------------- #


def normalize_orthographic(text: str) -> str:
    """Normalize Arabic for matching (Imlaei-style), without changing display."""
    value = unicodedata.normalize("NFKC", text or "")
    # Dagger alef pre-map must run before diacritic stripping.
    value = value.replace("و\u0670", "وا").replace("ى\u0670", "يا")
    value = _DIACRITICS.sub("", value).translate(_TRANSLATION)
    value = _VOCATIVE_SPLIT.sub("يا ", value)
    value = _NON_ARABIC.sub(" ", value)
    return _SPACES.sub(" ", value).strip()


def normalize_phonetic(text: str) -> str:
    """Consonant skeleton for ASR-error-tolerant matching."""
    orth = normalize_orthographic(text)
    words = []
    for word in orth.split():
        bucketed = word.translate(_PHONETIC_BUCKETS)
        skeleton = "".join(ch for ch in bucketed if ch not in _VOWELS_TO_STRIP)
        words.append(skeleton if skeleton else "")
    return " ".join(words)


# Keep the old name as an alias for backward compatibility.
def normalize_arabic(text: str) -> str:
    return normalize_orthographic(text)


# --------------------------------------------------------------------------- #
# Corpus loading
# --------------------------------------------------------------------------- #

_LOCK = threading.Lock()
_VERSES: list[_Verse] | None = None
_BY_REFERENCE: dict[tuple[int, int], _Verse] = {}
_CANDIDATES: list[_Candidate] = []
_TIER1: dict[tuple[str, ...], set[int]] = {}
_TIER2: dict[tuple[str, ...], set[int]] = {}
_CHAR5: dict[str, set[int]] | None = None
_CHAR5_BUILT = False


def _make_ngrams(words: tuple[str, ...], n: int) -> list[tuple[str, ...]]:
    if len(words) < n:
        return []
    return [tuple(words[i : i + n]) for i in range(len(words) - n + 1)]


def _build_char5_index(candidates: list[_Candidate]) -> dict[str, set[int]]:
    """Pruned character 5-gram index. Drops high-frequency stop-grams."""
    raw: dict[str, set[int]] = {}
    for idx, cand in enumerate(candidates):
        text = " ".join(cand.orth_words)
        for i in range(len(text) - 4):
            gram = text[i : i + 5]
            raw.setdefault(gram, set()).add(idx)
    # Prune stop-grams appearing in more than 50 candidates.
    pruned: dict[str, set[int]] = {}
    for gram, ids in raw.items():
        if len(ids) <= 50:
            pruned[gram] = ids
    return pruned


def _load() -> None:
    global _VERSES, _BY_REFERENCE, _CANDIDATES, _TIER1, _TIER2, _CHAR5, _CHAR5_BUILT
    if _VERSES is not None:
        return
    with _LOCK:
        if _VERSES is not None:
            return
        if not CORPUS_PATH.is_file():
            logger.warning("Qur'an corpus missing at %s", CORPUS_PATH)
            _VERSES = []
            _BY_REFERENCE = {}
            _CANDIDATES = []
            _TIER1 = {}
            _TIER2 = {}
            _CHAR5 = {}
            _CHAR5_BUILT = True
            return
        payload = json.loads(CORPUS_PATH.read_text(encoding="utf-8"))
        verses: list[_Verse] = []
        by_reference: dict[tuple[int, int], _Verse] = {}
        for row in payload.get("verses") or []:
            if not isinstance(row, (list, tuple)) or len(row) < 4:
                continue
            surah, ayah, arabic, thai = int(row[0]), int(row[1]), str(row[2]), str(row[3])
            orth = normalize_orthographic(arabic)
            orth_words = tuple(orth.split())
            phon = normalize_phonetic(arabic)
            phon_words = tuple(phon.split(" "))
            verse = _Verse(surah, ayah, arabic, thai, orth, orth_words, phon, phon_words)
            verses.append(verse)
            by_reference[(surah, ayah)] = verse

        # Build sliding windows (2- and 3-verse, same surah).
        windows: list[_Window] = []
        for i, verse in enumerate(verses):
            # 2-verse window
            if i + 1 < len(verses) and verses[i + 1].surah == verse.surah:
                v2 = verses[i + 1]
                arabic = verse.arabic + " " + v2.arabic
                thai = verse.thai + " " + v2.thai
                orth_words = verse.orth_words + v2.orth_words
                phon_words = verse.phon_words + v2.phon_words
                windows.append(
                    _Window(verse.surah, verse.ayah, v2.surah, v2.ayah, arabic, thai, orth_words, phon_words)
                )
            # 3-verse window
            if (
                i + 2 < len(verses)
                and verses[i + 1].surah == verse.surah
                and verses[i + 2].surah == verse.surah
            ):
                v2 = verses[i + 1]
                v3 = verses[i + 2]
                arabic = verse.arabic + " " + v2.arabic + " " + v3.arabic
                thai = verse.thai + " " + v2.thai + " " + v3.thai
                orth_words = verse.orth_words + v2.orth_words + v3.orth_words
                phon_words = verse.phon_words + v2.phon_words + v3.phon_words
                windows.append(
                    _Window(verse.surah, verse.ayah, v3.surah, v3.ayah, arabic, thai, orth_words, phon_words)
                )

        # Build candidate list.
        candidates: list[_Candidate] = []
        for v in verses:
            candidates.append(
                _Candidate(v.orth_words, v.phon_words, f"{v.surah}:{v.ayah}", v.arabic, v.thai, tuple(v.arabic.split()))
            )
        for w in windows:
            candidates.append(
                _Candidate(w.orth_words, w.phon_words, w.reference, w.arabic, w.thai, tuple(w.arabic.split()))
            )

        # Build tier indexes.
        tier1: dict[tuple[str, ...], set[int]] = {}
        tier2: dict[tuple[str, ...], set[int]] = {}
        for idx, cand in enumerate(candidates):
            for ng in _make_ngrams(cand.orth_words, 3):
                tier1.setdefault(ng, set()).add(idx)
            for ng in _make_ngrams(cand.phon_words, 3):
                tier2.setdefault(ng, set()).add(idx)

        _VERSES = verses
        _BY_REFERENCE = by_reference
        _CANDIDATES = candidates
        _TIER1 = tier1
        _TIER2 = tier2
        _CHAR5 = None
        _CHAR5_BUILT = False
        logger.info(
            "Loaded Qur'an corpus: %d verses, %d windows, %d candidates",
            len(verses),
            len(windows),
            len(candidates),
        )


def _ensure_loaded() -> None:
    _load()


def corpus_size() -> int:
    _ensure_loaded()
    return len(_VERSES or [])


def lookup(surah: int, ayah: int) -> QuranMatch | None:
    _ensure_loaded()
    verse = _BY_REFERENCE.get((int(surah), int(ayah)))
    if verse is None:
        return None
    return QuranMatch(verse.surah, verse.ayah, verse.arabic, verse.thai, 1.0)


# --------------------------------------------------------------------------- #
# Retrieval
# --------------------------------------------------------------------------- #


def _retrieve_candidates(orth_words: list[str], phon_words: list[str]) -> set[int]:
    _ensure_loaded()
    if not _CANDIDATES:
        return set()

    # Tier 1: 3-word orthographic.
    ngrams = _make_ngrams(tuple(orth_words), 3)
    if ngrams:
        sets = [_TIER1.get(ng) for ng in ngrams]
        if all(s is not None for s in sets):
            result = set.intersection(*[s for s in sets if s is not None])  # type: ignore[arg-type]
            if result:
                return result
    # Tier 1 with any available ngram (union fallback).
    tier1_union: set[int] = set()
    for ng in ngrams:
        tier1_union.update(_TIER1.get(ng, ()))
    if tier1_union:
        return tier1_union

    # Tier 2: 3-word phonetic.
    pngrams = _make_ngrams(tuple(phon_words), 3)
    tier2_union: set[int] = set()
    for ng in pngrams:
        tier2_union.update(_TIER2.get(ng, ()))
    if tier2_union:
        return tier2_union

    # Tier 3: pruned char 5-gram (lazy build), only if Tiers 1&2 empty.
    global _CHAR5, _CHAR5_BUILT
    if not _CHAR5_BUILT:
        _CHAR5 = _build_char5_index(_CANDIDATES)
        _CHAR5_BUILT = True
    text = " ".join(orth_words)
    char_sets: list[set[int]] = []
    for i in range(len(text) - 4):
        gram = text[i : i + 5]
        s = (_CHAR5 or {}).get(gram)
        if s is not None:
            char_sets.append(s)
    if char_sets:
        # Intersect all available; if too restrictive, union.
        inter = set.intersection(*char_sets) if len(char_sets) > 1 else char_sets[0]
        if inter:
            return inter
        union: set[int] = set()
        for s in char_sets:
            union.update(s)
        if union:
            return union

    # Last resort: all candidates.
    return set(range(len(_CANDIDATES)))


# --------------------------------------------------------------------------- #
# Smith-Waterman local alignment
# --------------------------------------------------------------------------- #


def _word_sim(a_orth: str, b_orth: str, a_phon: str, b_phon: str) -> float:
    r1 = SequenceMatcher(None, a_orth, b_orth).ratio()
    r2 = SequenceMatcher(None, a_phon, b_phon).ratio()
    r = max(r1, r2)
    return 2.0 * r - 1.0


def _smith_waterman(
    a_orth: list[str],
    a_phon: list[str],
    b_orth: list[str],
    b_phon: list[str],
) -> tuple[int, int, int, int, float]:
    """Return (start_a, end_a, start_b, end_b, best_score) for the best local
    alignment. Indices are inclusive on both ends; (-1,-1,-1,-1,0.0) if none."""
    m = len(a_orth)
    n = len(b_orth)
    if m == 0 or n == 0:
        return (-1, -1, -1, -1, 0.0)

    # H matrix.
    H = [[0.0] * (n + 1) for _ in range(m + 1)]
    best_score = 0.0
    best_i = 0
    best_j = 0
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            sim = _word_sim(a_orth[i - 1], b_orth[j - 1], a_phon[i - 1], b_phon[j - 1])
            diag = H[i - 1][j - 1] + sim
            up = H[i - 1][j] - 0.6
            left = H[i][j - 1] - 0.6
            val = max(0.0, diag, up, left)
            H[i][j] = val
            if val > best_score:
                best_score = val
                best_i = i
                best_j = j

    if best_score <= 0.0:
        return (-1, -1, -1, -1, 0.0)

    # Traceback.
    i, j = best_i, best_j
    start_i, start_j = i, j
    while i > 0 and j > 0 and H[i][j] > 0.0:
        sim = _word_sim(a_orth[i - 1], b_orth[j - 1], a_phon[i - 1], b_phon[j - 1])
        if H[i][j] == H[i - 1][j - 1] + sim:
            start_i = i - 1
            start_j = j - 1
            i -= 1
            j -= 1
        elif H[i][j] == H[i - 1][j] - 0.6:
            i -= 1
        else:
            j -= 1

    end_i = best_i - 1
    end_j = best_j - 1
    start_i = max(0, start_i)
    start_j = max(0, start_j)
    return (start_i, end_i, start_j, end_j, best_score)


# --------------------------------------------------------------------------- #
# match_span / match_text
# --------------------------------------------------------------------------- #


def _score_slice(query_orth: str, cand_orth: str) -> float:
    return SequenceMatcher(None, query_orth, cand_orth).ratio()


def match_span(text: str) -> MatchSpanResult | None:
    """Tiered matching returning slice indices for partial replacement."""
    _ensure_loaded()
    if not _CANDIDATES:
        return None

    stripped = text.strip()
    guardrail = bool(_NON_QURANIC_MARKERS.search(stripped))

    orth_query = normalize_orthographic(stripped)
    phon_query = normalize_phonetic(stripped)
    orth_words = orth_query.split()
    phon_words = phon_query.split(" ")
    if len(orth_words) < MIN_MATCH_WORDS:
        return None

    candidate_ids = _retrieve_candidates(orth_words, phon_words)
    if not candidate_ids:
        return None

    best: MatchSpanResult | None = None
    best_score = -1.0

    for cid in candidate_ids:
        cand = _CANDIDATES[cid]
        cand_orth_words = list(cand.orth_words)
        cand_phon_words = list(cand.phon_words)
        if not cand_orth_words:
            continue

        si, ei, sj, ej, _sw = _smith_waterman(
            orth_words, phon_words, cand_orth_words, cand_phon_words
        )
        if si < 0:
            continue

        # Extract slices.
        query_slice_orth = " ".join(orth_words[si : ei + 1])
        cand_slice_orth = " ".join(cand_orth_words[sj : ej + 1])
        query_slice_phon = " ".join(phon_words[si : ei + 1]) if si < len(phon_words) else ""
        cand_slice_phon = " ".join(cand_phon_words[sj : ej + 1]) if sj < len(cand_phon_words) else ""

        orth_score = _score_slice(query_slice_orth, cand_slice_orth)
        phon_score = _score_slice(query_slice_phon, cand_slice_phon) if query_slice_phon and cand_slice_phon else orth_score

        span_len = ei - si + 1

        # Guardrail: non-Quranic markers skip unless a real (>=4 word) high-score
        # Quran span is present.
        if guardrail:
            if not (max(orth_score, phon_score) >= 0.90 and span_len >= 4):
                continue

        # Tier decision.
        if orth_score >= 0.85 and span_len >= 4:
            tier = "auto"
        elif orth_score < 0.85 and phon_score >= 0.88:
            tier = "rescue"
        elif orth_score < 0.75 and phon_score < 0.82:
            tier = "reject"
        else:
            tier = "uncertain"

        if tier == "reject":
            continue

        # Canonical matched text from candidate arabic words.
        cand_arabic_words = list(cand.arabic_words)
        if sj < len(cand_arabic_words) and ej < len(cand_arabic_words):
            matched_canonical = " ".join(cand_arabic_words[sj : ej + 1])
        else:
            matched_canonical = cand.arabic

        if orth_score > best_score:
            best_score = orth_score
            best = MatchSpanResult(
                tier=tier,
                score_orthographic=round(orth_score, 4),
                score_phonetic=round(phon_score, 4),
                reference=cand.reference,
                start_word=si,
                end_word=ei,
                matched_canonical=matched_canonical,
                candidate_arabic=cand.arabic,
                candidate_thai=cand.thai,
            )

    return best


def match_text(text: str, *, min_score: float | None = None) -> QuranMatch | None:
    """Backward-compatible fuzzy match. Returns a QuranMatch for auto (and
    rescue) tiers, None otherwise."""
    result = match_span(text)
    if result is None:
        return None
    if result.tier not in ("auto", "rescue"):
        return None
    # For rescue tier, require span length >= 6 to auto-return (per plan).
    if result.tier == "rescue":
        span_len = result.end_word - result.start_word + 1
        if span_len < 6:
            return None
    # Threshold override.
    if min_score is not None and result.score_orthographic < min_score:
        return None
    _ensure_loaded()
    ref = result.reference
    base = ref.split("-")[0]
    parts = base.split(":")
    if len(parts) != 2:
        return None
    try:
        surah, ayah = int(parts[0]), int(parts[1])
    except ValueError:
        return None
    verse = _BY_REFERENCE.get((surah, ayah))
    if verse is None:
        return None
    score = max(result.score_orthographic, result.score_phonetic)
    return QuranMatch(verse.surah, verse.ayah, verse.arabic, verse.thai, round(score, 4))

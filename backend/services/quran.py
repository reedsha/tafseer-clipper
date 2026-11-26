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
from collections import Counter
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
    end_ayah: int | None = None

    @property
    def reference(self) -> str:
        if self.end_ayah is not None and self.end_ayah != self.ayah:
            return f"{self.surah}:{self.ayah}-{self.end_ayah}"
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
    arabic_words: tuple[str, ...]
    orth_to_raw_idx: tuple[int, ...]
    orth_word_verses: tuple[tuple[int, int], ...]


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
    arabic_words: tuple[str, ...]
    orth_to_raw_idx: tuple[int, ...]
    orth_word_verses: tuple[tuple[int, int], ...]
    verse_count: int

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
    orth_to_raw_idx: tuple[int, ...]
    orth_word_verses: tuple[tuple[int, int], ...]
    verse_count: int = 1


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
    matched_verses: tuple[tuple[int, int], ...] = ()


# --------------------------------------------------------------------------- #
# Normalization
# --------------------------------------------------------------------------- #


def normalize_orthographic(text: str) -> str:
    """Normalize Arabic for matching (Imlaei-style), without changing display."""
    value = unicodedata.normalize("NFKC", text or "")
    # Dagger alef pre-map must run before diacritic stripping:
    # ىٰ (alif maqsura + superscript alef, e.g. مُوسَىٰ) -> ى -> ي (matches Imlaei موسى);
    # وٰ (waw-alef, e.g. الصَّلَوٰةَ) -> ا (matches Imlaei الصلاة).
    value = value.replace("و\u0670", "ا").replace("ى\u0670", "ى")
    value = _DIACRITICS.sub("", value).translate(_TRANSLATION)
    value = _VOCATIVE_SPLIT.sub("يا ", value)
    value = _NON_ARABIC.sub(" ", value)
    return _SPACES.sub(" ", value).strip()


def normalize_phonetic_word(orth_word: str) -> str:
    """Consonant skeleton for a single orthographically normalized Arabic word."""
    bucketed = orth_word.translate(_PHONETIC_BUCKETS)
    return "".join(ch for ch in bucketed if ch not in _VOWELS_TO_STRIP)


def normalize_phonetic(text: str) -> str:
    """Consonant skeleton for ASR-error-tolerant matching."""
    orth = normalize_orthographic(text)
    words = [normalize_phonetic_word(word) for word in orth.split()]
    return " ".join(words)


# Keep the old name as an alias for backward compatibility.
def normalize_arabic(text: str) -> str:
    return normalize_orthographic(text)


def _tokenize_raw_with_map(
    verses: list[tuple[int, int, str]],
) -> tuple[
    tuple[str, ...],
    tuple[str, ...],
    tuple[str, ...],
    tuple[int, ...],
    tuple[tuple[int, int], ...],
]:
    """Tokenize verses keeping lossless orth -> raw token index & verse maps."""
    raw_words: list[str] = []
    orth_words: list[str] = []
    phon_words: list[str] = []
    orth_to_raw_idx: list[int] = []
    orth_word_verses: list[tuple[int, int]] = []

    raw_offset = 0
    for surah, ayah, arabic in verses:
        tokens = arabic.split()
        raw_words.extend(tokens)
        verse_key = (surah, ayah)
        for local_idx, raw_tok in enumerate(tokens):
            raw_idx = raw_offset + local_idx
            for orth_tok in normalize_orthographic(raw_tok).split():
                orth_words.append(orth_tok)
                phon_words.append(normalize_phonetic_word(orth_tok))
                orth_to_raw_idx.append(raw_idx)
                orth_word_verses.append(verse_key)
        raw_offset += len(tokens)

    return (
        tuple(raw_words),
        tuple(orth_words),
        tuple(phon_words),
        tuple(orth_to_raw_idx),
        tuple(orth_word_verses),
    )


# --------------------------------------------------------------------------- #
# Corpus loading
# --------------------------------------------------------------------------- #

_LOCK = threading.Lock()
_CHAR5_LOCK = threading.Lock()
_VERSES: list[_Verse] | None = None
_BY_REFERENCE: dict[tuple[int, int], _Verse] = {}
_CANDIDATES: list[_Candidate] = []
_TIER1: dict[tuple[str, ...], set[int]] = {}
_TIER2: dict[tuple[str, ...], set[int]] = {}
_TIER1_BI: dict[tuple[str, ...], set[int]] = {}
_TIER2_BI: dict[tuple[str, ...], set[int]] = {}
_CHAR5: dict[str, set[int]] | None = None
_CHAR5_BUILT = False

MAX_SW_CANDIDATES = 48
_TIER_RANK = {"auto": 3, "rescue": 2, "uncertain": 1}


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
    global _VERSES, _BY_REFERENCE, _CANDIDATES, _TIER1, _TIER2, _TIER1_BI, _TIER2_BI, _CHAR5, _CHAR5_BUILT
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
            _TIER1_BI = {}
            _TIER2_BI = {}
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
            arabic_words, orth_words, phon_words, orth_to_raw_idx, orth_word_verses = (
                _tokenize_raw_with_map([(surah, ayah, arabic)])
            )
            orth = " ".join(orth_words)
            phon = " ".join(phon_words)
            verse = _Verse(
                surah,
                ayah,
                arabic,
                thai,
                orth,
                orth_words,
                phon,
                phon_words,
                arabic_words,
                orth_to_raw_idx,
                orth_word_verses,
            )
            verses.append(verse)
            by_reference[(surah, ayah)] = verse

        # Build sliding windows (2- and 3-verse, same surah), shifting raw token
        # indices cleanly across the concatenated verses.
        windows: list[_Window] = []
        for i, verse in enumerate(verses):
            if i + 1 < len(verses) and verses[i + 1].surah == verse.surah:
                v2 = verses[i + 1]
                shift2 = len(verse.arabic_words)
                windows.append(
                    _Window(
                        verse.surah,
                        verse.ayah,
                        v2.surah,
                        v2.ayah,
                        verse.arabic + " " + v2.arabic,
                        verse.thai + " " + v2.thai,
                        verse.orth_words + v2.orth_words,
                        verse.phon_words + v2.phon_words,
                        verse.arabic_words + v2.arabic_words,
                        verse.orth_to_raw_idx
                        + tuple(idx + shift2 for idx in v2.orth_to_raw_idx),
                        verse.orth_word_verses + v2.orth_word_verses,
                        2,
                    )
                )
            if (
                i + 2 < len(verses)
                and verses[i + 1].surah == verse.surah
                and verses[i + 2].surah == verse.surah
            ):
                v2 = verses[i + 1]
                v3 = verses[i + 2]
                shift2 = len(verse.arabic_words)
                shift3 = shift2 + len(v2.arabic_words)
                windows.append(
                    _Window(
                        verse.surah,
                        verse.ayah,
                        v3.surah,
                        v3.ayah,
                        verse.arabic + " " + v2.arabic + " " + v3.arabic,
                        verse.thai + " " + v2.thai + " " + v3.thai,
                        verse.orth_words + v2.orth_words + v3.orth_words,
                        verse.phon_words + v2.phon_words + v3.phon_words,
                        verse.arabic_words + v2.arabic_words + v3.arabic_words,
                        verse.orth_to_raw_idx
                        + tuple(idx + shift2 for idx in v2.orth_to_raw_idx)
                        + tuple(idx + shift3 for idx in v3.orth_to_raw_idx),
                        verse.orth_word_verses + v2.orth_word_verses + v3.orth_word_verses,
                        3,
                    )
                )

        # Build candidate list (single verses before multi-verse windows).
        candidates: list[_Candidate] = []
        for v in verses:
            candidates.append(
                _Candidate(
                    v.orth_words,
                    v.phon_words,
                    f"{v.surah}:{v.ayah}",
                    v.arabic,
                    v.thai,
                    v.arabic_words,
                    v.orth_to_raw_idx,
                    v.orth_word_verses,
                    1,
                )
            )
        for w in windows:
            candidates.append(
                _Candidate(
                    w.orth_words,
                    w.phon_words,
                    w.reference,
                    w.arabic,
                    w.thai,
                    w.arabic_words,
                    w.orth_to_raw_idx,
                    w.orth_word_verses,
                    w.verse_count,
                )
            )

        # Build tier indexes (3-gram primary + 2-gram fallback for 2-word spans).
        tier1: dict[tuple[str, ...], set[int]] = {}
        tier2: dict[tuple[str, ...], set[int]] = {}
        tier1_bi: dict[tuple[str, ...], set[int]] = {}
        tier2_bi: dict[tuple[str, ...], set[int]] = {}
        for idx, cand in enumerate(candidates):
            for ng in _make_ngrams(cand.orth_words, 3):
                tier1.setdefault(ng, set()).add(idx)
            for ng in _make_ngrams(cand.phon_words, 3):
                tier2.setdefault(ng, set()).add(idx)
            for ng in _make_ngrams(cand.orth_words, 2):
                tier1_bi.setdefault(ng, set()).add(idx)
            for ng in _make_ngrams(cand.phon_words, 2):
                tier2_bi.setdefault(ng, set()).add(idx)

        _VERSES = verses
        _BY_REFERENCE = by_reference
        _CANDIDATES = candidates
        _TIER1 = tier1
        _TIER2 = tier2
        _TIER1_BI = tier1_bi
        _TIER2_BI = tier2_bi
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


def _ensure_char5() -> dict[str, set[int]]:
    global _CHAR5, _CHAR5_BUILT
    if _CHAR5_BUILT and _CHAR5 is not None:
        return _CHAR5
    with _CHAR5_LOCK:
        if _CHAR5_BUILT and _CHAR5 is not None:
            return _CHAR5
        _CHAR5 = _build_char5_index(_CANDIDATES)
        _CHAR5_BUILT = True
        return _CHAR5


def _top_ranked_candidates(
    counts: Counter[int], *, limit: int = MAX_SW_CANDIDATES
) -> list[int]:
    """Return top candidate ids ranked by hit count, favoring single-verse entries."""
    if not counts:
        return []
    return [
        cid
        for cid, _hits in sorted(
            counts.items(),
            key=lambda item: (-item[1], _CANDIDATES[item[0]].verse_count, item[0]),
        )[:limit]
    ]


def _retrieve_candidates(orth_words: list[str], phon_words: list[str]) -> list[int]:
    _ensure_loaded()
    if not _CANDIDATES:
        return []

    # Tier 1: 3-word orthographic exact intersection, then hit-counted union.
    ngrams = _make_ngrams(tuple(orth_words), 3)
    if ngrams:
        sets = [_TIER1.get(ng) for ng in ngrams]
        if all(s is not None for s in sets):
            result = set.intersection(*[s for s in sets if s is not None])  # type: ignore[arg-type]
            if result:
                return sorted(result, key=lambda cid: (_CANDIDATES[cid].verse_count, cid))[
                    :MAX_SW_CANDIDATES
                ]
        tier1_counts: Counter[int] = Counter()
        for ng in ngrams:
            for cid in _TIER1.get(ng, ()):
                tier1_counts[cid] += 1
        if tier1_counts:
            return _top_ranked_candidates(tier1_counts)

    # Tier 2: 3-word phonetic hit-counted candidates (merged with 2-word orth bigrams).
    pngrams = _make_ngrams(tuple(phon_words), 3)
    tier2_counts: Counter[int] = Counter()
    for ng in pngrams:
        for cid in _TIER2.get(ng, ()):
            tier2_counts[cid] += 2

    bi_orth = _make_ngrams(tuple(orth_words), 2)
    for ng in bi_orth:
        for cid in _TIER1_BI.get(ng, ()):
            tier2_counts[cid] += 2
    if tier2_counts:
        return _top_ranked_candidates(tier2_counts)

    # Phonetic 2-word fallback for noisy 2-3 word snippets.
    bi_phon = _make_ngrams(tuple(phon_words), 2)
    bi_phon_counts: Counter[int] = Counter()
    for ng in bi_phon:
        for cid in _TIER2_BI.get(ng, ()):
            bi_phon_counts[cid] += 1
    if bi_phon_counts:
        return _top_ranked_candidates(bi_phon_counts)

    # Tier 3: pruned char 5-gram (thread-safe lazy build), capped by hit count.
    char5 = _ensure_char5()
    text = " ".join(orth_words)
    char_counts: Counter[int] = Counter()
    matched_grams = 0
    for i in range(len(text) - 4):
        gram = text[i : i + 5]
        s = char5.get(gram)
        if s:
            matched_grams += 1
            for cid in s:
                char_counts[cid] += 1
    if char_counts:
        # Multi-word queries must share >=2 non-stop 5-grams when multiple exist.
        min_hits = 2 if matched_grams >= 2 and max(char_counts.values()) >= 2 else 1
        filtered = Counter(
            {cid: hits for cid, hits in char_counts.items() if hits >= min_hits}
        )
        return _top_ranked_candidates(filtered or char_counts)

    # Never scan all 18,366 candidates when every index missed.
    return []


# --------------------------------------------------------------------------- #
# Smith-Waterman local alignment
# --------------------------------------------------------------------------- #


def _word_sim(
    a_orth: str,
    b_orth: str,
    a_phon: str,
    b_phon: str,
    cache: dict[tuple[str, str, str, str], float] | None = None,
) -> float:
    if a_orth == b_orth:
        return 1.0
    if a_phon and a_phon == b_phon:
        return 1.0
    key = (a_orth, b_orth, a_phon, b_phon)
    if cache is not None and key in cache:
        return cache[key]
    r1 = SequenceMatcher(None, a_orth, b_orth).ratio()
    r2 = SequenceMatcher(None, a_phon, b_phon).ratio() if a_phon or b_phon else r1
    val = 2.0 * max(r1, r2) - 1.0
    if cache is not None:
        cache[key] = val
    return val


def _smith_waterman(
    a_orth: list[str],
    a_phon: list[str],
    b_orth: list[str] | tuple[str, ...],
    b_phon: list[str] | tuple[str, ...],
    *,
    sim_cache: dict[tuple[str, str, str, str], float] | None = None,
) -> tuple[int, int, int, int, float]:
    """Return (start_a, end_a, start_b, end_b, best_score) for the best local
    alignment. Indices are inclusive on both ends; (-1,-1,-1,-1,0.0) if none."""
    m = len(a_orth)
    n = len(b_orth)
    if m == 0 or n == 0:
        return (-1, -1, -1, -1, 0.0)

    # H matrix + traceback pointer table (0=stop, 1=diag, 2=up, 3=left).
    H = [[0.0] * (n + 1) for _ in range(m + 1)]
    T = [[0] * (n + 1) for _ in range(m + 1)]
    best_score = 0.0
    best_i = 0
    best_j = 0
    for i in range(1, m + 1):
        ao = a_orth[i - 1]
        ap = a_phon[i - 1]
        hi = H[i]
        hi_prev = H[i - 1]
        ti = T[i]
        for j in range(1, n + 1):
            sim = _word_sim(ao, b_orth[j - 1], ap, b_phon[j - 1], sim_cache)
            diag = hi_prev[j - 1] + sim
            up = hi_prev[j] - 0.6
            left = hi[j - 1] - 0.6
            val = 0.0
            ptr = 0
            if diag > val:
                val = diag
                ptr = 1
            if up > val:
                val = up
                ptr = 2
            if left > val:
                val = left
                ptr = 3
            hi[j] = val
            ti[j] = ptr
            if val > best_score:
                best_score = val
                best_i = i
                best_j = j

    if best_score <= 0.0:
        return (-1, -1, -1, -1, 0.0)

    # Traceback via stored pointers (no redundant similarity calls).
    i, j = best_i, best_j
    start_i, start_j = i, j
    while i > 0 and j > 0 and T[i][j] != 0:
        ptr = T[i][j]
        if ptr == 1:
            start_i = i - 1
            start_j = j - 1
            i -= 1
            j -= 1
        elif ptr == 2:
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


def _format_verse_range(verses: tuple[tuple[int, int], ...]) -> str:
    if not verses:
        return ""
    s0, a0 = verses[0]
    s1, a1 = verses[-1]
    if s0 == s1:
        return f"{s0}:{a0}" if a0 == a1 else f"{s0}:{a0}-{a1}"
    return f"{s0}:{a0}-{s1}:{a1}"


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
    phon_words = phon_query.split(" ") if orth_words else []
    if len(orth_words) < MIN_MATCH_WORDS:
        return None

    candidate_ids = _retrieve_candidates(orth_words, phon_words)
    if not candidate_ids:
        return None

    sim_cache: dict[tuple[str, str, str, str], float] = {}
    best: MatchSpanResult | None = None
    best_rank: tuple[int, float, float, int] = (-1, -1.0, -1.0, -999)

    for cid in candidate_ids:
        cand = _CANDIDATES[cid]
        cand_orth_words = cand.orth_words
        cand_phon_words = cand.phon_words
        if not cand_orth_words:
            continue

        si, ei, sj, ej, _sw = _smith_waterman(
            orth_words, phon_words, cand_orth_words, cand_phon_words, sim_cache=sim_cache
        )
        if si < 0 or sj > ej or sj >= len(cand.orth_to_raw_idx) or ej >= len(cand.orth_to_raw_idx):
            continue

        # Extract normalized slices for scoring.
        query_slice_orth = " ".join(orth_words[si : ei + 1])
        cand_slice_orth = " ".join(cand_orth_words[sj : ej + 1])
        query_slice_phon = " ".join(phon_words[si : ei + 1]) if si < len(phon_words) else ""
        cand_slice_phon = " ".join(cand_phon_words[sj : ej + 1]) if sj < len(cand_phon_words) else ""

        orth_score = _score_slice(query_slice_orth, cand_slice_orth)
        phon_score = (
            _score_slice(query_slice_phon, cand_slice_phon)
            if query_slice_phon and cand_slice_phon
            else orth_score
        )

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

        # Lossless map from orth slice [sj..ej] back to raw Uthmani tokens and owning verses.
        raw_start = cand.orth_to_raw_idx[sj]
        raw_end = cand.orth_to_raw_idx[ej]
        matched_canonical = " ".join(cand.arabic_words[raw_start : raw_end + 1])

        matched_verses = tuple(dict.fromkeys(cand.orth_word_verses[sj : ej + 1]))
        matched_ref = _format_verse_range(matched_verses) or cand.reference
        matched_thai = " ".join(
            _BY_REFERENCE[v].thai for v in matched_verses if v in _BY_REFERENCE
        ).strip() or cand.thai

        eff_score = max(orth_score, phon_score) if tier == "rescue" else orth_score
        rank_key = (
            _TIER_RANK[tier],
            round(eff_score * span_len, 4),
            round(eff_score, 4),
            -len(matched_verses) if matched_verses else -cand.verse_count,
            -cand.verse_count,
        )

        if rank_key > best_rank:
            best_rank = rank_key
            best = MatchSpanResult(
                tier=tier,
                score_orthographic=round(orth_score, 4),
                score_phonetic=round(phon_score, 4),
                reference=matched_ref,
                start_word=si,
                end_word=ei,
                matched_canonical=matched_canonical,
                candidate_arabic=cand.arabic,
                candidate_thai=matched_thai,
                matched_verses=matched_verses,
            )

    return best


def match_text(text: str, *, min_score: float | None = None) -> QuranMatch | None:
    """Fuzzy match resolving the exact matched verse(s) for auto/rescue tiers."""
    result = match_span(text)
    if result is None:
        return None
    if result.tier not in ("auto", "rescue"):
        return None
    # For rescue tier, require span length >= 6 to auto-return.
    if result.tier == "rescue":
        span_len = result.end_word - result.start_word + 1
        if span_len < 6:
            return None
    # Threshold override.
    if min_score is not None and result.score_orthographic < min_score:
        return None
    _ensure_loaded()
    matched_verses = result.matched_verses
    if not matched_verses:
        ref = result.reference
        base = ref.split("-")[0]
        parts = base.split(":")
        if len(parts) != 2:
            return None
        try:
            surah, ayah = int(parts[0]), int(parts[1])
        except ValueError:
            return None
        matched_verses = ((surah, ayah),)

    verses = [_BY_REFERENCE[key] for key in matched_verses if key in _BY_REFERENCE]
    if not verses:
        return None

    first = verses[0]
    last = verses[-1]
    score = max(result.score_orthographic, result.score_phonetic)
    arabic_text = (
        first.arabic
        if len(verses) == 1
        else result.matched_canonical or " ".join(v.arabic for v in verses)
    )
    thai_text = (
        first.thai
        if len(verses) == 1
        else result.candidate_thai or " ".join(v.thai for v in verses)
    )
    end_ayah = last.ayah if len(verses) > 1 and last.surah == first.surah else None
    return QuranMatch(
        first.surah,
        first.ayah,
        arabic_text,
        thai_text,
        round(score, 4),
        end_ayah=end_ayah,
    )

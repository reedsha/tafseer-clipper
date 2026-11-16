"""Read-only Qur'an corpus and fuzzy verse matching.

The corpus is bundled from the user-provided Qur'an export as
``backend/data/quran.json`` (6,236 verses, Arabic + Thai translation, no audio).
It is used only for *Qur'an* candidates from the recitation recovery pass:
matching the recovered Arabic against the canonical text lets us replace an STT
transcription with the exact verse and show an editor a verifiable reference.

Hadith and general Arabic quotes are not in this corpus; the LLM proposes those
and the editor reviews them.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path

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
    normalized: str
    words: frozenset[str]


_LOCK = threading.Lock()
_VERSES: list[_Verse] | None = None
_BY_REFERENCE: dict[tuple[int, int], _Verse] = {}
_WORD_INDEX: dict[str, set[int]] = {}


def normalize_arabic(text: str) -> str:
    """Normalize Arabic for matching, without changing the displayed text."""
    value = unicodedata.normalize("NFKC", text or "")
    value = _DIACRITICS.sub("", value).translate(_TRANSLATION)
    value = _NON_ARABIC.sub(" ", value)
    return _SPACES.sub(" ", value).strip()


def _load() -> None:
    global _VERSES, _BY_REFERENCE, _WORD_INDEX
    if _VERSES is not None:
        return
    with _LOCK:
        if _VERSES is not None:
            return
        if not CORPUS_PATH.is_file():
            logger.warning("Qur'an corpus missing at %s", CORPUS_PATH)
            _VERSES = []
            return
        payload = json.loads(CORPUS_PATH.read_text(encoding="utf-8"))
        verses: list[_Verse] = []
        by_reference: dict[tuple[int, int], _Verse] = {}
        index: dict[str, set[int]] = {}
        for row in payload.get("verses") or []:
            if not isinstance(row, (list, tuple)) or len(row) < 4:
                continue
            surah, ayah, arabic, thai = int(row[0]), int(row[1]), str(row[2]), str(row[3])
            normalized = normalize_arabic(arabic)
            words = frozenset(normalized.split())
            verse = _Verse(surah, ayah, arabic, thai, normalized, words)
            position = len(verses)
            verses.append(verse)
            by_reference[(surah, ayah)] = verse
            for word in words:
                if len(word) < 2:
                    continue
                index.setdefault(word, set()).add(position)
        _VERSES = verses
        _BY_REFERENCE = by_reference
        _WORD_INDEX = index
        logger.info(
            "Loaded Qur'an corpus: %d verses, %d surahs",
            len(verses),
            len({verse.surah for verse in verses}),
        )


def corpus_size() -> int:
    _load()
    return len(_VERSES or [])


def lookup(surah: int, ayah: int) -> QuranMatch | None:
    _load()
    verse = _BY_REFERENCE.get((int(surah), int(ayah)))
    if verse is None:
        return None
    return QuranMatch(verse.surah, verse.ayah, verse.arabic, verse.thai, 1.0)


def match_text(text: str, *, min_score: float | None = None) -> QuranMatch | None:
    """Best Qur'an verse for recovered Arabic text, or ``None``.

    Matching is deliberately conservative: the editor still reviews every
    Arabic passage, and a wrong reference is worse than no reference.
    """
    _load()
    if not _VERSES:
        return None
    query = normalize_arabic(text)
    query_words = query.split()
    if len(query_words) < MIN_MATCH_WORDS:
        return None

    query_set = set(query_words)
    candidates: set[int] = set()
    for word in query_set:
        if len(word) < 2:
            continue
        candidates.update(_WORD_INDEX.get(word, ()))
    if not candidates:
        return None

    # Short queries need a near-exact match; long ones tolerate STT errors.
    threshold = min_score
    if threshold is None:
        threshold = 0.78 if len(query_set) <= 3 else 0.58

    best: tuple[float, _Verse] | None = None
    for position in candidates:
        verse = _VERSES[position]
        intersection = len(query_set & verse.words)
        if intersection == 0:
            continue
        overlap = intersection / max(len(query_set), len(verse.words))
        # A quick lower bound before the more expensive string ratio.
        if overlap < threshold * 0.75:
            continue
        ratio = SequenceMatcher(None, query, verse.normalized).ratio()
        score = max(overlap, ratio)
        if best is None or score > best[0]:
            best = (score, verse)

    if best is None or best[0] < threshold:
        return None
    score, verse = best
    return QuranMatch(verse.surah, verse.ayah, verse.arabic, verse.thai, round(score, 4))

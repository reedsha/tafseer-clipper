#!/usr/bin/env python3
"""Build the bundled Qur'an corpus from the user-provided raw export.

The raw export is a per-surah HTML reader (``quran-html/1.html`` … ``114.html``)
plus a flattened ``qurannew.json``.  The JSON contains three misnumbered verses
in surah 37 (37:5/37:61/37:62/37:66) and unused ``audio`` filenames; the HTML
numbering is correct.  This script reads the HTML (or a JSON file), validates
6,236 verses / 114 surahs, drops all audio references and writes a compact,
audio-free JSON file to ``backend/data/quran.json``, which is what
``build_sidecar.spec`` bundles.  The HTML is not bundled.

Usage::

    py -3.12 backend/scripts/build_quran_corpus.py \
        --source "C:/path/to/quran-whole-raw/quran-html"

The raw files are not part of the repository; the generated file is.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
from pathlib import Path

EXPECTED_VERSES = 6_236
EXPECTED_SURAHS = 114
DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "data" / "quran.json"

VERSE_PATTERN = re.compile(
    r"<div class='Qrow'>.*?<p class='Qtext-Ar'>(.*?)</p>\s*"
    r"<p class='Qtext'><span class='Qayah'>(\d+)</span>(.*?)</p>",
    re.S,
)

_BASMALA_DIACRITICS = re.compile(r"[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]")
_BASMALA = "بسم الله الرحمن الرحيم"


def _strip_basmala(surah: int, ayah: int, arabic: str) -> str:
    """Remove the display basmala from the first verse of a surah.

    The HTML reader prefixes the basmala to the first verse of nearly every
    surah, but it is not part of the verse (except 1:1).  Keeping it would make
    fuzzy matching miss the actual first verse and would burn the basmala into a
    clip that starts at 2:1, etc.
    """
    if surah == 1 or ayah != 1:
        return arabic
    words = arabic.split()
    if len(words) <= 4:
        return arabic
    first = " ".join(words[:4])
    normalized = (
        _BASMALA_DIACRITICS.sub("", first)
        .replace("ٱ", "ا")
        .replace("أ", "ا")
        .replace("إ", "ا")
        .replace("آ", "ا")
        .replace("ى", "ي")
        .replace("ة", "ه")
    )
    if normalized != _BASMALA:
        return arabic
    return " ".join(words[4:]).strip()



def _read_html(directory: Path) -> list[tuple[int, int, str, str]]:
    verses: list[tuple[int, int, str, str]] = []
    for path in sorted(directory.glob("*.html")):
        if not path.stem.isdigit():
            continue
        surah = int(path.stem)
        text = path.read_text(encoding="utf-8")
        found = 0
        for match in VERSE_PATTERN.finditer(text):
            arabic = html.unescape(re.sub("<[^>]+>", "", match.group(1))).replace("&nbsp;", " ")
            thai = html.unescape(re.sub("<[^>]+>", "", match.group(3))).replace("&nbsp;", " ")
            ayah = int(match.group(2))
            verses.append(
                (
                    surah,
                    ayah,
                    _strip_basmala(surah, ayah, re.sub(r"\s+", " ", arabic).strip()),
                    re.sub(r"\s+", " ", thai).strip(),
                )
            )
            found += 1
        if found == 0:
            raise SystemExit(f"No verses parsed from {path}.")
    return verses


def _read_json(source: Path) -> list[tuple[int, int, str, str]]:
    raw = json.loads(source.read_text(encoding="utf-8-sig"))
    if not isinstance(raw, list):
        raise SystemExit("The source JSON must be an array of verses.")
    verses = []
    for item in raw:
        if not isinstance(item, dict):
            raise SystemExit("Every verse must be an object.")
        verses.append(
            (
                int(item["surah_number"]),
                int(item["verse_number"]),
                str(item.get("content") or "").strip(),
                str(item.get("thtran") or "").strip(),
            )
        )
    return verses


def build(source: Path, output: Path) -> None:
    verses = _read_html(source) if source.is_dir() else _read_json(source)
    if len(verses) != EXPECTED_VERSES:
        raise SystemExit(f"Expected {EXPECTED_VERSES} verses, found {len(verses)}.")

    seen: set[tuple[int, int]] = set()
    surahs: set[int] = set()
    compact: list[list[object]] = []
    for surah, ayah, arabic, thai in verses:
        if not arabic or not thai:
            raise SystemExit(f"Empty text at {surah}:{ayah}.")
        key = (surah, ayah)
        if key in seen:
            raise SystemExit(f"Duplicate verse {surah}:{ayah}.")
        seen.add(key)
        surahs.add(surah)
        compact.append([surah, ayah, arabic, thai])

    if surahs != set(range(1, EXPECTED_SURAHS + 1)):
        raise SystemExit(f"Expected surahs 1..{EXPECTED_SURAHS}, found {len(surahs)}.")

    payload = {
        "version": "1",
        "source": "user-provided Qur'an export (Arabic + Thai translation)",
        "verseCount": len(compact),
        "surahCount": len(surahs),
        # ``audio`` is deliberately dropped: the filenames are not part of the
        # export and the sidecar never uses them (matching is text-only).
        "verses": compact,
    }
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(text + "\n", encoding="utf-8")
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    print(f"Wrote {output}")
    print(f"verses={len(compact)} surahs={len(surahs)} bytes={output.stat().st_size}")
    print(f"sha256={digest}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        required=True,
        help="quran-html/ directory or the flattened qurannew.json export",
    )
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    if not args.source.exists():
        raise SystemExit(f"Source not found: {args.source}")
    build(args.source, args.output)


if __name__ == "__main__":
    main()

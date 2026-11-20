"""Dual-style Advanced SubStation Alpha (.ass) + .srt generator.

The plan requires two independent styles inside a single ``.ass`` file so the
Arabic Quranic line and its Thai translation can carry different fonts, sizes,
colours and vertical Harakat padding, while ``PlayResX``/``PlayResY`` stay
locked to the export resolution.  FFmpeg then burns the file with
``ass=...:fontsdir=...`` so imported fonts resolve identically to the React
preview.

Colour note: ASS stores colours as ``&HAABBGGRR`` (alpha first, BGR order).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


# --------------------------------------------------------------------------- #
# Data transfer objects
# --------------------------------------------------------------------------- #
@dataclass(slots=True)
class Cue:
    """One subtitle block: optional Arabic line + optional Thai line."""

    start: float
    end: float
    arabic: str = ""
    thai: str = ""

    def has_arabic(self) -> bool:
        return bool(self.arabic.strip())

    def has_thai(self) -> bool:
        return bool(self.thai.strip())


@dataclass(slots=True)
class StyleConfig:
    name: str
    font: str
    size: int
    primary_color: str = "#FFFFFF"
    outline_color: str = "#000000"
    back_color: str = "#000000"
    bold: bool = False
    outline: float = 2.0
    shadow: float = 1.0
    margin_v: int = 150
    margin_l: int = 60
    margin_r: int = 60
    spacing: float = 0.0
    encoding: int = 1
    border_style: int = 1
    #: ASS alpha for ``BackColour`` (``00`` = opaque, ``FF`` = transparent).
    #: ``BorderStyle 1`` uses it for the shadow; ``BorderStyle 3`` for the box.
    back_alpha: str = "80"


@dataclass(slots=True)
class AssDocument:
    content: str
    cue_count: int
    style_names: list[str] = field(default_factory=lambda: ["ArabicStyle", "ThaiStyle"])


RESOLUTIONS: dict[str, tuple[int, int]] = {
    "1080x1920": (1080, 1920),
    "1920x1080": (1920, 1080),
}


# --------------------------------------------------------------------------- #
# Formatting helpers
# --------------------------------------------------------------------------- #
def parse_resolution(resolution: str) -> tuple[int, int]:
    if resolution not in RESOLUTIONS:
        raise ValueError(f"Unsupported resolution '{resolution}'")
    return RESOLUTIONS[resolution]


def ass_color(value: str, alpha: str = "00") -> str:
    """Normalise ``#RRGGBB`` / ``RRGGBB`` / ``&H...`` into ``&HAABBGGRR``."""
    raw = value.strip()
    if raw.upper().startswith("&H"):
        digits = raw[2:]
        return "&H" + digits.upper().rjust(8, "0")

    hex_digits = raw.lstrip("#")
    if len(hex_digits) == 6:
        red, green, blue = (
            hex_digits[0:2],
            hex_digits[2:4],
            hex_digits[4:6],
        )
        return f"&H{alpha}{blue}{green}{red}".upper()
    raise ValueError(f"Unsupported ASS colour '{value}'")


def format_ass_time(seconds: float) -> str:
    """Format ``H:MM:SS.cc``; centiseconds are rounded before the carry.

    Rounding the seconds field directly used to emit ``0:00:60.00`` for cue
    boundaries in the 59.995-59.999 s window; carrying centiseconds first keeps
    every field in range.
    """
    total_centis = max(0, round(max(0.0, float(seconds)) * 100))
    hours, remainder = divmod(total_centis, 360_000)
    minutes, remainder = divmod(remainder, 6_000)
    secs, centis = divmod(remainder, 100)
    return f"{hours}:{minutes:02d}:{secs:02d}.{centis:02d}"


def format_srt_time(seconds: float) -> str:
    total_ms = round(max(0.0, float(seconds)) * 1000)
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


#: Fullwidth reverse solidus (U+FF3C): looks like a backslash but is not an ASS
#: escape, so an editor-typed ``\N`` / ``\n`` / ``\h`` renders as plain text.
_SAFE_BACKSLASH = "\uFF3C"


def escape_ass_text(text: str) -> str:
    """Escape ASS override syntax and turn newlines into hard breaks.

    Literal ``\\N``/``\\n``/``\\h`` sequences typed by the editor are neutralised
    (leading backslash replaced) so libass cannot interpret them as line breaks
    or overrides; real newlines still become ``\\N``.
    """
    cleaned = text.replace("{", "\\{").replace("}", "\\}")
    for sequence in ("\\N", "\\n", "\\h"):
        cleaned = cleaned.replace(sequence, _SAFE_BACKSLASH + sequence[1:])
    cleaned = cleaned.replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.strip() for line in cleaned.split("\n") if line.strip()]
    return "\\N".join(lines)


# --------------------------------------------------------------------------- #
# Default styles
# --------------------------------------------------------------------------- #
def default_styles(resolution: str) -> tuple[StyleConfig, StyleConfig]:
    """Plan defaults: warm gold Uthmani Arabic above crisp white Thai."""
    width, height = parse_resolution(resolution)
    portrait = height > width

    if portrait:
        arabic = StyleConfig(
            name="ArabicStyle",
            font="Noto Naskh Arabic",
            size=64,
            primary_color="#dcb46e",
            margin_v=252,
            margin_l=54,
            margin_r=54,
            outline=2.0,
            shadow=1.0,
        )
        thai = StyleConfig(
            name="ThaiStyle",
            font="Leelawadee UI",
            size=44,
            primary_color="#f4f4f1",
            margin_v=160,
            margin_l=54,
            margin_r=54,
            outline=3.0,
            shadow=1.0,
            border_style=3,
            back_color="#000000",
            back_alpha="D8",
        )
    else:
        arabic = StyleConfig(
            name="ArabicStyle",
            font="Noto Naskh Arabic",
            size=54,
            primary_color="#dcb46e",
            margin_v=142,
            margin_l=80,
            margin_r=80,
            outline=2.0,
            shadow=1.0,
        )
        thai = StyleConfig(
            name="ThaiStyle",
            font="Leelawadee UI",
            size=38,
            primary_color="#f4f4f1",
            margin_v=80,
            margin_l=80,
            margin_r=80,
            outline=3.0,
            shadow=1.0,
            border_style=3,
            back_color="#000000",
            back_alpha="D8",
        )
    return arabic, thai


# --------------------------------------------------------------------------- #
# .ass document
# --------------------------------------------------------------------------- #
def _style_line(style: StyleConfig) -> str:
    bold = -1 if style.bold else 0
    return ",".join(
        [
            style.name,
            style.font,
            str(style.size),
            ass_color(style.primary_color),
            ass_color(style.primary_color),  # SecondaryColour (unused, karaoke)
            ass_color(style.outline_color),
            ass_color(style.back_color, alpha=style.back_alpha),  # shadow / box
            str(bold),
            "0",  # Italic
            "0",  # Underline
            "0",  # StrikeOut
            "100",  # ScaleX
            "100",  # ScaleY
            f"{style.spacing:g}",
            "0",  # Angle
            str(style.border_style),
            f"{style.outline:g}",
            f"{style.shadow:g}",
            "2",  # Alignment: bottom centre
            str(style.margin_l),
            str(style.margin_r),
            str(style.margin_v),
            str(style.encoding),
        ]
    )


def build_ass(
    cues: list[Cue],
    *,
    resolution: str = "1080x1920",
    arabic_style: StyleConfig | None = None,
    thai_style: StyleConfig | None = None,
    title: str = "Tafseer Clipper",
    clip_duration: float | None = None,
) -> AssDocument:
    """Render a dual-style ``.ass`` document.

    Cue times are clip-relative seconds.  Each cue emits up to two ``Dialogue``
    events (``ArabicStyle`` stacked above ``ThaiStyle``) so both lines keep
    independent fonts, margins and Harakat padding.
    """
    width, height = parse_resolution(resolution)
    default_arabic, default_thai = default_styles(resolution)
    arabic = arabic_style or default_arabic
    thai = thai_style or default_thai

    header = [
        "[Script Info]",
        "; Generated by Tafseer Clipper - do not edit by hand",
        f"Title: {title}",
        "ScriptType: v4.00+",
        "WrapStyle: 2",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "ScaledBorderAndShadow: yes",
        "YCbCr Matrix: TV.709",
        "",
        "[V4+ Styles]",
        (
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
            "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, "
            "ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, "
            "MarginL, MarginR, MarginV, Encoding"
        ),
        f"Style: {_style_line(arabic)}",
        f"Style: {_style_line(thai)}",
        "",
        "[Events]",
        (
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, "
            "Effect, Text"
        ),
    ]

    events: list[str] = []
    emitted = 0
    for cue in cues:
        start = max(0.0, float(cue.start))
        end = max(start + 0.01, float(cue.end))
        if clip_duration is not None:
            end = min(end, float(clip_duration))
            if end <= start:
                continue

        if cue.has_arabic():
            events.append(
                f"Dialogue: 0,{format_ass_time(start)},{format_ass_time(end)},{arabic.name},,0,0,0,,{escape_ass_text(cue.arabic)}"
            )
            emitted += 1
        if cue.has_thai():
            events.append(
                f"Dialogue: 0,{format_ass_time(start)},{format_ass_time(end)},{thai.name},,0,0,0,,{escape_ass_text(cue.thai)}"
            )
            emitted += 1

    content = "\n".join(header + events) + "\n"
    return AssDocument(
        content=content,
        cue_count=emitted,
        style_names=[arabic.name, thai.name],
    )


def write_ass(path: str | Path, **kwargs) -> AssDocument:
    document = build_ass(**kwargs)
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(document.content, encoding="utf-8", newline="\n")
    return document


# --------------------------------------------------------------------------- #
# .srt sidecar
# --------------------------------------------------------------------------- #
def build_srt(cues: list[Cue], *, clip_duration: float | None = None) -> str:
    blocks: list[str] = []
    index = 0
    for cue in cues:
        start = max(0.0, float(cue.start))
        end = max(start + 0.01, float(cue.end))
        if clip_duration is not None:
            end = min(end, float(clip_duration))
            if end <= start:
                continue

        lines: list[str] = []
        if cue.has_arabic():
            lines.append(cue.arabic.strip())
        if cue.has_thai():
            lines.append(cue.thai.strip())
        if not lines:
            continue

        index += 1
        blocks.append(
            f"{index}\n"
            f"{format_srt_time(start)} --> {format_srt_time(end)}\n"
            + "\n".join(lines)
        )
    return "\n\n".join(blocks) + ("\n" if blocks else "")


def write_srt(path: str | Path, cues: list[Cue], *, clip_duration: float | None = None) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(build_srt(cues, clip_duration=clip_duration), encoding="utf-8")
    return target

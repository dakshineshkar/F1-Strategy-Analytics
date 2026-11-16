"""Committed reference tables for the display-only entrants dimension (Feature 1).

Plain Python (no Spark, pandas or I/O), so the job, the API and the tests share one copy.

``TEAM_NAMES``
    (season, Jolpica ``constructorId``) -> the Jolpica constructor name we expect in the clean
    ``constructors`` table, the display name for that season, and a short badge code. Jolpica
    keeps one name per id across seasons ("RB F1 Team" in 2024 and 2025), so the season's display
    name ("RB" in 2024, "Racing Bulls" in 2025) comes from here. The entrants job fails on any
    (season, id) missing here and on any Jolpica name that differs from ``jolpica_name``. Verified
    against the full 2021-2025 clean zone on 2026-11-15; the TracingInsights team names of every
    race agree with ``team_name`` (the job reports any disagreement in its quality JSON).

``PROJECT_PALETTE``
    (season, id) -> a ``#RRGGBB`` colour. **Source: project-chosen approximations of each team's
    identity colour, picked by the project team; not copied from TracingInsights, FastF1 or FOM
    data** (DATA_LICENSES.md: that data is never committed). It is used only when the lake holds
    no TracingInsights colour for the team in that season (sample mode, CI). Real per-race colours
    stay in the lake (``colour_source`` ``ti_race`` / ``ti_neighbour_round_<n>``).

``NATIONALITY_CODES``
    Jolpica demonym -> F1-style three-letter code (as on F1 timing graphics: MON for Monaco, NED
    for the Netherlands, GER for Germany, GBR for Great Britain). It holds the 21 demonyms of the
    2021-2025 entrants; the job fails on any other demonym, so a new one is added here explicitly.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from types import MappingProxyType
from typing import Final

HEX_COLOUR: Final = re.compile(r"^#[0-9A-F]{6}$")
BLACK: Final = "#000000"
WHITE: Final = "#FFFFFF"


@dataclass(frozen=True)
class TeamName:
    jolpica_name: str
    team_name: str
    team_code: str


_ALL = (2021, 2022, 2023, 2024, 2025)
_UNTIL_2023 = (2021, 2022, 2023)
_FROM_2024 = (2024, 2025)


def _team_rows() -> dict[tuple[int, str], TeamName]:
    rows: dict[tuple[int, str], TeamName] = {}

    def add(cid: str, seasons: tuple[int, ...], jolpica: str, name: str, code: str) -> None:
        for s in seasons:
            rows[(s, cid)] = TeamName(jolpica, name, code)

    add("alfa", (2021,), "Alfa Romeo", "Alfa Romeo Racing", "ALF")
    add("alfa", (2022, 2023), "Alfa Romeo", "Alfa Romeo", "ALF")
    add("alphatauri", _UNTIL_2023, "AlphaTauri", "AlphaTauri", "APT")
    add("alpine", _ALL, "Alpine F1 Team", "Alpine", "ALP")
    add("aston_martin", _ALL, "Aston Martin", "Aston Martin", "AMR")
    add("ferrari", _ALL, "Ferrari", "Ferrari", "FER")
    add("haas", _ALL, "Haas F1 Team", "Haas F1 Team", "HAA")
    add("mclaren", _ALL, "McLaren", "McLaren", "MCL")
    add("mercedes", _ALL, "Mercedes", "Mercedes", "MER")
    add("red_bull", _ALL, "Red Bull", "Red Bull Racing", "RBR")
    add("rb", (2024,), "RB F1 Team", "RB", "RB")
    add("rb", (2025,), "RB F1 Team", "Racing Bulls", "RCB")
    add("sauber", _FROM_2024, "Sauber", "Kick Sauber", "SAU")
    add("williams", _ALL, "Williams", "Williams", "WIL")
    return rows


TEAM_NAMES: Final = MappingProxyType(_team_rows())

# Project-chosen identity colours (see the module docstring). One base colour per team; a team's
# entry exists for every season in which it appears in TEAM_NAMES.
_BASE_PALETTE: Final = {
    "alfa": "#9E1B32",
    "alphatauri": "#30506F",
    "alpine": "#1C8FD6",
    "aston_martin": "#1F7A5C",
    "ferrari": "#D9142B",
    "haas": "#A7ABAF",
    "mclaren": "#F27C12",
    "mercedes": "#16C7B0",
    "red_bull": "#2B4BB8",
    "rb": "#5D86F0",
    "sauber": "#3DD43D",
    "williams": "#2F6FE0",
}
PROJECT_PALETTE: Final = MappingProxyType(
    {(s, cid): _BASE_PALETTE[cid] for (s, cid) in sorted(TEAM_NAMES)}
)

NATIONALITY_CODES: Final = MappingProxyType(
    {
        "American": "USA",
        "Argentine": "ARG",
        "Australian": "AUS",
        "Brazilian": "BRA",
        "British": "GBR",
        "Canadian": "CAN",
        "Chinese": "CHN",
        "Danish": "DEN",
        "Dutch": "NED",
        "Finnish": "FIN",
        "French": "FRA",
        "German": "GER",
        "Italian": "ITA",
        "Japanese": "JPN",
        "Mexican": "MEX",
        "Monegasque": "MON",
        "New Zealander": "NZL",
        "Polish": "POL",
        "Russian": "RUS",
        "Spanish": "ESP",
        "Thai": "THA",
    }
)

COLOUR_SOURCE_TI_RACE: Final = "ti_race"
COLOUR_SOURCE_NEIGHBOUR_PREFIX: Final = "ti_neighbour_round_"
COLOUR_SOURCE_PALETTE: Final = "project_palette"
COLOUR_SOURCE_PATTERN: Final = re.compile(
    r"^(ti_race|ti_neighbour_round_[1-9][0-9]?|project_palette)$"
)


class EntrantsReferenceError(ValueError):
    """A value is missing from a committed reference table."""


def team_name(season: int, constructor_id: str) -> TeamName:
    """The committed names of ``constructor_id`` in ``season``; raises if not listed."""
    try:
        return TEAM_NAMES[(season, constructor_id)]
    except KeyError:
        raise EntrantsReferenceError(
            f"constructor {constructor_id!r} in {season} is not in entrants_reference.TEAM_NAMES"
        ) from None


def nationality_code(demonym: str) -> str:
    """The F1-style code of a Jolpica demonym; raises if not listed."""
    try:
        return NATIONALITY_CODES[demonym]
    except KeyError:
        raise EntrantsReferenceError(
            f"nationality {demonym!r} is not in entrants_reference.NATIONALITY_CODES"
        ) from None


def normalise_hex(value: str | None) -> str | None:
    """``'3671c6'`` / ``'#3671C6'`` -> ``'#3671C6'``; a missing value (None, '', 'None') -> None.

    Raises ``EntrantsReferenceError`` for anything else, so a malformed colour is never shown."""
    if value is None:
        return None
    text = value.strip()
    if text in ("", "None"):
        return None
    out = "#" + text.removeprefix("#").upper()
    if not HEX_COLOUR.match(out):
        raise EntrantsReferenceError(f"not a #RRGGBB colour: {value!r}")
    return out


def _channel(c: int) -> float:
    v = c / 255
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def relative_luminance(hex_colour: str) -> float:
    """WCAG 2 relative luminance of ``#RRGGBB``."""
    if not HEX_COLOUR.match(hex_colour):
        raise EntrantsReferenceError(f"not a #RRGGBB colour: {hex_colour!r}")
    r, g, b = (int(hex_colour[i : i + 2], 16) for i in (1, 3, 5))
    return 0.2126 * _channel(r) + 0.7152 * _channel(g) + 0.0722 * _channel(b)


def contrast_ratio(a: str, b: str) -> float:
    """WCAG 2 contrast ratio of two ``#RRGGBB`` colours (1.0 to 21.0)."""
    la, lb = sorted((relative_luminance(a), relative_luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def badge_text_colour(hex_colour: str) -> str:
    """Black or white, whichever contrasts more with ``hex_colour`` (always >= 4.58:1).

    ``web/src/lib/entrants.ts`` implements the same rule for the dashboard."""
    return (
        BLACK if contrast_ratio(hex_colour, BLACK) >= contrast_ratio(hex_colour, WHITE) else WHITE
    )

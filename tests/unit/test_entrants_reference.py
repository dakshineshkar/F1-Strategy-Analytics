"""Committed reference tables of the entrants dimension: coverage, formats and badge contrast."""

from __future__ import annotations

import itertools
import re

import pytest

from f1sa.etl import entrants_reference as R
from f1sa.features import lineage

SEASONS = (2021, 2022, 2023, 2024, 2025)


def test_team_names_cover_every_known_constructor_in_its_seasons() -> None:
    by_id: dict[str, set[int]] = {}
    for s, cid in R.TEAM_NAMES:
        by_id.setdefault(cid, set()).add(s)
    assert set(by_id) == set(lineage.LINEAGE) | lineage.STABLE_CONSTRUCTORS
    assert by_id["alfa"] == by_id["alphatauri"] == {2021, 2022, 2023}
    assert by_id["rb"] == by_id["sauber"] == {2024, 2025}
    for cid in lineage.STABLE_CONSTRUCTORS - {"rb", "sauber"}:
        assert by_id[cid] == set(SEASONS)
    for s in SEASONS:
        assert sum(1 for (ss, _c) in R.TEAM_NAMES if ss == s) == 10


def test_season_display_names() -> None:
    assert R.team_name(2024, "rb").team_name == "RB"
    assert R.team_name(2025, "rb").team_name == "Racing Bulls"
    assert (
        R.team_name(2024, "rb").jolpica_name == R.team_name(2025, "rb").jolpica_name == "RB F1 Team"
    )
    assert R.team_name(2021, "alfa").team_name == "Alfa Romeo Racing"
    assert R.team_name(2023, "alfa").team_name == "Alfa Romeo"
    assert R.team_name(2023, "alphatauri").team_name == "AlphaTauri"
    assert R.team_name(2024, "sauber").team_name == "Kick Sauber"
    assert R.team_name(2022, "red_bull").team_name == "Red Bull Racing"


def test_team_codes_are_short_upper_and_unique_per_season() -> None:
    for s in SEASONS:
        codes = [t.team_code for (ss, _c), t in R.TEAM_NAMES.items() if ss == s]
        assert len(codes) == len(set(codes)) == 10
        assert all(re.fullmatch(r"[A-Z]{2,3}", c) for c in codes)


def test_unknown_team_and_demonym_raise() -> None:
    with pytest.raises(R.EntrantsReferenceError, match="'rb' in 2023"):
        R.team_name(2023, "rb")
    with pytest.raises(R.EntrantsReferenceError, match="'Martian'"):
        R.nationality_code("Martian")


def test_nationality_codes() -> None:
    assert len(R.NATIONALITY_CODES) == 21
    codes = list(R.NATIONALITY_CODES.values())
    assert len(codes) == len(set(codes))
    assert all(re.fullmatch(r"[A-Z]{3}", c) for c in codes)
    assert R.nationality_code("Monegasque") == "MON"
    assert R.nationality_code("Dutch") == "NED"
    assert R.nationality_code("British") == "GBR"
    assert R.nationality_code("German") == "GER"
    assert R.nationality_code("New Zealander") == "NZL"


def test_palette_covers_team_names_with_valid_hex() -> None:
    assert set(R.PROJECT_PALETTE) == set(R.TEAM_NAMES)
    assert all(R.HEX_COLOUR.match(v) for v in R.PROJECT_PALETTE.values())


@pytest.mark.parametrize(
    ("raw", "out"),
    [
        ("3671c6", "#3671C6"),
        ("#3671C6", "#3671C6"),
        (" 00d2be ", "#00D2BE"),
        (None, None),
        ("", None),
        ("None", None),
    ],
)
def test_normalise_hex(raw: str | None, out: str | None) -> None:
    assert R.normalise_hex(raw) == out


@pytest.mark.parametrize("raw", ["red", "12345", "#1234567", "GGGGGG"])
def test_normalise_hex_rejects_malformed(raw: str) -> None:
    with pytest.raises(R.EntrantsReferenceError):
        R.normalise_hex(raw)


def test_contrast_ratio_reference_values() -> None:
    assert R.contrast_ratio(R.BLACK, R.WHITE) == pytest.approx(21.0)
    assert R.contrast_ratio("#777777", "#777777") == pytest.approx(1.0)
    with pytest.raises(R.EntrantsReferenceError):
        R.relative_luminance("#12345")


def test_badge_text_meets_aa_for_the_palette_and_any_colour() -> None:
    for colour in R.PROJECT_PALETTE.values():
        assert R.contrast_ratio(colour, R.badge_text_colour(colour)) >= 4.5
    steps = range(0, 256, 15)
    for r, g, b in itertools.product(steps, steps, steps):
        colour = f"#{r:02X}{g:02X}{b:02X}"
        assert R.contrast_ratio(colour, R.badge_text_colour(colour)) >= 4.5, colour
    assert R.badge_text_colour("#FFFFFF") == R.BLACK
    assert R.badge_text_colour("#0600EF") == R.WHITE

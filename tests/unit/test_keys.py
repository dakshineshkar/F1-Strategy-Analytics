"""The exact Redis key contract (CLAUDE.md): names, validation and the SCAN pattern."""

from __future__ import annotations

from fnmatch import fnmatchcase

import pytest

from f1sa.serving import keys as K


def test_exact_names() -> None:
    assert K.driver_key(2024, 5, "max_verstappen") == "race:2024:5:driver:max_verstappen"
    assert K.order_key(2024, 5) == "race:2024:5:order"
    assert K.events_channel(2024, 5) == "race:2024:5:events"
    assert K.race_pattern(2024, 5) == "race:2024:5:*"
    assert K.race_prefix(2021, 22) == "race:2021:22"


def test_contract_constants() -> None:
    assert K.DRIVER_FIELDS == (
        "position",
        "gap_ahead_s",
        "gap_leader_s",
        "tyre_compound",
        "tyre_age_laps",
        "last_lap_time_s",
        "undercut_flag",
        "undercut_prob",
        "updated_at",
    )
    assert K.EVENT_TYPES == ("lap", "pit_in", "pit_out", "undercut_alert", "session_end")


@pytest.mark.parametrize(("season", "round_"), [(1950, 1), (2100, 30), (2025, 24)])
def test_boundaries_accepted(season: int, round_: int) -> None:
    assert K.order_key(season, round_) == f"race:{season}:{round_}:order"
    assert K.driver_key(season, round_, "a") == f"race:{season}:{round_}:driver:a"


@pytest.mark.parametrize("season", [1949, 2101, 0, -2024, True, "2024", 2024.0, None])
def test_invalid_season_rejected(season: object) -> None:
    for fn in (K.order_key, K.events_channel, K.race_pattern):
        with pytest.raises(K.InvalidKeyError, match="season"):
            fn(season, 5)  # type: ignore[arg-type]
    with pytest.raises(K.InvalidKeyError, match="season"):
        K.driver_key(season, 5, "hamilton")  # type: ignore[arg-type]


@pytest.mark.parametrize("round_", [0, 31, -1, False, "5", 5.0, None])
def test_invalid_round_rejected(round_: object) -> None:
    for fn in (K.order_key, K.events_channel, K.race_pattern):
        with pytest.raises(K.InvalidKeyError, match="round"):
            fn(2024, round_)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "driver_id",
    ["VER", "max-verstappen", "", "a b", "hamilton:1", "hamilton*", "pérez", "x\n", None, 44],
)
def test_invalid_driver_id_rejected(driver_id: object) -> None:
    with pytest.raises(K.InvalidKeyError, match="driverId"):
        K.driver_key(2024, 5, driver_id)  # type: ignore[arg-type]


@pytest.mark.parametrize("driver_id", ["max_verstappen", "hamilton", "de_vries", "a1", "_"])
def test_valid_driver_ids(driver_id: str) -> None:
    assert K.validate_driver_id(driver_id) == driver_id


def test_pattern_matches_only_its_race() -> None:
    pattern = K.race_pattern(2024, 2)
    assert fnmatchcase(K.driver_key(2024, 2, "hamilton"), pattern)
    assert fnmatchcase(K.order_key(2024, 2), pattern)
    for other in (K.order_key(2024, 25), K.order_key(2024, 12), K.order_key(2023, 2)):
        assert not fnmatchcase(other, pattern)


# ------------------------------------------------------------- additive tyre hash (display only)
def test_tyre_key_is_additive_and_exact() -> None:
    assert K.tyre_key(2024, 5, "max_verstappen") == "race:2024:5:tyre:max_verstappen"
    assert K.TYRE_FIELDS == ("tyre_life_laps", "tyre_life_at_start_laps", "lap", "updated_at")
    # the 9-field driver hash is unchanged and shares no field name with the tyre hash
    assert len(K.DRIVER_FIELDS) == 9 and "tyre_age_laps" in K.DRIVER_FIELDS
    assert not set(K.TYRE_FIELDS) - {"updated_at"} & set(K.DRIVER_FIELDS)
    # it is a race key: the SCAN pattern (TTL, session_end EXPIRE) matches it, other races do not
    assert fnmatchcase(K.tyre_key(2024, 5, "a"), K.race_pattern(2024, 5))
    assert not fnmatchcase(K.tyre_key(2024, 15, "a"), K.race_pattern(2024, 1))
    # never mistaken for a driver hash
    assert not K.tyre_key(2024, 5, "a").startswith(K.driver_key(2024, 5, "a")[:-1])


@pytest.mark.parametrize("driver_id", ["VER", "max-verstappen", "", "a:b", "x*", None, 44])
def test_tyre_key_validates_the_driver_id(driver_id: object) -> None:
    with pytest.raises(K.InvalidKeyError, match="driverId"):
        K.tyre_key(2024, 5, driver_id)  # type: ignore[arg-type]


@pytest.mark.parametrize(("season", "round_"), [(1949, 5), (2024, 0), (2024, 31), (True, 5)])
def test_tyre_key_validates_the_race(season: object, round_: object) -> None:
    with pytest.raises(K.InvalidKeyError):
        K.tyre_key(season, round_, "a")  # type: ignore[arg-type]


# ------------------------------------------------------ additive entrants cache (display only)
def test_entrants_meta_key_is_outside_the_race_namespace() -> None:
    key = K.entrants_meta_key(2024, 5)
    assert key == "meta:entrants:2024:5"
    # never a race key: /state, the SSE snapshots and expire_race (SCAN race:{s}:{r}:*) skip it
    assert not fnmatchcase(key, K.race_pattern(2024, 5))
    assert not key.startswith("race:")
    assert K.entrants_meta_key(2024, 1) != K.entrants_meta_key(2024, 15)


@pytest.mark.parametrize(
    ("season", "round_"), [(1949, 5), (2024, 0), (2024, 31), (True, 5), ("2024", 5)]
)
def test_entrants_meta_key_validates_the_race(season: object, round_: object) -> None:
    with pytest.raises(K.InvalidKeyError):
        K.entrants_meta_key(season, round_)  # type: ignore[arg-type]


# ------------------------------------------------------ additive analysis cache (display only)
@pytest.mark.parametrize("view", ["laps", "stints", "pitstops", "race_control", "positions"])
def test_analysis_meta_key_is_outside_the_race_namespace(view: str) -> None:
    key = K.analysis_meta_key(2024, 5, view)
    assert key == f"meta:analysis:2024:5:{view}"
    assert not fnmatchcase(key, K.race_pattern(2024, 5))
    assert not key.startswith("race:")
    assert key != K.entrants_meta_key(2024, 5)


@pytest.mark.parametrize(
    ("season", "round_", "view"),
    [(1949, 5, "laps"), (2024, 31, "laps"), (2024, 5, "compare"), (2024, 5, ""), (2024, 5, None)],
)
def test_analysis_meta_key_validates_race_and_view(
    season: object, round_: object, view: object
) -> None:
    with pytest.raises(K.InvalidKeyError):
        K.analysis_meta_key(season, round_, view)  # type: ignore[arg-type]


# --------------------------------------------- additive timing hash (display only; Feature 5)
def test_timing_key_is_additive_and_exact() -> None:
    assert K.timing_key(2024, 5, "max_verstappen") == "race:2024:5:timing:max_verstappen"
    assert K.TIMING_FIELDS == (
        "lap",
        "sector1_s",
        "sector2_s",
        "sector3_s",
        "speed_trap_kph",
        "pb_sector1_s",
        "pb_sector2_s",
        "pb_sector3_s",
        "pb_speed_trap_kph",
        "pit_stops",
        "updated_at",
    )
    # the 9-field driver hash and the tyre hash are unchanged
    assert len(K.DRIVER_FIELDS) == 9 and len(K.TYRE_FIELDS) == 4
    assert not set(K.TIMING_FIELDS) - {"updated_at"} & set(K.DRIVER_FIELDS)
    # a race key: the SCAN pattern (TTL, session_end EXPIRE) matches it, other races do not
    assert fnmatchcase(K.timing_key(2024, 5, "a"), K.race_pattern(2024, 5))
    assert not fnmatchcase(K.timing_key(2024, 15, "a"), K.race_pattern(2024, 1))
    # never mistaken for a driver or a tyre hash
    for other in (K.driver_key(2024, 5, "a"), K.tyre_key(2024, 5, "a")):
        assert not K.timing_key(2024, 5, "a").startswith(other[:-1])
    assert "timing" not in K.EVENT_TYPES and len(K.EVENT_TYPES) == 5


@pytest.mark.parametrize("driver_id", ["VER", "max-verstappen", "", "a:b", "x*", None, 44])
def test_timing_key_validates_the_driver_id(driver_id: object) -> None:
    with pytest.raises(K.InvalidKeyError, match="driverId"):
        K.timing_key(2024, 5, driver_id)  # type: ignore[arg-type]


@pytest.mark.parametrize(("season", "round_"), [(1949, 5), (2024, 0), (2024, 31), (True, 5)])
def test_timing_key_validates_the_race(season: object, round_: object) -> None:
    with pytest.raises(K.InvalidKeyError):
        K.timing_key(season, round_, "a")  # type: ignore[arg-type]


def test_claude_md_documents_the_timing_hash_exactly() -> None:
    import re
    from pathlib import Path

    text = (Path(__file__).resolve().parents[2] / "CLAUDE.md").read_text()
    pattern = r"HASH race:\{season\}:\{round\}:timing:\{driverId\} fields: (.*?) \("
    m = re.search(pattern, text, re.S)
    assert m is not None
    fields = tuple(f.strip() for f in " ".join(m.group(1).split()).split(","))
    assert fields == K.TIMING_FIELDS
    assert "ADDITIVE, display only (Feature 5" in text


# ------------------------------------- additive telemetry cache (display only; Feature 6)
def test_telemetry_meta_keys_are_outside_the_race_namespace() -> None:
    laps = K.telemetry_laps_meta_key(2024, 5, "VER")
    trace = K.telemetry_trace_meta_key(2024, 5, "VER", 12)
    assert laps == "meta:telemetry:2024:5:laps:VER"
    assert trace == "meta:telemetry:2024:5:trace:VER:12"
    for key in (laps, trace):
        assert not fnmatchcase(key, K.race_pattern(2024, 5)) and not key.startswith("race:")
        assert not key.startswith(("meta:analysis:", "meta:entrants:"))
    assert K.telemetry_trace_meta_key(2024, 1, "VER", 1) != K.telemetry_trace_meta_key(
        2024, 1, "VER", 10
    )
    # the 9-field driver hash is unchanged
    assert len(K.DRIVER_FIELDS) == 9


@pytest.mark.parametrize(
    ("season", "round_", "code", "lap"),
    [
        (1949, 5, "VER", 1),
        (2024, 31, "VER", 1),
        (2024, 5, "ver", 1),
        (2024, 5, "VE*", 1),
        (2024, 5, None, 1),
        (2024, 5, "VER", 0),
        (2024, 5, "VER", 201),
        (2024, 5, "VER", True),
    ],
)
def test_telemetry_meta_keys_validate(
    season: object, round_: object, code: object, lap: object
) -> None:
    with pytest.raises(K.InvalidKeyError):
        K.telemetry_trace_meta_key(season, round_, code, lap)  # type: ignore[arg-type]
    if type(lap) is int and lap == 1:  # the laps key has no lap; True is not a lap
        with pytest.raises(K.InvalidKeyError):
            K.telemetry_laps_meta_key(season, round_, code)  # type: ignore[arg-type]


def test_claude_md_documents_the_telemetry_cache() -> None:
    from pathlib import Path

    text = " ".join((Path(__file__).resolve().parents[2] / "CLAUDE.md").read_text().split())
    assert "ADDITIVE API cache, display only (Feature 6" in text
    assert "STRING meta:telemetry:{season}:{round}:laps:{CODE}" in text
    assert "meta:telemetry:{season}:{round}:trace:{CODE}:{lap}" in text
    assert "API_TELEMETRY_CACHE_S" in text

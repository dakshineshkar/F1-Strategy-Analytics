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

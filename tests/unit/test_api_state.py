"""``GET /api/races/{season}/{round}/state``: the Redis contract as Pydantic models."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest
from _api_fixtures import make_api, make_settings

from f1sa.api.models import DriverStateOut, TyreLifeOut
from f1sa.serving import keys as K
from f1sa.serving.redis_store import AsyncRaceStore, Batch, DriverState, TyreLife

pytestmark = pytest.mark.anyio

T0 = datetime(2024, 5, 5, 20, 14, 3, 125000, tzinfo=UTC)
LEADER = DriverState(1, None, 0.0, "MEDIUM", 12, 98.5, False, None)
SECOND = DriverState(2, 1.25, 1.25, "HARD", None, 99.0, True, 0.62)
THIRD = DriverState(3, 3.5, 4.75, "UNKNOWN", 3, None, False, None)


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


async def _seed(api: object, season: int = 2024, round_: int = 5) -> None:
    store = AsyncRaceStore(api.redis, api.deps.settings, now=lambda: T0)  # type: ignore[attr-defined]
    await store.write_batch(
        season,
        round_,
        Batch(
            states={"max_verstappen": LEADER, "norris": SECOND, "leclerc": THIRD},
            order={"max_verstappen": 1, "norris": 2, "leclerc": 3},
        ),
    )


def test_state_model_has_exactly_the_contract_fields() -> None:
    assert tuple(DriverStateOut.model_fields) == K.DRIVER_FIELDS


async def test_state_returns_every_hash_and_the_order(tmp_path: Path) -> None:
    api = make_api(make_settings(tmp_path))
    await _seed(api)
    async with api.client() as c:
        resp = await c.get("/api/races/2024/5/state")
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {"season", "round", "drivers", "order", "tyres", "timing"}
    assert body["tyres"] == {}  # no tyre hash written: the optional map is empty
    assert body["timing"] == {}  # no timing hash written: the optional map is empty
    assert (body["season"], body["round"]) == (2024, 5)
    assert sorted(body["drivers"]) == ["leclerc", "max_verstappen", "norris"]
    for d in body["drivers"].values():
        assert tuple(d) == K.DRIVER_FIELDS
    assert body["drivers"]["max_verstappen"] == {
        "position": 1,
        "gap_ahead_s": None,
        "gap_leader_s": 0.0,
        "tyre_compound": "MEDIUM",
        "tyre_age_laps": 12,
        "last_lap_time_s": 98.5,
        "undercut_flag": False,
        "undercut_prob": None,
        "updated_at": "2024-05-05T20:14:03.125Z",
    }
    assert body["drivers"]["norris"]["undercut_flag"] is True
    assert body["drivers"]["norris"]["undercut_prob"] == 0.62
    assert body["drivers"]["norris"]["tyre_age_laps"] is None
    assert body["drivers"]["leclerc"]["last_lap_time_s"] is None
    assert body["order"] == [
        {"driver_id": "max_verstappen", "position": 1},
        {"driver_id": "norris", "position": 2},
        {"driver_id": "leclerc", "position": 3},
    ]


async def test_empty_strings_become_null(tmp_path: Path) -> None:
    api = make_api(make_settings(tmp_path))
    await _seed(api)
    raw = await api.redis.hgetall(K.driver_key(2024, 5, "max_verstappen"))
    assert raw["gap_ahead_s"] == "" and raw["undercut_prob"] == ""
    async with api.client() as c:
        body = (await c.get("/api/races/2024/5/state")).json()
    assert body["drivers"]["max_verstappen"]["gap_ahead_s"] is None
    assert body["drivers"]["max_verstappen"]["undercut_prob"] is None


async def test_404_when_the_race_has_no_keys(tmp_path: Path) -> None:
    api = make_api(make_settings(tmp_path))
    await _seed(api, 2024, 6)
    await _seed(api, 2023, 5)
    async with api.client() as c:
        resp = await c.get("/api/races/2024/5/state")
    assert resp.status_code == 404
    assert resp.json() == {"detail": "no live state for 2024 R5"}


async def test_round_5_never_sees_round_15_or_25_keys(tmp_path: Path) -> None:
    api = make_api(make_settings(tmp_path))
    await _seed(api, 2024, 15)
    await _seed(api, 2024, 25)
    async with api.client() as c:
        assert (await c.get("/api/races/2024/5/state")).status_code == 404
        assert (await c.get("/api/races/2024/15/state")).status_code == 200


async def test_order_only_race(tmp_path: Path) -> None:
    api = make_api(make_settings(tmp_path))
    await api.redis.zadd(K.order_key(2024, 5), {"norris": 1})
    async with api.client() as c:
        body = (await c.get("/api/races/2024/5/state")).json()
    assert body["drivers"] == {} and body["order"] == [{"driver_id": "norris", "position": 1}]


@pytest.mark.parametrize("path", ["1949/5", "2101/5", "2024/0", "2024/31", "abc/5", "2024/x"])
async def test_422_for_bad_path_params(tmp_path: Path, path: str) -> None:
    api = make_api(make_settings(tmp_path))
    async with api.client() as c:
        resp = await c.get(f"/api/races/{path}/state")
    assert resp.status_code == 422


async def test_500_for_a_hash_that_breaks_the_contract(tmp_path: Path) -> None:
    api = make_api(make_settings(tmp_path))
    await _seed(api)
    await api.redis.hset(K.driver_key(2024, 5, "norris"), "undercut_flag", "yes")
    async with api.client() as c:
        resp = await c.get("/api/races/2024/5/state")
    assert resp.status_code == 500
    assert resp.json() == {"detail": "stored driver state breaks the contract"}


async def test_503_when_redis_is_down(tmp_path: Path) -> None:
    api = make_api(make_settings(tmp_path))
    api.server.connected = False
    async with api.client() as c:
        resp = await c.get("/api/races/2024/5/state")
    assert resp.status_code == 503
    assert resp.json() == {"detail": "Redis unavailable"}


# ------------------------------------------------------------- additive tyre hash (display only)
async def test_state_adds_the_optional_tyres_map_next_to_the_contract(tmp_path: Path) -> None:
    api = make_api(make_settings(tmp_path))
    await _seed(api)
    store = AsyncRaceStore(api.redis, api.deps.settings, now=lambda: T0)  # type: ignore[attr-defined]
    await store.write_batch(
        2024,
        5,
        Batch(
            tyres={
                "max_verstappen": TyreLife(lap=30, tyre_life_laps=16, tyre_life_at_start_laps=3),
                "norris": TyreLife(lap=29, tyre_life_laps=None, tyre_life_at_start_laps=None),
            }
        ),
    )
    async with api.client() as c:
        body = (await c.get("/api/races/2024/5/state")).json()
    assert tuple(TyreLifeOut.model_fields) == (
        "lap",
        "tyre_life_laps",
        "tyre_life_at_start_laps",
        "updated_at",
    )
    assert body["tyres"] == {
        "max_verstappen": {
            "lap": 30,
            "tyre_life_laps": 16,
            "tyre_life_at_start_laps": 3,
            "updated_at": "2024-05-05T20:14:03.125Z",
        },
        "norris": {
            "lap": 29,
            "tyre_life_laps": None,
            "tyre_life_at_start_laps": None,
            "updated_at": "2024-05-05T20:14:03.125Z",
        },
    }
    # the driver hashes are untouched: exactly the 9 fields, inferred age as before
    for d in body["drivers"].values():
        assert tuple(d) == K.DRIVER_FIELDS
    assert body["drivers"]["max_verstappen"]["tyre_age_laps"] == 12
    assert sorted(body["drivers"]) == ["leclerc", "max_verstappen", "norris"]  # not a driver


async def test_a_malformed_tyre_hash_is_skipped_never_a_500(tmp_path: Path) -> None:
    api = make_api(make_settings(tmp_path))
    await _seed(api)
    await api.redis.hset(K.tyre_key(2024, 5, "norris"), mapping={"tyre_life_laps": "x"})
    async with api.client() as c:
        resp = await c.get("/api/races/2024/5/state")
    assert resp.status_code == 200
    assert resp.json()["tyres"] == {} and len(resp.json()["drivers"]) == 3


# ----------------------------------------------- additive timing hash (display only; Feature 5)
async def test_state_adds_the_optional_timing_map_next_to_the_contract(tmp_path: Path) -> None:
    from f1sa.api.models import TimingOut
    from f1sa.serving.redis_store import TimingRow

    api = make_api(make_settings(tmp_path))
    await _seed(api)
    store = AsyncRaceStore(api.redis, api.deps.settings, now=lambda: T0)  # type: ignore[attr-defined]
    full = TimingRow(
        lap=30,
        sector1_s=28.512,
        sector2_s=31.25,
        sector3_s=24.003,
        speed_trap_kph=321.4,
        pb_sector1_s=28.1,
        pb_sector2_s=31.25,
        pb_sector3_s=23.9,
        pb_speed_trap_kph=325.0,
        pit_stops=1,
    )
    await store.write_batch(
        2024, 5, Batch(timings={"max_verstappen": full, "norris": TimingRow(lap=29, pit_stops=0)})
    )
    async with api.client() as c:
        body = (await c.get("/api/races/2024/5/state")).json()
    assert tuple(TimingOut.model_fields) == K.TIMING_FIELDS
    assert body["timing"]["max_verstappen"] == {
        "lap": 30,
        "sector1_s": 28.512,
        "sector2_s": 31.25,
        "sector3_s": 24.003,
        "speed_trap_kph": 321.4,
        "pb_sector1_s": 28.1,
        "pb_sector2_s": 31.25,
        "pb_sector3_s": 23.9,
        "pb_speed_trap_kph": 325.0,
        "pit_stops": 1,
        "updated_at": "2024-05-05T20:14:03.125Z",
    }
    norris = body["timing"]["norris"]
    assert norris["pit_stops"] == 0 and norris["sector1_s"] is None and norris["lap"] == 29
    for d in body["drivers"].values():
        assert tuple(d) == K.DRIVER_FIELDS  # the 9-field hash is untouched
    assert sorted(body["drivers"]) == ["leclerc", "max_verstappen", "norris"]
    assert body["tyres"] == {}


async def test_a_malformed_timing_hash_is_skipped_never_a_500(tmp_path: Path) -> None:
    api = make_api(make_settings(tmp_path))
    await _seed(api)
    await api.redis.hset(K.timing_key(2024, 5, "norris"), mapping={"lap": "x"})
    async with api.client() as c:
        resp = await c.get("/api/races/2024/5/state")
    assert resp.status_code == 200
    assert resp.json()["timing"] == {} and len(resp.json()["drivers"]) == 3

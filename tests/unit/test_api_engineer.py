"""``GET /api/races/{s}/{r}/engineer/{driverId}?lap=N`` (Feature 3): 200 shape, no hindsight,
read only, 404 / 409 / 422 / 503 and the 2025 seal. Invented rows only (no F1 data)."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest
from _api_fixtures import DEFAULT_RACES, ApiHarness, make_api, make_settings, write_file_lake
from _sim_fixtures import DictReader, RaceSpec, lake_readers

from f1sa.api.catalog import CatalogError, SimReaders
from f1sa.serving.redis_store import AsyncRaceStore, Batch, DriverState, Event

pytestmark = pytest.mark.anyio
URL = "/api/races/2024/5/engineer"
OFFSETS = {"drv0": 0.0, "drv1": 2.0, "drv2": 8.0, "drv3": 40.0}
HISTORY = {
    # (season, round): circuit; analysis_stints of the earlier races (a later one must be ignored)
    "races": {
        (2024, 3): [{"circuit_id": "spa"}],
        (2024, 4): [{"circuit_id": "monza"}],
        (2024, 5): [{"circuit_id": "spa"}],
        (2024, 7): [{"circuit_id": "spa"}],
    },
    "analysis_stints": {
        (2024, 3): [
            {"compound": "MEDIUM", "laps": 18, "ends_in_pit": True, "is_synthetic": False},
            {"compound": "MEDIUM", "laps": 22, "ends_in_pit": True, "is_synthetic": False},
            {"compound": "MEDIUM", "laps": 40, "ends_in_pit": False, "is_synthetic": False},
        ],
        (2024, 4): [{"compound": "HARD", "laps": 30, "ends_in_pit": True, "is_synthetic": False}],
        (2024, 7): [{"compound": "MEDIUM", "laps": 2, "ends_in_pit": True, "is_synthetic": False}],
    },
}


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def _api(tmp_path: Path, **settings: Any) -> ApiHarness:
    write_file_lake(tmp_path / "lake", DEFAULT_RACES)
    clean, features = lake_readers([RaceSpec(2024, 5, drivers=4)])
    return make_api(
        make_settings(tmp_path, **settings),
        sim_reader_factory=lambda: SimReaders(clean, features),
        engineer_reader_factory=lambda: DictReader(HISTORY),
    )


def _ds(pos: int, prob: float | None) -> DriverState:
    return DriverState(pos, None, None, "MEDIUM", 15, 90.0, prob is not None, prob)


async def _seed(api: ApiHarness, probs: dict[str, float | None]) -> None:
    store = AsyncRaceStore(api.redis, api.deps.settings)
    states = {d: _ds(i + 1, probs.get(d)) for i, d in enumerate(OFFSETS)}
    await store.write_batch(
        2024, 5, Batch(states=states, order={d: s.position for d, s in states.items()})
    )


async def _laps(api: ApiHarness, first: int, last: int) -> None:
    store = AsyncRaceStore(api.redis, api.deps.settings)
    events = []
    for lap in range(first, last + 1):
        for i, (d, off) in enumerate(OFFSETS.items()):
            pace = 89.8 if d == "drv2" else 90.0  # drv2 closes on drv1 by 0.2 s a lap
            events.append(
                Event(
                    "lap",
                    {
                        "driver_id": d,
                        "lap": lap,
                        "race_time_s": round(off + pace * lap, 3),
                        "lap_time_s": pace,
                        "position": i + 1,
                        "compound": "MEDIUM",
                        "tyre_age": lap,
                        "tyre_life_laps": lap + 1,
                        "tyre_life_at_start_laps": 1,
                    },
                )
            )
    await store.write_batch(2024, 5, Batch(events=events))
    log = api.deps.lap_logs.get(2024, 5)
    assert log is not None

    async def wait() -> None:
        while log.latest_lap("drv3") != last:
            await asyncio.sleep(0.02)

    await asyncio.wait_for(wait(), 5)


async def _snapshot(api: ApiHarness) -> dict[str, Any]:
    keys = sorted(await api.redis.keys("*"))
    return {k: (await api.redis.type(k), await api.redis.ttl(k)) for k in keys}


async def test_200_cards_pairs_rejoin_and_calls(tmp_path: Path) -> None:
    api = _api(tmp_path)
    await _seed(api, {"drv1": 0.22, "drv2": 0.61})
    async with api.client() as c:
        await api.deps.lap_logs.ensure(2024, 5)
        await _laps(api, 1, 8)
        r = await c.get(f"{URL}/drv1")
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["lap"], body["current_lap"], body["history_from_lap"]) == (8, 8, 1)
    assert [body[k]["driver_id"] for k in ("ahead", "focus", "behind")] == ["drv0", "drv1", "drv2"]
    assert body["pair_behind"]["gap_s"] == pytest.approx(8.0 - 2.0 - 0.2 * 8)
    assert body["pair_behind"]["trend_s_per_lap"] == pytest.approx(-0.2)
    assert body["pair_behind"]["prob"] == 0.61 and body["pair_ahead"]["prob"] == 0.22
    assert body["rejoin"]["pit_loss_s"] == 21.5
    assert body["rejoin"]["pit_loss_text"] == "circuit prior from earlier races"
    assert body["rejoin"]["position"] == 3 and body["rejoin"]["ahead_id"] == "drv2"
    assert body["rejoin"]["behind_id"] == "drv3" and body["rejoin"]["in_traffic"] is False
    stint = body["focus"]["typical_stint"]
    assert (stint["median_laps"], stint["source"], stint["n_races"]) == (20.0, "circuit", 1)
    assert body["focus"]["tyre_life_laps"] == 9 and body["focus"]["tyre_life_source"] == "real"
    assert [x["id"] for x in body["calls"]] == ["threat", "being_caught", "rejoin"]
    assert body["neutralised"]["source"] == "estimated"
    assert body["disclaimer"].endswith("not model output.")


async def test_no_hindsight_lap_n_is_unchanged_when_later_laps_exist(tmp_path: Path) -> None:
    api = _api(tmp_path)
    await _seed(api, {"drv1": 0.22, "drv2": 0.61})
    async with api.client() as c:
        await api.deps.lap_logs.ensure(2024, 5)
        await _laps(api, 1, 10)
        before = (await c.get(f"{URL}/drv1", params={"lap": 10})).json()
        await _laps(api, 11, 25)
        await _seed(api, {"drv1": 0.99, "drv2": 0.01})  # later probabilities change in Redis
        after = (await c.get(f"{URL}/drv1", params={"lap": 10})).json()
        now = (await c.get(f"{URL}/drv1")).json()
    before.pop("current_lap")
    assert after.pop("current_lap") == 25
    assert after == before
    assert now["lap"] == 25 and now["pair_behind"]["prob"] == 0.01


async def test_probabilities_are_recorded_per_leader_lap(tmp_path: Path) -> None:
    api = _api(tmp_path)
    await _seed(api, {"drv1": 0.3, "drv2": 0.7})
    async with api.client() as c:
        await api.deps.lap_logs.ensure(2024, 5)
        await _laps(api, 1, 4)
        await _seed(api, {"drv1": 0.1, "drv2": 0.2})
        await _laps(api, 5, 6)
        lap4 = (await c.get(f"{URL}/drv1", params={"lap": 4})).json()
    assert lap4["pair_behind"]["prob"] == 0.7 and lap4["pair_behind"]["prob_recorded"] is True


async def test_read_only_no_key_is_written_or_touched(tmp_path: Path) -> None:
    api = _api(tmp_path)
    await _seed(api, {"drv2": 0.61})
    async with api.client() as c:
        await api.deps.lap_logs.ensure(2024, 5)
        await _laps(api, 1, 6)
        before = await _snapshot(api)
        assert (await c.get(f"{URL}/drv1")).status_code == 200
        after = await _snapshot(api)
    assert after == before


async def test_errors(tmp_path: Path) -> None:
    api = _api(tmp_path)
    async with api.client() as c:
        no_state = await c.get(f"{URL}/drv1")
        await _seed(api, {})
        no_laps = await c.get(f"{URL}/drv1")
        await api.deps.lap_logs.ensure(2024, 5)
        await _laps(api, 1, 5)
        unknown = await c.get(f"{URL}/zulu")
        too_late = await c.get(f"{URL}/drv1", params={"lap": 9})
        bad_lap = await c.get(f"{URL}/drv1", params={"lap": 0})
        bad_id = await c.get(f"{URL}/DRV1")
        not_lake = await c.get("/api/races/2024/9/engineer/drv1")
    assert no_state.status_code == 404 and no_state.json() == {
        "detail": "no live state for 2024 R5"
    }
    assert no_laps.status_code == 409
    assert unknown.status_code == 404
    assert too_late.status_code == 409 and "laps 1-5" in too_late.json()["detail"]
    assert bad_lap.status_code == 422 and bad_id.status_code == 422
    assert not_lake.status_code == 404


async def test_2025_is_sealed(tmp_path: Path) -> None:
    api = _api(tmp_path)
    async with api.client() as c:
        r = await c.get("/api/races/2025/6/engineer/drv1")
    assert r.status_code == 404


async def test_lake_down_is_503(tmp_path: Path) -> None:
    api = _api(tmp_path)

    class Down(DictReader):
        def partitions(self, table: str, *, required: bool = True) -> list[tuple[int, int]]:
            raise CatalogError("down")

    api.deps.engineer.history.reader_factory = lambda: Down({})
    await _seed(api, {})
    async with api.client() as c:
        await api.deps.lap_logs.ensure(2024, 5)
        await _laps(api, 1, 3)
        r = await c.get(f"{URL}/drv1")
    assert r.status_code == 503 and r.json() == {"detail": "clean zone unavailable"}


async def test_redis_down_is_503(tmp_path: Path) -> None:
    api = _api(tmp_path)
    api.server.connected = False
    async with api.client() as c:
        r = await c.get(f"{URL}/drv1")
    assert r.status_code == 503

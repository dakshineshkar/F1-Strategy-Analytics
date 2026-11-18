"""The race-status banner (Feature 5): ``api.race_status.race_status`` (pure) and
``GET /api/races/{s}/{r}/status?lap=N`` (200, no hindsight, read only, 404 / 409 / 422 / 503 and
the 2025 seal). Invented rows only (no F1 data)."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from _api_fixtures import ApiHarness
from test_api_engineer import _api, _laps, _seed, _snapshot
from test_engineer import _laps_doc, _rc_doc, race

from f1sa.api import engineer as E
from f1sa.api.catalog import CatalogError
from f1sa.api.race_status import race_status

URL = "/api/races/2024/5/status"


# ------------------------------------------------------------------ pure
def test_lake_path_uses_the_leader_codes_of_lap_n_and_messages_up_to_n() -> None:
    doc = _laps_doc(sc_lap=3)
    rc = _rc_doc(doc.coverage)
    at3 = race_status(2024, 5, 3, race(10), doc, rc)
    assert (at3.status, at3.source, at3.message, at3.message_lap) == (
        "sc",
        "track_status",
        "SAFETY CAR DEPLOYED",
        3,
    )
    at5 = race_status(2024, 5, 5, race(10), doc, rc)
    assert at5.status == "green" and at5.message == "SAFETY CAR DEPLOYED"  # lap 9 not seen yet
    at9 = race_status(2024, 5, 9, race(10), doc, rc)
    assert (at9.message, at9.message_lap) == ("SAFETY CAR IN THIS LAP", 9)
    assert (at3.season, at3.round, at3.lap) == (2024, 5, 3)


def test_the_banner_equals_the_engineer_view_track_status() -> None:
    doc = _laps_doc(sc_lap=4)
    rc = _rc_doc(doc.coverage)
    for lap in range(1, 11):
        got = race_status(2024, 5, lap, race(10), doc, rc)
        want, _ = E.neutral_at(E.by_driver(race(10), lap), lap, doc, rc)
        assert got.model_dump(exclude={"season", "round", "lap"}) == want.model_dump()


def test_estimate_without_race_control_and_its_transitions() -> None:
    rows = race(10)
    slow = {6, 7}  # a neutralised phase: every car laps 30 % slower
    sc = [replace(r, lap_time_s=117.0) if r.lap in slow else r for r in rows]
    no_rc = _laps_doc(3, n_rc=0)
    got = [race_status(2024, 5, n, sc, no_rc, None).status for n in range(1, 11)]
    assert got[:2] == ["unknown", "unknown"]  # no earlier green baseline yet
    assert got[2:5] == ["green"] * 3
    assert got[5:7] == ["neutralised"] * 2
    assert got[7:] == ["green"] * 3
    first = race_status(2024, 5, 1, sc, None, None)
    assert (first.source, first.message, first.message_lap) == ("none", None, None)
    assert race_status(2024, 5, 6, sc, None, None).source == "estimated"


def test_no_hindsight_lap_n_is_unchanged_when_later_laps_exist() -> None:
    rows = race(10)
    future = [replace(r, lap_time_s=(r.lap_time_s or 90.0) * 100) if r.lap > 5 else r for r in rows]
    for n in range(1, 6):
        assert race_status(2024, 5, n, rows, None, None) == race_status(
            2024, 5, n, future, None, None
        )
        assert race_status(2024, 5, n, rows, None, None) == race_status(
            2024, 5, n, [r for r in rows if r.lap <= n], None, None
        )


def test_lap_must_be_positive() -> None:
    with pytest.raises(ValueError, match="lap"):
        race_status(2024, 5, 0, race(3), None, None)


# ------------------------------------------------------------------ route
pytestmark_route = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytestmark_route
async def test_route_200_default_lap_and_explicit_lap(tmp_path: Path) -> None:
    api = _api(tmp_path)
    await _seed(api, {})
    async with api.client() as c:
        await api.deps.lap_logs.ensure(2024, 5)
        await _laps(api, 1, 6)
        latest = await c.get(URL)
        lap3 = await c.get(URL, params={"lap": 3})
    assert latest.status_code == 200 and lap3.status_code == 200
    body = latest.json()
    assert tuple(body) == (
        "season",
        "round",
        "lap",
        "status",
        "source",
        "message",
        "message_lap",
    )
    assert (body["lap"], body["status"], body["source"]) == (6, "green", "estimated")
    assert lap3.json()["lap"] == 3


@pytestmark_route
async def test_route_refuses_laps_not_reached_and_is_read_only(tmp_path: Path) -> None:
    api = _api(tmp_path)
    await _seed(api, {})
    async with api.client() as c:
        await api.deps.lap_logs.ensure(2024, 5)
        await _laps(api, 1, 4)
        before = await _snapshot(api)
        ahead = await c.get(URL, params={"lap": 5})
        ok = await c.get(URL, params={"lap": 4})
        after = await _snapshot(api)
    assert ahead.status_code == 409 and "not reached yet" in ahead.json()["detail"]
    assert ok.status_code == 200
    assert after == before  # nothing written or touched


@pytestmark_route
async def test_route_errors(tmp_path: Path) -> None:
    api = _api(tmp_path)
    async with api.client() as c:
        no_state = await c.get(URL)
        await _seed(api, {})
        no_laps = await c.get(URL)
        bad_lap = await c.get(URL, params={"lap": 0})
        not_lake = await c.get("/api/races/2024/9/status")
        sealed = await c.get("/api/races/2025/6/status")
    assert no_state.status_code == 404 and no_state.json() == {
        "detail": "no live state for 2024 R5"
    }
    assert no_laps.status_code == 409
    assert bad_lap.status_code == 422
    assert not_lake.status_code == 404 and sealed.status_code == 404


@pytestmark_route
async def test_route_lake_down_is_503(tmp_path: Path) -> None:
    api: ApiHarness = _api(tmp_path)
    await _seed(api, {})

    async def down(*_a: Any, **_k: Any) -> Any:
        raise CatalogError("down")

    async with api.client() as c:
        await api.deps.lap_logs.ensure(2024, 5)
        await _laps(api, 1, 3)
        api.deps.analysis.get = down  # type: ignore[method-assign]
        r = await c.get(URL)
    assert r.status_code == 503 and r.json() == {"detail": "clean zone unavailable"}


@pytestmark_route
async def test_route_redis_down_is_503(tmp_path: Path) -> None:
    api = _api(tmp_path)
    api.server.connected = False
    async with api.client() as c:
        r = await c.get(URL)
    assert r.status_code == 503

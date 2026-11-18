"""``archive.memory_redis``: the in-process stand-in behaves like Redis for every command the
real ``RaceStore`` and the API's ``read_race_state`` send (checked against fakeredis)."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any, cast

import fakeredis
import pytest

from f1sa.api.state import driver_ids_from_keys, read_race_state, scan_race_keys
from f1sa.archive.memory_redis import MemoryRedis
from f1sa.config import Settings
from f1sa.serving import keys as K
from f1sa.serving.redis_store import Batch, DriverState, Event, RaceStore, TyreLife

NOW = datetime(2024, 5, 5, 20, 0, 0, 125_000, tzinfo=UTC)


def _settings() -> Settings:
    return Settings(_env_file=None)  # type: ignore[call-arg]


def _batches() -> list[Batch]:
    a = DriverState(1, None, 0.0, "SOFT", 3, 92.5, False, None)
    b = DriverState(2, 1.25, 1.25, "MEDIUM", 7, 93.1, True, 0.61)
    c = DriverState(3, 0.4, 1.65, "UNKNOWN", None, None, False, None)
    return [
        Batch(
            states={"max_verstappen": a, "lando_norris": b},
            order={"max_verstappen": 1, "lando_norris": 2},
            tyres={"max_verstappen": TyreLife(5, 8, 3)},
            events=(Event("lap", {"driver_id": "max_verstappen", "lap": 5}, NOW),),
        ),
        Batch(
            states={"lando_norris": b, "oscar_piastri": c},
            order={"max_verstappen": 2, "lando_norris": 1, "oscar_piastri": 3},
            tyres={"lando_norris": TyreLife(6, None, None)},
            events=(Event("undercut_alert", {"attacker_id": "x"}), Event("lap", {"lap": 6})),
        ),
    ]


def _apply(client: Any) -> RaceStore:
    store = RaceStore(cast(Any, client), _settings(), now=lambda: NOW)
    for b in _batches():
        store.write_batch(2024, 5, b)
    store.end_session(2024, 5)
    return store


def test_same_hashes_order_ttls_and_published_messages_as_fakeredis() -> None:
    fake = fakeredis.FakeRedis(decode_responses=True)
    pubsub = fake.pubsub()
    pubsub.subscribe(K.events_channel(2024, 5))
    pubsub.get_message(timeout=1)  # the subscribe confirmation
    memory = MemoryRedis()
    _apply(fake)
    _apply(memory)
    keys = sorted(str(k) for k in fake.keys("*"))
    assert keys == memory.keys_list()
    for k in keys:
        if fake.type(k) == "hash":
            assert fake.hgetall(k) == memory.hgetall(k)
        else:
            assert fake.zrange(k, 0, -1, withscores=True) == memory.zrange(
                k, 0, -1, withscores=True
            )
        assert 0 < int(fake.ttl(k)) <= memory.ttls[k]
    live = []
    while (m := pubsub.get_message(timeout=0.2)) is not None:
        live.append((m["channel"], m["data"]))
    assert live == memory.published
    assert [m for _, m in memory.published if '"session_end"' in m]


def test_the_api_reader_sees_the_same_state_as_on_fakeredis() -> None:
    server = fakeredis.FakeServer()
    _apply(fakeredis.FakeRedis(server=server, decode_responses=True))
    memory = MemoryRedis()
    _apply(memory)

    async def read(client: Any) -> Any:
        ids = driver_ids_from_keys(await scan_race_keys(client, 2024, 5), 2024, 5)
        return await read_race_state(client, 2024, 5, ids)

    want = asyncio.run(read(fakeredis.FakeAsyncRedis(server=server, decode_responses=True)))
    got = asyncio.run(read(memory.async_view()))
    assert got == want
    assert [o.driver_id for o in got.order] == ["lando_norris", "max_verstappen", "oscar_piastri"]
    assert got.drivers["lando_norris"].undercut_prob == 0.61


def test_redis_semantics_of_the_supported_commands() -> None:
    m = MemoryRedis()
    assert m.expire("missing", 5) is False and "missing" not in m.ttls
    assert m.hset("h", mapping={"a": 1, "b": "x"}) == 2
    assert m.hset("h", mapping={"a": 2}) == 0 and m.hgetall("h") == {"a": "2", "b": "x"}
    m.zadd("z", {"b": 1, "a": 1, "c": 0})
    assert m.zrange("z", 0, -1) == ["c", "a", "b"]  # score, then member
    assert m.zrange("z", -2, -1, withscores=True) == [("a", 1.0), ("b", 1.0)]
    assert m.zrange("empty", 0, -1) == []
    assert m.scan(0, match="h*") == (0, ["h"]) and m.exists("h", "z", "nope") == 2
    with pytest.raises(TypeError, match="WRONGTYPE"):
        m.zadd("h", {"x": 1})
    with pytest.raises(TypeError, match="WRONGTYPE"):
        m.hset("z", mapping={"x": 1})
    with pytest.raises(ValueError):
        m.hset("h2", mapping={})


def test_pipelines_apply_in_order_and_refuse_anything_else() -> None:
    m = MemoryRedis()
    pipe = m.pipeline(transaction=False)
    pipe.hset("k", mapping={"f": "1"})
    pipe.expire("k", 30)
    pipe.publish("c", "msg")
    assert m.hashes == {} and m.published == []  # nothing before execute
    assert pipe.execute() == [1, True, 0]
    assert m.ttls == {"k": 30} and m.published == [("c", "msg")]
    with pytest.raises(AttributeError, match="delete"):
        pipe.delete("k")
    with pytest.raises(AttributeError):
        m.delete("k")  # type: ignore[attr-defined]
    with pytest.raises(ValueError, match="transaction"):
        m.pipeline(transaction=True)
    with pytest.raises(ValueError, match="transaction"):
        m.async_view().pipeline(transaction=True)

"""Shared helpers for the archive tests: a scenario race replayed into a bundle (no Spark), and
an independent replay through the real ``RaceStore`` on fakeredis, read with the API's
``read_race_state`` at every lap boundary (what a live replay leaves in Redis)."""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from typing import Any

import fakeredis
from _stream_fixtures import scenario_inputs, scorer
from _undercut_fixtures import Scenario, standard_cars

from f1sa.api.models import RaceStateOut
from f1sa.api.state import driver_ids_from_keys, read_race_state, scan_race_keys
from f1sa.archive.build import status_laps
from f1sa.archive.replay import (
    N_PARTITIONS,
    RaceReplay,
    deterministic_events,
    lap_batches,
    replay_race,
)
from f1sa.archive.schema import SCHEMA_VERSION, ArchiveBundle, BuilderInfo, BundleMeta, ModelInfo
from f1sa.config import Settings
from f1sa.features.undercut_rule import RuleParams
from f1sa.model.lr_scorer import LRScorer
from f1sa.serving.redis_store import RaceStore
from f1sa.streaming.live_features import RacePriors
from f1sa.streaming.parity import kafka_batches
from f1sa.streaming.processor import StreamProcessor
from f1sa.streaming.producer import Outgoing, RaceInputs, build_events
from f1sa.streaming.redis_sink import RedisSink

START_MS = 1_714_939_200_000  # 2024-05-05T20:00:00Z
SCENARIO = Scenario(2023, 1, standard_cars())
SCENARIO_LAPPED = Scenario(2023, 2, standard_cars(d_pit_laps=[12]), neutral_laps={7})


def settings() -> Settings:
    return Settings(_env_file=None)  # type: ignore[call-arg]


def priors_for(inputs: RaceInputs) -> RacePriors:
    return RacePriors(inputs.season, inputs.round, 20.0, "global_prior", {}, {})


def scenario_replay(sc: Scenario = SCENARIO) -> tuple[RaceInputs, RacePriors, RaceReplay]:
    inputs = scenario_inputs(sc)
    priors = priors_for(inputs)
    rep = replay_race(
        inputs, priors, scorer(), RuleParams(), start_ms=START_MS, settings=settings()
    )
    return inputs, priors, rep


MODEL = ModelInfo(
    version="deploy_test",
    scorer_sha256="b" * 64,
    feature_set="real",
    g=3.5,
    k=2,
    git_sha=None,
    git_dirty=None,
    created_utc=None,
)


def bundle_of(rep: RaceReplay, **meta: Any) -> ArchiveBundle:
    base: dict[str, Any] = {
        "season": rep.season,
        "round": rep.round,
        "race_name": "Scenario Grand Prix",
        "circuit_name": None,
        "race_date": "2024-05-05",
        "race_start_utc": "2024-05-05T20:00:00Z",
        "laps": rep.snapshots[-1].lap,
        "synthetic": True,
        "source": "sample",
        "n_partitions": N_PARTITIONS,
        "model": MODEL,
        "builder": BuilderInfo(git_sha="c" * 40, git_dirty=False),
    }
    base.update(meta)
    return ArchiveBundle(
        schema_version=SCHEMA_VERSION,
        meta=BundleMeta(**base),
        entrants=[],
        snapshots=rep.snapshots,
        messages=rep.messages,
        decisions=rep.decisions,
        track=[],
        race_control=[],
        status=status_laps(
            rep.season, rep.round, rep.messages, [x.lap for x in rep.snapshots], None, None
        ),
    )


def live_like_states(
    inputs: RaceInputs,
    priors: RacePriors,
    lr: LRScorer,
    params: RuleParams,
    *,
    events: Sequence[Outgoing] | None = None,
    n_partitions: int = N_PARTITIONS,
) -> dict[int, RaceStateOut]:
    """An independent replay: one Kafka row per micro-batch through ``StreamProcessor`` and the
    real ``RaceStore`` on fakeredis, with Redis read by ``read_race_state`` after the last event
    of each leader lap (the end of that lap)."""
    evs = (
        list(events)
        if events is not None
        else deterministic_events(build_events(inputs, n_partitions), START_MS)
    )
    server = fakeredis.FakeServer()
    store = RaceStore(fakeredis.FakeRedis(server=server, decode_responses=True), settings())
    proc = StreamProcessor(
        scorer=lr,
        params=params,
        sink=RedisSink(store),
        priors_loader=lambda _s, _r: priors,
        n_partitions=n_partitions,
        keep_decisions=True,
    )
    ends: dict[int, int] = {}
    i = -1
    for b in lap_batches(evs, n_partitions):
        i += len(b.events)
        ends[i] = b.lap
    reader = fakeredis.FakeAsyncRedis(server=server, decode_responses=True)
    s, r = inputs.season, inputs.round

    async def read() -> RaceStateOut:
        ids = driver_ids_from_keys(await scan_race_keys(reader, s, r), s, r)
        return await read_race_state(reader, s, r, ids)

    out: dict[int, RaceStateOut] = {}
    for idx, rows in enumerate(kafka_batches(evs, n_partitions, 1)):
        proc.process_rows(rows, idx)
        if idx in ends:
            out[ends[idx]] = asyncio.run(read())
    assert proc.ended(s, r)
    return out

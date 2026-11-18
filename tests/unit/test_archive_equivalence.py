"""Proof of equivalence on the real sample lake (Feature 4).

* With the deployed model (skipped when ``models/`` lacks it, as in the parity suite): the stored
  2024 R5 bundle carries the committed alert check, 113 ``new_candidate`` / 19
  ``probability_crossed`` / 9 ``pit_in`` (141), over 409 eligible decisions, the labelled attempt
  (hulkenberg on bottas, decision lap 7) among the attempts; ``equivalence.run`` (rebuild, parity
  harness, ``check_alerts``, ``compare_race``) passes.
* With any model: every lap snapshot of both sample races equals what an independent
  batch-size-1 replay through the real ``RaceStore`` on fakeredis leaves in Redis at the end of
  that lap (read by the API's ``read_race_state``); the parity comparison catches a tampered alert.
* The refusals of the CLI and the live check's guard.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from _archive_fixtures import live_like_states
from _stream_fixtures import scenario_doc_dir
from pyspark.sql import SparkSession

from f1sa.archive import build as B
from f1sa.archive import equivalence as EQ
from f1sa.archive.schema import ArchiveBundle
from f1sa.config import Settings
from f1sa.streaming.priors import load_priors
from f1sa.streaming.producer import build_events, load_race_inputs
from f1sa.streaming.stream_job import load_model

REPO_ROOT = Path(__file__).resolve().parents[2]
DEPLOY_DIR = REPO_ROOT / "models" / "undercut" / "deploy_real_G3.5_k2"
RACES = [(2023, 5), (2024, 5)]


@contextmanager
def _cwd(path: Path) -> Iterator[None]:
    old = os.getcwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(old)


@dataclass
class Lake:
    base: Path
    settings: Settings
    model_dir: Path
    bundles: dict[tuple[int, int], ArchiveBundle]


def _lake(
    spark: SparkSession, src: Any, base: Path, model_dir: Path, races: list[tuple[int, int]]
) -> Lake:
    shutil.copytree(src.lake, base / "data" / "lake")
    settings = Settings(_env_file=None, data_lake_uri=f"file://{base}/data/lake")  # type: ignore[call-arg]
    out = {}
    with _cwd(base):
        for s, r in races:
            bundle = B.build_bundle(spark, settings, s, r, model_dir=model_dir, source="sample")
            B.write_bundle(settings, bundle)
            out[(s, r)] = bundle
    return Lake(base, settings, model_dir, out)


@pytest.fixture(scope="module")
def any_model(
    spark: SparkSession, sample_archive_lake: Any, tmp_path_factory: pytest.TempPathFactory
) -> Lake:
    base = tmp_path_factory.mktemp("eq_any")
    return _lake(spark, sample_archive_lake, base, scenario_doc_dir(base / "model"), RACES)


@pytest.fixture(scope="module")
def deployed(
    spark: SparkSession, sample_archive_lake: Any, tmp_path_factory: pytest.TempPathFactory
) -> Lake:
    if not (DEPLOY_DIR / "lr" / "scorer.json").is_file():
        pytest.skip("deployment model not saved (make model-save-full); it is gitignored")
    return _lake(
        spark, sample_archive_lake, tmp_path_factory.mktemp("eq_deploy"), DEPLOY_DIR, [(2024, 5)]
    )


def _args(lake: Lake, **kw: Any) -> argparse.Namespace:
    base = {
        "season": 2024,
        "round": 5,
        "laps": (5, 22, 45),
        "model_dir": lake.model_dir,
        "api": "http://127.0.0.1:1",
        "skip_live": True,
        "allow_test_season": False,
        "timeout_s": 60.0,
        "master": "local[2]",
    }
    base.update(kw)
    return argparse.Namespace(**base)


# ------------------------------------------------------------------ the committed alert check
def test_the_stored_bundle_carries_the_committed_alert_check(deployed: Lake) -> None:
    bundle = deployed.bundles[(2024, 5)]
    assert EQ.trigger_counts(EQ.alert_payloads(bundle)) == {
        "new_candidate": 113,
        "probability_crossed": 19,
        "pit_in": 9,
    }
    assert len(bundle.decisions) == 409
    attempts = {
        (a["attacker_id"], a["defender_id"], a["decision_lap"])
        for a in EQ.alert_payloads(bundle)
        if a["reason"] == "attempt"
    }
    assert ("hulkenberg", "bottas", 7) in attempts


def test_run_without_live_passes_rebuild_parity_and_batch_checks(
    spark: SparkSession, deployed: Lake
) -> None:
    with _cwd(deployed.base):
        report = EQ.run(
            _args(deployed), deployed.settings, spark_factory=lambda _m: spark, out=lambda _m: None
        )
    assert report["ok"] is True and report["problems"] == []
    assert report["alerts_by_trigger"] == {
        "new_candidate": 113,
        "probability_crossed": 19,
        "pit_in": 9,
    }
    assert report["alerts"] == 141 and report["decisions"] == 409
    assert report["batch_eligible_pairs"] == report["stream_eligible_pairs"] == 409
    assert report["labelled_attempts"] == 1


def test_every_lap_of_r5_equals_redis_with_the_deployed_model(
    spark: SparkSession, deployed: Lake
) -> None:
    _every_lap_equals_redis(spark, deployed, 2024, 5)


# ------------------------------------------------------------------ any model
def _every_lap_equals_redis(spark: SparkSession, lake: Lake, s: int, r: int) -> None:
    bundle = lake.bundles[(s, r)]
    uri = lake.settings.data_lake_uri
    scorer, params, _ = load_model(lake.model_dir)
    live = live_like_states(
        load_race_inputs(spark, uri, s, r), load_priors(spark, uri, s, r), scorer, params
    )
    assert sorted(live) == [x.lap for x in bundle.snapshots]
    for snap in bundle.snapshots:
        assert EQ.state_diff(snap, live[snap.lap]) == [], snap.lap
    assert len(bundle.snapshots[-1].drivers) == 20


@pytest.mark.parametrize("race", RACES, ids=lambda x: f"{x[0]}R{x[1]}")
def test_every_lap_equals_redis_after_a_live_like_replay(
    spark: SparkSession, any_model: Lake, race: tuple[int, int]
) -> None:
    _every_lap_equals_redis(spark, any_model, *race)


def test_the_parity_comparison_catches_a_changed_alert(
    spark: SparkSession, any_model: Lake
) -> None:
    s, r = 2024, 5
    bundle = any_model.bundles[(s, r)]
    uri = any_model.settings.data_lake_uri
    scorer, params, _ = load_model(any_model.model_dir)
    inputs, priors = load_race_inputs(spark, uri, s, r), load_priors(spark, uri, s, r)
    proc = EQ.parity_processor(inputs, priors, scorer, params)
    assert EQ.parity_problems(bundle, proc) == []
    doc = bundle.model_dump(mode="json")
    alert = next(m for m in doc["messages"] if m["message"]["type"] == "undercut_alert")
    alert["message"]["payload"]["undercut_prob"] = 0.123456
    assert EQ.parity_problems(ArchiveBundle.model_validate(doc), proc) == [
        "alerts differ: 1 only in the bundle, 1 only in the parity run"
    ]
    groups = EQ.lap_groups(build_events(inputs, 3), 3)
    assert [g[0] for g in groups] == [x.lap for x in bundle.snapshots]


def test_cli_refusals(spark: SparkSession, any_model: Lake) -> None:
    def run(**kw: Any) -> dict[str, Any]:
        with _cwd(any_model.base):
            return EQ.run(
                _args(any_model, **kw),
                any_model.settings,
                spark_factory=lambda _m: spark,
                out=lambda _m: None,
            )

    for kw, match in (
        ({"season": 2025}, "sealed"),
        ({"laps": (5, 22)}, "at least 3"),
        ({"laps": (5, 22, 99)}, "not snapshot laps"),
        ({"round": 9}, "no stored bundle"),
        ({"model_dir": any_model.base / "nope"}, "missing"),
    ):
        with pytest.raises(EQ.Refused, match=match):
            run(**kw)
    other = scenario_doc_dir(any_model.base / "other_model", g=3.5)
    (other / "lr" / "scorer.json").write_text(
        json.dumps({**json.loads((other / "lr" / "scorer.json").read_text()), "intercept": 1.0})
    )
    with pytest.raises(EQ.Refused, match="built with scorer"):
        run(model_dir=other)
    with pytest.raises(SystemExit) as exc:
        EQ.main(["--season", "2024", "--round", "5", "--laps", "0,1"])
    assert exc.value.code == 2


def test_parse_laps() -> None:
    assert EQ.parse_laps("45, 5,22,5") == (5, 22, 45)
    for bad in ("", "0,1,2"):
        with pytest.raises(argparse.ArgumentTypeError):
            EQ.parse_laps(bad)


# ------------------------------------------------------------------ live-check guard and helpers
def test_live_check_refuses_while_a_replay_runs(monkeypatch: pytest.MonkeyPatch) -> None:
    from f1sa import replay_guard as G

    running = json.dumps(
        {"running": [{"run_id": "r1", "season": 2024, "round": 5, "state": "running"}]}
    ).encode()
    monkeypatch.setattr(G, "http_get", lambda _u, _t: running)
    with pytest.raises(EQ.Refused, match="a replay is running"):
        EQ.check_no_running_replay("http://api:8000", lambda _m: None)

    def unverified(_u: str, _t: float) -> bytes:
        raise G.Unverified("HTTP 500")

    monkeypatch.setattr(G, "http_get", unverified)
    with pytest.raises(EQ.Refused, match="cannot tell"):
        EQ.check_no_running_replay("http://api:8000", lambda _m: None)

    def unreachable(_u: str, _t: float) -> bytes:
        raise G.Unreachable("refused")

    lines: list[str] = []
    monkeypatch.setattr(G, "http_get", unreachable)
    EQ.check_no_running_replay("http://api:8000", lines.append)
    monkeypatch.setattr(G, "http_get", lambda _u, _t: b'{"running": []}')
    EQ.check_no_running_replay("http://api:8000", lines.append)
    assert lines == [
        "replay check: no api at http://api:8000; no API replay can be running",
        "replay check: no replay running",
    ]


def test_comparable_message_drops_only_ids_and_timing() -> None:
    a = {
        "type": "lap",
        "season": 2024,
        "round": 5,
        "event_ts": "x",
        "published_at": "y",
        "event_id": "z",
        "payload": {"event_id": "e", "lap": 3, "produced_at_ms": 1, "redis_written_at_ms": 2},
    }
    b = {**a, "event_ts": "other", "payload": {**a["payload"], "batch_received_at_ms": 9}}
    assert EQ.comparable_message(a) == EQ.comparable_message(b)
    assert EQ.comparable_message(a) != EQ.comparable_message({**a, "payload": {"lap": 4}})

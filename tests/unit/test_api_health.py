"""``GET /api/health``: Redis, Kafka and the deployed model; 200 or 503 naming the failure."""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path

import fakeredis
import pytest
from _api_fixtures import LakeRace, make_api, make_settings, model_folder, write_file_lake

from f1sa.api.health import KafkaUnavailableError, ModelStatus, describe_topic

pytestmark = pytest.mark.anyio

SECRET_URL = "redis://admin:s3cr3t-pa55@redis.internal:6379/0"


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


async def kafka_down() -> None:
    raise KafkaUnavailableError("topic missing or without partitions")


def test_model_status_reads_the_deployment_metadata(tmp_path: Path) -> None:
    d = model_folder(
        tmp_path / "deploy_real_G3.5_k2",
        git_sha="36c369b4268a59f462be4fc289c03cd96affa755",
        git_dirty=True,
        created_utc="2026-11-10T10:00:00Z",
    )
    m = ModelStatus.load(d)
    assert m.ok and m.error is None
    assert m.model_version == "deploy_real_G3.5_k2"
    assert m.git_sha == "36c369b4268a59f462be4fc289c03cd96affa755" and m.git_dirty is True
    assert m.scorer_sha256 == hashlib.sha256((d / "lr" / "scorer.json").read_bytes()).hexdigest()
    assert (m.feature_set, m.g, m.k, m.created_utc) == ("real", 3.5, 2, "2026-11-10T10:00:00Z")


def test_model_status_never_raises(tmp_path: Path) -> None:
    missing = ModelStatus.load(tmp_path / "none")
    assert not missing.ok and missing.error is not None and "missing" in missing.error
    wrong = ModelStatus.load(model_folder(tmp_path / "wrong", g=5.0))
    assert not wrong.ok and wrong.error is not None and "expected" in wrong.error
    broken = model_folder(tmp_path / "broken")
    (broken / "lr" / "scorer.json").write_text("{not json", encoding="utf-8")
    bad = ModelStatus.load(broken)
    assert not bad.ok and bad.error is not None and bad.error.startswith("JSONDecodeError")


def test_describe_topic_refuses_an_unreachable_broker() -> None:
    with pytest.raises(KafkaUnavailableError):
        describe_topic("127.0.0.1:1", "f1.race.events", 0.5)


async def test_health_ok(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    model = ModelStatus.load(model_folder(tmp_path / "deploy_real_G3.5_k2", git_sha="abc"))
    api = make_api(settings, model=model)
    async with api.client() as c:
        resp = await c.get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["checks"]["redis"] == {"ok": True, "error": None}
    assert body["checks"]["kafka"] == {"ok": True, "error": None}
    assert body["checks"]["model"]["ok"] is True
    assert body["checks"]["model"]["git_sha"] == "abc"
    assert body["checks"]["model"]["model_version"] == "deploy_real_G3.5_k2"


async def test_health_503_when_redis_is_down(tmp_path: Path) -> None:
    server = fakeredis.FakeServer()
    server.connected = False
    api = make_api(make_settings(tmp_path), server=server)
    async with api.client() as c:
        resp = await c.get("/api/health")
    assert resp.status_code == 503
    checks = resp.json()["checks"]
    assert checks["redis"]["ok"] is False and "ConnectionError" in checks["redis"]["error"]
    assert checks["kafka"]["ok"] and checks["model"]["ok"]


async def test_health_503_when_kafka_is_down(tmp_path: Path) -> None:
    api = make_api(make_settings(tmp_path), kafka_check=kafka_down)
    async with api.client() as c:
        resp = await c.get("/api/health")
    assert resp.status_code == 503
    body = resp.json()
    assert body["status"] == "degraded"
    assert body["checks"]["kafka"] == {
        "ok": False,
        "error": "KafkaUnavailableError: Kafka events topic not reachable",
    }
    assert body["checks"]["redis"]["ok"] and body["checks"]["model"]["ok"]


async def test_health_503_when_the_model_is_missing(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    api = make_api(settings, model=ModelStatus.load(settings.api_model_dir))
    async with api.client() as c:
        resp = await c.get("/api/health")
    assert resp.status_code == 503
    model = resp.json()["checks"]["model"]
    assert model["ok"] is False and model["model_version"] == "deploy_real_G3.5_k2"
    assert model["git_sha"] is None


async def test_health_never_leaks_the_redis_url(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    server = fakeredis.FakeServer()
    server.connected = False
    api = make_api(make_settings(tmp_path, redis_url=SECRET_URL), server=server)
    with caplog.at_level(logging.DEBUG):
        async with api.client() as c:
            resp = await c.get("/api/health")
    assert resp.status_code == 503
    for needle in ("s3cr3t-pa55", "admin", "redis.internal", SECRET_URL):
        assert needle not in resp.text
        assert needle not in caplog.text


async def test_health_reports_sample_lake_mode(tmp_path: Path) -> None:
    write_file_lake(tmp_path / "lake")  # 2024 R5 has synthetic stints
    api = make_api(make_settings(tmp_path))
    async with api.client() as c:
        resp = await c.get("/api/health")
    assert resp.status_code == 200
    assert resp.json()["lake"] == {"scheme": "file", "mode": "sample", "synthetic": True}


async def test_health_reports_full_lake_mode(tmp_path: Path) -> None:
    write_file_lake(tmp_path / "lake", (LakeRace(2023, 5, "Miami Grand Prix"),))
    api = make_api(make_settings(tmp_path))
    async with api.client() as c:
        body = (await c.get("/api/health")).json()
    assert body["lake"] == {"scheme": "file", "mode": "full", "synthetic": False}


async def test_unreadable_lake_gives_nulls_and_keeps_status(tmp_path: Path) -> None:
    api = make_api(make_settings(tmp_path))  # no clean zone at all
    async with api.client() as c:
        resp = await c.get("/api/health")
    assert resp.status_code == 200, "the lake block is informational"
    assert resp.json()["lake"] == {"scheme": "file", "mode": None, "synthetic": None}
    hdfs = make_api(
        make_settings(
            tmp_path, data_lake_uri="hdfs://127.0.0.1:1/f1", hdfs_httpfs_url="http://127.0.0.1:1"
        )
    )
    async with hdfs.client() as c:
        lake = (await c.get("/api/health")).json()["lake"]
    assert lake == {"scheme": "hdfs", "mode": None, "synthetic": None}


# ------------------------------------------------------------- F10: smoke-test fields (additive)
NEW_MODEL_FIELDS = {"smoke_test", "trained_on", "model_id", "stamp"}
PRE_F10_MODEL_FIELDS = {
    "ok",
    "error",
    "model_version",
    "git_sha",
    "git_dirty",
    "scorer_sha256",
    "created_utc",
    "feature_set",
    "g",
    "k",
}
SMOKE = (
    "SMOKE TEST: trained on the 2 sample races (Jolpica laps, SYNTHETIC tyres); demo only, "
    "not findings"
)


def test_sample_prefix_is_the_deploy_modules() -> None:
    from f1sa.api.health import SAMPLE_PREFIX, is_smoke_model
    from f1sa.model.deploy import SAMPLE_PREFIX as DEPLOY_PREFIX

    assert SAMPLE_PREFIX == DEPLOY_PREFIX == "sample_"
    assert is_smoke_model("sample_deploy_real_G3.5_k2") and not is_smoke_model(
        "deploy_real_G3.5_k2"
    )


def test_model_status_f10_fields(tmp_path: Path) -> None:
    sample = ModelStatus.load(
        model_folder(
            tmp_path / "sample_deploy_real_G3.5_k2", source="sample", smoke_test=True, stamp=SMOKE
        )
    )
    assert sample.ok and sample.smoke_test and sample.trained_on == "sample"
    assert sample.model_id == sample.model_version == "sample_deploy_real_G3.5_k2"
    assert sample.stamp == SMOKE
    full = ModelStatus.load(model_folder(tmp_path / "deploy_real_G3.5_k2"))
    assert full.ok and not full.smoke_test and full.trained_on == "full" and full.stamp is None
    # unreadable metadata: the prefix rule decides trained_on too
    gone = ModelStatus.load(tmp_path / "sample_deploy_missing")
    assert not gone.ok and gone.smoke_test and gone.trained_on == "sample" and gone.stamp is None
    gone_full = ModelStatus.load(tmp_path / "deploy_missing")
    assert not gone_full.smoke_test and gone_full.trained_on == "full"


@pytest.mark.parametrize("name", ["deploy_real_G3.5_k2", "sample_deploy_real_G3.5_k2"])
def test_smoke_rule_agrees_with_the_real_deployment_metadata(name: str) -> None:
    import json

    meta_path = (
        Path(__file__).resolve().parents[2] / "models" / "undercut" / name / "lr" / "metadata.json"
    )
    if not meta_path.is_file():
        pytest.skip(f"{meta_path} not present (models are not committed)")
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    m = ModelStatus.load(meta_path.parent.parent)
    assert m.ok
    assert m.smoke_test is (meta.get("smoke_test") is True)
    assert m.trained_on == ("sample" if meta.get("source") == "sample" else "full")
    assert m.stamp == meta.get("stamp")


async def test_health_f10_fields_and_contract(tmp_path: Path) -> None:
    """Every pre-existing field keeps its name and value; F10 adds four keys to checks.model."""
    write_file_lake(tmp_path / "lake")  # sample lake
    settings = make_settings(tmp_path)
    for name, extra, smoke, trained, stamp in (
        ("deploy_real_G3.5_k2", {}, False, "full", None),
        (
            "sample_deploy_real_G3.5_k2",
            {"source": "sample", "smoke_test": True, "stamp": SMOKE},
            True,
            "sample",
            SMOKE,
        ),
    ):
        d = model_folder(
            tmp_path / name, git_sha="abc", created_utc="2026-11-01T00:00:00Z", **extra
        )
        api = make_api(settings, model=ModelStatus.load(d))
        async with api.client() as c:
            resp = await c.get("/api/health")
        assert resp.status_code == 200
        body = resp.json()
        assert set(body) == {"status", "checks", "lake"}
        assert body["status"] == "ok"
        assert body["lake"] == {"scheme": "file", "mode": "sample", "synthetic": True}
        assert body["checks"]["redis"] == {"ok": True, "error": None}
        assert body["checks"]["kafka"] == {"ok": True, "error": None}
        model = body["checks"]["model"]
        assert set(model) == PRE_F10_MODEL_FIELDS | NEW_MODEL_FIELDS
        sha = hashlib.sha256((d / "lr" / "scorer.json").read_bytes()).hexdigest()
        assert {k: model[k] for k in PRE_F10_MODEL_FIELDS} == {
            "ok": True,
            "error": None,
            "model_version": name,
            "git_sha": "abc",
            "git_dirty": None,
            "scorer_sha256": sha,
            "created_utc": "2026-11-01T00:00:00Z",
            "feature_set": "real",
            "g": 3.5,
            "k": 2,
        }
        assert {k: model[k] for k in NEW_MODEL_FIELDS} == {
            "smoke_test": smoke,
            "trained_on": trained,
            "model_id": name,
            "stamp": stamp,
        }


async def test_health_f10_fields_when_the_model_is_missing(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    api = make_api(settings, model=ModelStatus.load(tmp_path / "sample_deploy_real_G3.5_k2"))
    async with api.client() as c:
        resp = await c.get("/api/health")
    assert resp.status_code == 503
    model = resp.json()["checks"]["model"]
    assert model["ok"] is False and model["model_version"] == "sample_deploy_real_G3.5_k2"
    assert (model["smoke_test"], model["trained_on"], model["model_id"], model["stamp"]) == (
        True,
        "sample",
        "sample_deploy_real_G3.5_k2",
        None,
    )

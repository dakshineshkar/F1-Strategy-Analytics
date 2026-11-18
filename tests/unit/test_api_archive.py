"""``GET /api/archive`` and ``GET /api/archive/{s}/{r}`` (Feature 4): read-only, HTTP caching
(ETag / 304), gzip or identity, the sealed test season, the error codes, the HttpFS limits, and
no Redis key read or written."""

from __future__ import annotations

import gzip
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
from _api_fixtures import DirFakeHttpFS, httpfs_session, make_api, make_settings
from _archive_fixtures import START_MS, bundle_of, priors_for, scenario_replay, settings
from _stream_fixtures import scenario_inputs, scorer
from _undercut_fixtures import Scenario, standard_cars

from f1sa.api.catalog import CatalogError, FileLakeReader, HttpFsLakeReader, archive_reader
from f1sa.archive.replay import replay_race
from f1sa.archive.schema import ArchiveBundle, decode_bundle, encode_bundle, manifest_for
from f1sa.features.undercut_rule import RuleParams

pytestmark = pytest.mark.anyio
PART = "race_bundle/season={s}/round={r}"


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def _bundle_2025() -> ArchiveBundle:
    inputs = scenario_inputs(Scenario(2025, 3, standard_cars()))
    rep = replay_race(
        inputs,
        priors_for(inputs),
        scorer(),
        RuleParams(),
        start_ms=START_MS,
        settings=settings(),
        allow_test_season=True,
    )
    return bundle_of(rep)


def _files(*bundles: ArchiveBundle, corrupt: str | None = None) -> dict[str, bytes]:
    """``{path under archive/: bytes}`` with the sink's manifest fields around the archive ones."""
    out: dict[str, bytes] = {}
    for b in bundles:
        raw, gz = encode_bundle(b)
        sha = hashlib.sha256(gz).hexdigest()
        m = manifest_for(b, raw, gz, sha).model_dump(mode="json")
        part = PART.format(s=b.meta.season, r=b.meta.round)
        if corrupt == "bytes":
            gz = gz[:-8] + b"\x00" * 8
        elif corrupt == "schema":
            doc = json.loads(raw)
            doc["schema_version"] = 9
            gz = gzip.compress(json.dumps(doc).encode(), mtime=0)
            m["sha256"], m["size_bytes"] = hashlib.sha256(gz).hexdigest(), len(gz)
        elif corrupt == "manifest":
            m = {"oops": True}
        out[f"{part}/bundle.json.gz"] = gz
        out[f"{part}/_manifest.json"] = json.dumps(
            {"written_at": "2026-11-16T00:00:00+00:00", "partition": "x", **m, "files": []}
        ).encode()
    return out


def _lake(tmp_path: Path, files: dict[str, bytes]) -> Path:
    root = tmp_path / "lake"
    for rel, data in files.items():
        p = root / "archive" / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    (root / "archive" / "race_bundle" / "season=2023" / "round=9").mkdir(parents=True)
    return root


@pytest.fixture(scope="module")
def bundle() -> ArchiveBundle:
    return bundle_of(scenario_replay()[2])


def _api(tmp_path: Path, files: dict[str, bytes], **kw: Any) -> Any:
    _lake(tmp_path, files)
    return make_api(make_settings(tmp_path, **kw))


# ------------------------------------------------------------------ listing
async def test_list_has_every_archived_race_with_an_etag(
    tmp_path: Path, bundle: ArchiveBundle
) -> None:
    api = _api(tmp_path, _files(bundle, _bundle_2025()))
    async with api.client() as c:
        resp = await c.get("/api/archive")
        again = await c.get("/api/archive", headers={"If-None-Match": resp.headers["etag"]})
    assert resp.status_code == 200 and resp.headers["cache-control"] == "no-cache"
    races = resp.json()["races"]
    assert [(r["season"], r["round"]) for r in races] == [(2023, 1)]  # 2025 sealed, R9 empty
    assert races[0]["laps"] == bundle.meta.laps and races[0]["model_version"] == "deploy_test"
    assert again.status_code == 304 and again.content == b""
    assert await api.redis.keys("*") == []


async def test_list_shows_2025_only_when_allowed(tmp_path: Path, bundle: ArchiveBundle) -> None:
    api = _api(tmp_path, _files(bundle, _bundle_2025()), allow_test_season=True)
    async with api.client() as c:
        races = (await c.get("/api/archive")).json()["races"]
        got = await c.get("/api/archive/2025/3")
    assert [(r["season"], r["round"]) for r in races] == [(2023, 1), (2025, 3)]
    assert got.status_code == 200


async def test_list_is_cached_in_process(tmp_path: Path, bundle: ArchiveBundle) -> None:
    api = _api(tmp_path, _files(bundle), api_archive_cache_s=300)
    async with api.client() as c:
        first = (await c.get("/api/archive")).json()
        for p in (tmp_path / "lake" / "archive").rglob("_manifest.json"):
            p.unlink()
        assert (await c.get("/api/archive")).json() == first
    fresh = _api(tmp_path / "x", _files(bundle), api_archive_cache_s=0)
    async with fresh.client() as c:
        assert len((await c.get("/api/archive")).json()["races"]) == 1


async def test_empty_or_missing_archive_lists_nothing(tmp_path: Path) -> None:
    api = make_api(make_settings(tmp_path))
    async with api.client() as c:
        resp = await c.get("/api/archive")
    assert resp.status_code == 200 and resp.json() == {"races": []}


# ------------------------------------------------------------------ one bundle
async def test_bundle_is_served_as_stored_gzip_or_as_json(
    tmp_path: Path, bundle: ArchiveBundle
) -> None:
    files = _files(bundle)
    stored = files[f"{PART.format(s=2023, r=1)}/bundle.json.gz"]
    api = _api(tmp_path, files)
    async with api.client() as c:
        gz = await c.get("/api/archive/2023/1", headers={"Accept-Encoding": "gzip"})
        plain = await c.get("/api/archive/2023/1", headers={"Accept-Encoding": "identity"})
        none = await c.get("/api/archive/2023/1", headers={"Accept-Encoding": "gzip;q=0, identity"})
        hit = await c.get("/api/archive/2023/1", headers={"If-None-Match": gz.headers["etag"]})
    sha = hashlib.sha256(stored).hexdigest()
    assert gz.status_code == 200 and gz.headers["content-encoding"] == "gzip"
    assert gz.headers["etag"] == f'"{sha}"' and "Accept-Encoding" in gz.headers["vary"]
    assert gz.headers["cache-control"] == "no-cache"
    assert decode_bundle(stored) == ArchiveBundle.model_validate(gz.json()) == bundle
    assert "content-encoding" not in plain.headers and plain.json() == gz.json()
    assert "content-encoding" not in none.headers
    assert hit.status_code == 304 and hit.content == b""
    assert await api.redis.keys("*") == []


@pytest.mark.parametrize(
    ("url", "status"),
    [
        ("/api/archive/2023/2", 404),
        ("/api/archive/2023/9", 404),  # partition without files
        ("/api/archive/2025/3", 404),  # sealed
        ("/api/archive/1949/1", 422),
        ("/api/archive/2023/31", 422),
        ("/api/archive/2023/x", 422),
    ],
)
async def test_missing_sealed_and_invalid(
    tmp_path: Path, bundle: ArchiveBundle, url: str, status: int
) -> None:
    api = _api(tmp_path, _files(bundle, _bundle_2025()))
    async with api.client() as c:
        resp = await c.get(url)
    assert resp.status_code == status


@pytest.mark.parametrize("corrupt", ["bytes", "schema", "manifest"])
async def test_malformed_storage_is_500(
    tmp_path: Path, bundle: ArchiveBundle, corrupt: str
) -> None:
    api = _api(tmp_path, _files(bundle, corrupt=corrupt))
    async with api.client() as c:
        one = await c.get("/api/archive/2023/1")
        listing = await c.get("/api/archive")
    assert one.status_code == 500 and "malformed" in one.json()["detail"]
    assert listing.status_code == (500 if corrupt == "manifest" else 200)


async def test_a_lake_error_is_503(tmp_path: Path) -> None:
    def broken() -> Any:
        raise CatalogError("down")

    api = make_api(make_settings(tmp_path), archive_reader_factory=broken)
    async with api.client() as c:
        assert (await c.get("/api/archive")).status_code == 503
        resp = await c.get("/api/archive/2023/1")
    assert resp.status_code == 503 and resp.json() == {"detail": "archive zone unavailable"}


async def test_validated_bundles_are_kept_by_sha(tmp_path: Path, bundle: ArchiveBundle) -> None:
    api = _api(tmp_path, _files(bundle))
    async with api.client() as c:
        assert (await c.get("/api/archive/2023/1")).status_code == 200
        part = tmp_path / "lake" / "archive" / PART.format(s=2023, r=1)
        (part / "bundle.json.gz").write_bytes(b"gone")  # the manifest still names the old sha
        assert (await c.get("/api/archive/2023/1")).status_code == 200


# ------------------------------------------------------------------ HttpFS and reader limits
async def test_over_httpfs_only_two_files_of_the_archive_zone_are_opened(
    tmp_path: Path, bundle: ArchiveBundle
) -> None:
    fake = DirFakeHttpFS()
    fake.add_tree("/f1/archive", _files(bundle))
    api = make_api(
        make_settings(tmp_path, data_lake_uri="hdfs://namenode:8020/f1"),
        http_session=httpfs_session(fake),
    )
    async with api.client() as c:
        listing = await c.get("/api/archive")
        resp = await c.get("/api/archive/2023/1")
    assert listing.status_code == 200 and len(listing.json()["races"]) == 1
    assert resp.status_code == 200
    assert {op for op, _ in fake.ops} <= {"LISTSTATUS", "OPEN"} and set(fake.methods) == {"GET"}
    assert all(p.startswith("/f1/archive/race_bundle") for _, p in fake.ops)
    opened = {p.rsplit("/", 1)[1] for op, p in fake.ops if op == "OPEN"}
    assert opened == {"_manifest.json", "bundle.json.gz"}


def test_readers_refuse_other_files_tables_zones_and_2025(tmp_path: Path) -> None:
    s = make_settings(tmp_path)
    reader = archive_reader(s)
    assert isinstance(reader, FileLakeReader)
    for bad in ("x.parquet", "../bundle.json.gz", "bundle.json"):
        with pytest.raises(CatalogError, match="not readable"):
            reader.read_file("race_bundle", 2024, 5, bad)
    with pytest.raises(CatalogError, match="not readable"):
        reader.read_file("laps", 2024, 5, "bundle.json.gz")
    with pytest.raises(CatalogError, match="sealed"):
        reader.read_file("race_bundle", 2025, 5, "bundle.json.gz")
    assert reader.read_file("race_bundle", 2024, 5, "bundle.json.gz") is None
    hdfs = archive_reader(
        make_settings(tmp_path, data_lake_uri="hdfs://nn:8020/f1"),
        session=httpfs_session(DirFakeHttpFS()),
    )
    assert isinstance(hdfs, HttpFsLakeReader) and hdfs.clean == "/f1/archive"
    with pytest.raises(CatalogError, match="outside"):
        hdfs._guard("OPEN", "/f1/raw/jolpica/laps/x")
    with pytest.raises(CatalogError, match="not readable"):
        hdfs.read_file("race_bundle", 2024, 5, "part-0.parquet")


def test_the_api_still_imports_no_pyspark() -> None:
    code = "import sys, f1sa.api.app; print('pyspark' in sys.modules)"
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    assert out.stdout.strip() == "False"

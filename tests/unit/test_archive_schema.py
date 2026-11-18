"""``archive.schema``: bundle schema v1, the deterministic gzip JSON encoding and the manifest."""

from __future__ import annotations

import gzip
import hashlib
import json
from typing import Any

import pytest
from _archive_fixtures import bundle_of, scenario_replay
from pydantic import ValidationError

from f1sa.archive.schema import (
    MAX_RAW_BYTES,
    ArchiveBundle,
    ArchiveFormatError,
    decode_bundle,
    encode_bundle,
    gunzip_limited,
    manifest_for,
    parse_manifest,
    to_json_bytes,
)


@pytest.fixture(scope="module")
def bundle() -> ArchiveBundle:
    return bundle_of(scenario_replay()[2])


def _doc(b: ArchiveBundle) -> dict[str, Any]:
    out: dict[str, Any] = json.loads(to_json_bytes(b))
    return out


def _gz(doc: Any) -> bytes:
    return gzip.compress(json.dumps(doc).encode(), mtime=0)


def test_round_trip_is_exact_and_the_bytes_are_deterministic(bundle: ArchiveBundle) -> None:
    raw, gz = encode_bundle(bundle)
    assert decode_bundle(gz) == bundle
    assert encode_bundle(bundle_of(scenario_replay()[2])) == (raw, gz)
    assert gz[4:8] == b"\x00\x00\x00\x00"  # gzip mtime 0
    assert raw == json.dumps(json.loads(raw), sort_keys=True, separators=(",", ":")).encode()


def test_the_manifest_describes_the_bytes(bundle: ArchiveBundle) -> None:
    raw, gz = encode_bundle(bundle)
    sha = hashlib.sha256(gz).hexdigest()
    m = manifest_for(bundle, raw, gz, sha)
    assert (m.sha256, m.size_bytes, m.raw_bytes) == (sha, len(gz), len(raw))
    assert m.n_alerts == sum(1 for x in bundle.messages if x.message["type"] == "undercut_alert")
    assert m.n_snapshots == len(bundle.snapshots) and m.laps == bundle.meta.laps
    stored = {"written_at": "x", "files": [], **m.model_dump(mode="json")}
    assert parse_manifest(json.dumps(stored).encode()) == m
    with pytest.raises(ArchiveFormatError, match="malformed"):
        parse_manifest(json.dumps({**stored, "sha256": "nope"}).encode())
    with pytest.raises(ArchiveFormatError, match="not an object"):
        parse_manifest(b"[]")


@pytest.mark.parametrize(
    ("mutate", "match"),
    [
        (lambda d: d.update(schema_version=2), "schema_version"),
        (lambda d: d["snapshots"].reverse(), "strictly increasing"),
        (lambda d: d["meta"].update(laps=d["meta"]["laps"] + 1), "meta.laps"),
        (lambda d: d["messages"][0]["message"].update(round=99), "another race"),
        (lambda d: d["messages"][0]["message"].update(type="nope"), "message type"),
        (lambda d: d["messages"].pop(), "session_end"),
        (lambda d: d["messages"][1].update(event_id=d["messages"][0]["event_id"]), "duplicate"),
        (lambda d: d["messages"][0].update(event_id="not-a-uuid"), "event_id"),
        (lambda d: d["decisions"][0].update(evaluated_lap=999), "unknown micro-batch"),
        (lambda d: d["decisions"][0].update(probability=1.5), "probability"),
        (lambda d: d["meta"].update(extra=1), "extra"),
        (lambda d: d["snapshots"][0]["drivers"].popitem(), None),
    ],
)
def test_schema_rejects_broken_bundles(
    bundle: ArchiveBundle, mutate: Any, match: str | None
) -> None:
    doc = _doc(bundle)
    mutate(doc)
    if match is None:  # a snapshot may legitimately lack a driver: still valid
        decode_bundle(_gz(doc))
        return
    with pytest.raises(ArchiveFormatError, match=match):
        decode_bundle(_gz(doc))
    with pytest.raises(ValidationError):
        ArchiveBundle.model_validate(doc)


def test_decoding_refuses_non_finite_numbers_and_bad_bytes(bundle: ArchiveBundle) -> None:
    raw, gz = encode_bundle(bundle)
    nan = raw.replace(b'"gap_s":', b'"gap_s":NaN,"x":', 1)
    with pytest.raises(ArchiveFormatError, match="non-finite"):
        decode_bundle(gzip.compress(nan, mtime=0))
    with pytest.raises(ArchiveFormatError, match="not gzip"):
        decode_bundle(raw)
    with pytest.raises(ArchiveFormatError, match="truncated"):
        decode_bundle(gz[: len(gz) // 2])
    with pytest.raises(ArchiveFormatError, match="trailing"):
        decode_bundle(gz + gz)
    with pytest.raises(ArchiveFormatError, match="not JSON"):
        decode_bundle(gzip.compress(b"{nope", mtime=0))
    with pytest.raises(ArchiveFormatError, match="beyond"):
        gunzip_limited(gz, limit=100)
    assert len(gunzip_limited(gz)) == len(raw) < MAX_RAW_BYTES

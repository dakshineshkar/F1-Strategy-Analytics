"""The post-race archive bundle (schema version 1) and its gzip JSON encoding.

One bundle per race, ``{lake}/archive/race_bundle/season=S/round=R/bundle.json.gz`` next to a
``_manifest.json``. Pydantic only (no pyspark), so the API imports it.

* ``snapshots``: the race state at the **end of each leader lap** N, i.e. after every event before
  the leader's first lap-(N+1) crossing. Each one is exactly what ``GET /api/races/{s}/{r}/state``
  returns for the Redis the stream left at that point (``api.models.RaceStateOut``: the 9 driver
  hash fields, the order zset and the additive tyre hash) plus ``lap``.
* ``messages``: every message the stream published on ``race:{s}:{r}:events`` (lap, pit_in,
  pit_out, undercut_alert, session_end), verbatim, with the ``event_id`` the SSE stream would give
  it and the leader lap of the micro-batch that published it.
* ``decisions``: every rule-eligible pair the stream scored (decision lap, attacker, defender,
  gap, calibrated probability), with the lap of the micro-batch that evaluated it.
* ``track`` / ``race_control``: per-lap track status of the leader and the race-control messages
  (``clean/analysis_*``, Feature 2), for the slider's markers. Display only.
"""

from __future__ import annotations

import gzip
import json
import zlib
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from f1sa.api.models import (
    UUID_PATTERN,
    AnalysisRaceControlOut,
    DriverStateOut,
    EntrantOut,
    OrderEntry,
    TyreLifeOut,
)
from f1sa.serving import keys as K

SCHEMA_VERSION: Literal[1] = 1
ZONE = "archive"
TABLE = "race_bundle"
TABLES: tuple[str, ...] = (TABLE,)
BUNDLE_NAME = "bundle.json.gz"
MANIFEST_NAME = "_manifest.json"
FILE_NAMES: tuple[str, ...] = (BUNDLE_NAME, MANIFEST_NAME)
"""The only file names an archive partition holds (and the API may open)."""
MAX_RAW_BYTES = 64 * 1024 * 1024
"""Refuse to inflate a bundle beyond this (a full race is about 1-2 MB)."""
CLOCK_NOTE = (
    "simulated: race_start_utc + 180 s + replayed race time (not wall clock); "
    "updated_at, published_at and the *_ms fields follow it"
)
MICRO_BATCH: Literal["leader_lap"] = "leader_lap"


class ArchiveFormatError(ValueError):
    """Bytes that are not a valid archive bundle (gzip, JSON or schema)."""


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class ModelInfo(_Strict):
    version: str
    scorer_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    feature_set: str | None
    g: float
    k: int
    git_sha: str | None
    git_dirty: bool | None
    created_utc: str | None


class BuilderInfo(_Strict):
    git_sha: str | None
    git_dirty: bool | None
    code_path: Literal["streaming.processor.StreamProcessor -> RedisSink -> RaceStore"] = (
        "streaming.processor.StreamProcessor -> RedisSink -> RaceStore"
    )


class BundleMeta(_Strict):
    season: int
    round: int
    race_name: str | None
    circuit_name: str | None
    race_date: str | None
    race_start_utc: str | None
    laps: int = Field(ge=1, description="the last snapshot's lap (the leader's last lap)")
    synthetic: bool = Field(description="sample mode: compounds and tyre ages are SYNTHETIC")
    source: Literal["sample", "lake"]
    n_partitions: int = Field(ge=1)
    micro_batch: Literal["leader_lap"] = MICRO_BATCH
    clock: str = CLOCK_NOTE
    model: ModelInfo
    builder: BuilderInfo


class SnapshotOut(_Strict):
    lap: int = Field(ge=1)
    drivers: dict[str, DriverStateOut]
    order: list[OrderEntry]
    tyres: dict[str, TyreLifeOut] = Field(default_factory=dict)


class MessageOut(_Strict):
    lap: int = Field(ge=1, description="leader lap of the micro-batch that published it")
    event_id: str = Field(pattern=UUID_PATTERN)
    message: dict[str, Any]

    @model_validator(mode="after")
    def _check(self) -> MessageOut:
        t = self.message.get("type")
        if t not in K.EVENT_TYPES:
            raise ValueError(f"message type must be one of {K.EVENT_TYPES}, got {t!r}")
        if not isinstance(self.message.get("payload"), dict):
            raise ValueError("message payload must be an object")
        return self


class DecisionOut(_Strict):
    evaluated_lap: int = Field(ge=1, description="leader lap of the micro-batch that scored it")
    decision_lap: int = Field(ge=1)
    attacker_id: str
    defender_id: str
    gap_s: float
    probability: float = Field(ge=0.0, le=1.0)


class TrackLapOut(_Strict):
    lap: int = Field(ge=1)
    is_sc_lap: bool | None
    is_vsc_lap: bool | None
    is_red_flag_lap: bool | None
    is_neutralised_lap: bool | None
    neutralised_source: Literal["track_status", "heuristic"]
    track_status: str | None


class ArchiveBundle(_Strict):
    schema_version: Literal[1]
    meta: BundleMeta
    entrants: list[EntrantOut]
    snapshots: list[SnapshotOut] = Field(min_length=1)
    messages: list[MessageOut]
    decisions: list[DecisionOut]
    track: list[TrackLapOut]
    race_control: list[AnalysisRaceControlOut]

    @model_validator(mode="after")
    def _check(self) -> ArchiveBundle:
        laps = [s.lap for s in self.snapshots]
        if laps != sorted(set(laps)):
            raise ValueError("snapshot laps must be strictly increasing")
        if laps[-1] != self.meta.laps:
            raise ValueError(f"meta.laps {self.meta.laps} != last snapshot lap {laps[-1]}")
        known = set(laps)
        msg_laps = [m.lap for m in self.messages]
        if msg_laps != sorted(msg_laps) or not set(msg_laps) <= known:
            raise ValueError("message laps must be non-decreasing snapshot laps")
        race = (self.meta.season, self.meta.round)
        for m in self.messages:
            if (m.message.get("season"), m.message.get("round")) != race:
                raise ValueError("a message belongs to another race")
        ends = [m for m in self.messages if m.message["type"] == "session_end"]
        if not ends or any(m.lap != laps[-1] for m in ends):
            raise ValueError("session_end must be published in the last lap's micro-batch")
        ids = [m.event_id for m in self.messages]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate message event ids")
        if any(d.evaluated_lap not in known for d in self.decisions):
            raise ValueError("a decision was evaluated in an unknown micro-batch")
        track_laps = [t.lap for t in self.track]
        if track_laps != sorted(set(track_laps)):
            raise ValueError("track laps must be strictly increasing")
        return self


class ManifestOut(_Strict):
    """What ``_manifest.json`` records about the bundle (the sink adds its own fields)."""

    schema_version: Literal[1]
    season: int
    round: int
    race_name: str | None
    laps: int = Field(ge=1)
    synthetic: bool
    model_version: str
    scorer_sha256: str
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$", description="of bundle.json.gz")
    size_bytes: int = Field(ge=1, description="bundle.json.gz")
    raw_bytes: int = Field(ge=1, description="the JSON before gzip")
    n_snapshots: int = Field(ge=1)
    n_messages: int = Field(ge=0)
    n_alerts: int = Field(ge=0)
    n_decisions: int = Field(ge=0)


MANIFEST_FIELDS: tuple[str, ...] = tuple(ManifestOut.model_fields)


# ============================================================================== encoding
def _refuse_constant(name: str) -> Any:
    raise ArchiveFormatError(f"non-finite number {name} in the bundle")


def to_json_bytes(bundle: ArchiveBundle) -> bytes:
    """Canonical JSON (sorted keys, no spaces, no NaN): a rebuild gives the same bytes."""
    doc = bundle.model_dump(mode="json")
    return json.dumps(doc, allow_nan=False, separators=(",", ":"), sort_keys=True).encode()


def encode_bundle(bundle: ArchiveBundle) -> tuple[bytes, bytes]:
    """(raw JSON, gzip) with ``mtime=0`` and level 9, so the gzip bytes are deterministic."""
    raw = to_json_bytes(bundle)
    return raw, gzip.compress(raw, compresslevel=9, mtime=0)


def gunzip_limited(data: bytes, limit: int = MAX_RAW_BYTES) -> bytes:
    """Inflate ``data`` (one gzip member), refusing anything larger than ``limit`` bytes."""
    d = zlib.decompressobj(wbits=31)
    try:
        out = d.decompress(data, limit + 1)
    except zlib.error as exc:
        raise ArchiveFormatError(f"not gzip data: {exc}") from exc
    if len(out) > limit:
        raise ArchiveFormatError(f"bundle inflates beyond {limit} bytes")
    if not d.eof:
        raise ArchiveFormatError("truncated gzip data")
    if d.unused_data:
        raise ArchiveFormatError("trailing data after the gzip member")
    return out


def parse_json(raw: bytes) -> Any:
    try:
        return json.loads(raw, parse_constant=_refuse_constant)
    except ArchiveFormatError:
        raise
    except ValueError as exc:
        raise ArchiveFormatError(f"not JSON: {exc}") from exc


def decode_bundle(data: bytes, *, limit: int = MAX_RAW_BYTES) -> ArchiveBundle:
    """gzip bytes -> a validated bundle (``ArchiveFormatError`` on any defect)."""
    doc = parse_json(gunzip_limited(data, limit))
    try:
        return ArchiveBundle.model_validate(doc)
    except ValidationError as exc:
        raise ArchiveFormatError(f"bundle breaks schema v{SCHEMA_VERSION}: {exc}") from exc


def manifest_for(bundle: ArchiveBundle, raw: bytes, gz: bytes, sha256: str) -> ManifestOut:
    alerts = sum(1 for m in bundle.messages if m.message["type"] == "undercut_alert")
    return ManifestOut(
        schema_version=SCHEMA_VERSION,
        season=bundle.meta.season,
        round=bundle.meta.round,
        race_name=bundle.meta.race_name,
        laps=bundle.meta.laps,
        synthetic=bundle.meta.synthetic,
        model_version=bundle.meta.model.version,
        scorer_sha256=bundle.meta.model.scorer_sha256,
        sha256=sha256,
        size_bytes=len(gz),
        raw_bytes=len(raw),
        n_snapshots=len(bundle.snapshots),
        n_messages=len(bundle.messages),
        n_alerts=alerts,
        n_decisions=len(bundle.decisions),
    )


def parse_manifest(data: bytes) -> ManifestOut:
    """A stored ``_manifest.json`` -> its archive fields (sink fields ignored)."""
    doc = parse_json(data)
    if not isinstance(doc, dict):
        raise ArchiveFormatError("manifest is not an object")
    try:
        return ManifestOut.model_validate({k: doc.get(k) for k in MANIFEST_FIELDS})
    except ValidationError as exc:
        raise ArchiveFormatError(f"manifest is malformed: {exc}") from exc

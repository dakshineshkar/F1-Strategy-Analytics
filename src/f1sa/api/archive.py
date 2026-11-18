"""The post-race archive behind ``GET /api/archive`` and ``GET /api/archive/{s}/{r}`` (Feature 4,
display only).

Read-only: ``{lake}/archive/race_bundle/season=S/round=R/{_manifest.json,bundle.json.gz}`` through
``catalog.archive_reader`` (``file://`` or HttpFS ``LISTSTATUS``/``OPEN``; only those two file
names; ``season=2025`` never listed or opened unless ``ALLOW_TEST_SEASON=1``).

* The listing is the manifest of every partition, kept in process for ``API_ARCHIVE_CACHE_S``.
* A bundle is served as stored (gzip). Before the first time a given sha256 is served, the bytes
  are checked against the manifest's sha256 and decoded and validated against schema v1
  (``archive.schema.decode_bundle``); the last few validated bundles stay in memory.

Caching is HTTP only (``ETag`` = the bundle's sha256, ``Cache-Control: no-cache``): no Redis key
is read or written, so the ``race:*`` keys and the driver hash are never touched.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass

from f1sa.api.catalog import FileReader
from f1sa.api.models import ArchiveListOut, ArchiveRaceOut
from f1sa.archive.schema import (
    BUNDLE_NAME,
    MANIFEST_NAME,
    TABLE,
    ArchiveFormatError,
    ManifestOut,
    decode_bundle,
    parse_manifest,
)
from f1sa.streaming.processor import SEALED_SEASON

log = logging.getLogger(__name__)
MAX_CACHED_BUNDLES = 4


class ArchiveDataError(RuntimeError):
    """A stored manifest or bundle is malformed, or the bundle does not match its manifest."""


@dataclass(frozen=True)
class StoredBundle:
    manifest: ManifestOut
    gz: bytes


def to_race(m: ManifestOut) -> ArchiveRaceOut:
    return ArchiveRaceOut(
        season=m.season,
        round=m.round,
        race_name=m.race_name,
        laps=m.laps,
        synthetic=m.synthetic,
        schema_version=m.schema_version,
        model_version=m.model_version,
        scorer_sha256=m.scorer_sha256,
        sha256=m.sha256,
        size_bytes=m.size_bytes,
        raw_bytes=m.raw_bytes,
    )


class ArchiveService:
    def __init__(
        self,
        reader_factory: Callable[[], FileReader],
        *,
        ttl_s: float,
        allow_test_season: bool,
        clock: Callable[[], float] = time.monotonic,
        max_cached: int = MAX_CACHED_BUNDLES,
    ) -> None:
        self._reader_factory = reader_factory
        self.ttl_s = ttl_s
        self.allow_test_season = allow_test_season
        self._clock = clock
        self._max_cached = max_cached
        self._listing: tuple[float, ArchiveListOut] | None = None
        self._bundles: OrderedDict[str, bytes] = OrderedDict()
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------ manifests
    def _manifest_sync(self, reader: FileReader, season: int, round_: int) -> ManifestOut | None:
        data = reader.read_file(TABLE, season, round_, MANIFEST_NAME)
        if data is None:
            return None
        try:
            m = parse_manifest(data)
        except ArchiveFormatError as exc:
            raise ArchiveDataError(f"manifest {season} R{round_}: {exc}") from exc
        if (m.season, m.round) != (season, round_):
            raise ArchiveDataError(f"manifest {season} R{round_} names {m.season} R{m.round}")
        return m

    def _list_sync(self) -> ArchiveListOut:
        reader = self._reader_factory()
        races = []
        for s, r in reader.partitions(TABLE, required=False):
            if s == SEALED_SEASON and not self.allow_test_season:
                continue
            m = self._manifest_sync(reader, s, r)
            if m is None:
                log.warning("archive partition without a manifest", extra={"season": s})
                continue
            races.append(to_race(m))
        return ArchiveListOut(races=sorted(races, key=lambda x: (x.season, x.round)))

    async def races(self) -> ArchiveListOut:
        """Every archived race. Raises ``CatalogError`` (lake) / ``ArchiveDataError``."""
        async with self._lock:
            now = self._clock()
            if self._listing is not None and now - self._listing[0] < self.ttl_s:
                return self._listing[1]
            out = await asyncio.to_thread(self._list_sync)
            self._listing = (now, out)
            return out

    async def manifest(self, season: int, round_: int) -> ManifestOut | None:
        """The race's manifest, or ``None`` (no bundle, or 2025 sealed)."""
        if season == SEALED_SEASON and not self.allow_test_season:
            return None
        reader = self._reader_factory()
        return await asyncio.to_thread(self._manifest_sync, reader, season, round_)

    # ------------------------------------------------------------------ bundles
    def _bundle_sync(self, m: ManifestOut) -> bytes:
        gz = self._reader_factory().read_file(TABLE, m.season, m.round, BUNDLE_NAME)
        if gz is None:
            raise ArchiveDataError(f"{m.season} R{m.round}: manifest without {BUNDLE_NAME}")
        sha = hashlib.sha256(gz).hexdigest()
        if sha != m.sha256 or len(gz) != m.size_bytes:
            raise ArchiveDataError(f"{m.season} R{m.round}: bundle does not match its manifest")
        try:
            bundle = decode_bundle(gz)
        except ArchiveFormatError as exc:
            raise ArchiveDataError(f"{m.season} R{m.round}: {exc}") from exc
        if (bundle.meta.season, bundle.meta.round) != (m.season, m.round):
            raise ArchiveDataError(f"{m.season} R{m.round}: the bundle names another race")
        return gz

    async def bundle(self, m: ManifestOut) -> StoredBundle:
        """The validated gzip bytes of the bundle ``m`` describes."""
        cached = self._bundles.get(m.sha256)
        if cached is not None:
            self._bundles.move_to_end(m.sha256)
            return StoredBundle(m, cached)
        gz = await asyncio.to_thread(self._bundle_sync, m)
        self._bundles[m.sha256] = gz
        while len(self._bundles) > self._max_cached:
            self._bundles.popitem(last=False)
        return StoredBundle(m, gz)

"""Redis key and channel names: the exact contract in CLAUDE.md (#21-#24).

* HASH    ``race:{season}:{round}:driver:{driverId}`` with the 9 fields in ``DRIVER_FIELDS``
* ZSET    ``race:{season}:{round}:order`` (member = driverId, score = position)
* PUBSUB  ``race:{season}:{round}:events`` (message types in ``EVENT_TYPES``)

Additive, display-only extension (approved 2026-11-15; the three items above are unchanged):

* HASH    ``race:{season}:{round}:tyre:{driverId}`` with the 4 fields in ``TYRE_FIELDS`` (the real
  tyre life for the dashboard). Nothing model-related reads it. It matches ``race_pattern``, so it
  gets the same safety TTL on every write and the same EXPIRE at ``session_end``.

Additive, display-only extension (Feature 5, approved 2026-11-18; the items above are unchanged):

* HASH    ``race:{season}:{round}:timing:{driverId}`` with the 11 fields in ``TIMING_FIELDS``
  (the timing-tower values of the car's latest lap: sectors, speed trap, the driver's best so far
  and its stop count). Nothing model-related reads it. It matches ``race_pattern``, so it gets the
  same safety TTL on every write and the same EXPIRE at ``session_end``; it is written in the
  batch's one pipeline.

Additive, display-only API cache (Feature 1; the race keys above are unchanged):

* STRING  ``meta:entrants:{season}:{round}``: the JSON of ``GET /api/races/{s}/{r}/entrants``,
  written with ``SET … EX API_ENTRANTS_CACHE_S``. It is deliberately **outside** ``race:*``, so
  ``race_pattern`` never matches it: ``/state``, the SSE snapshots and ``expire_race`` never see
  it, and nothing in streaming, serving or the model writes or reads it.

Additive, display-only API cache (Feature 2; the race keys above are unchanged):

* STRING  ``meta:analysis:{season}:{round}:{view}`` for the views in ``ANALYSIS_VIEWS``: the JSON
  of ``GET /api/races/{s}/{r}/analysis/{view}``, written with ``SET … EX API_ANALYSIS_CACHE_S``.
  Outside ``race:*`` for the same reasons as the entrants key.

Additive, display-only API cache (Feature 6; the race keys above are unchanged):

* STRING  ``meta:telemetry:{season}:{round}:laps:{CODE}``: the JSON of
  ``GET /api/races/{s}/{r}/telemetry/laps?driver=CODE``, and
  ``meta:telemetry:{season}:{round}:trace:{CODE}:{lap}``: one lap's resampled trace, both written
  with ``SET … EX API_TELEMETRY_CACHE_S``. The compare response is derived from two traces and has
  no key. Outside ``race:*`` for the same reasons as the entrants key.

Every function is pure and validates its inputs (season 1950-2100, round 1-30, driverId
``[a-z0-9_]+``, the Jolpica ``driverId`` form). Invalid input raises ``InvalidKeyError``, so a
malformed key never reaches Redis.
"""

from __future__ import annotations

import re

SEASON_MIN, SEASON_MAX = 1950, 2100
ROUND_MIN, ROUND_MAX = 1, 30
DRIVER_ID_RE = re.compile(r"[a-z0-9_]+")

DRIVER_FIELDS: tuple[str, ...] = (
    "position",
    "gap_ahead_s",
    "gap_leader_s",
    "tyre_compound",
    "tyre_age_laps",
    "last_lap_time_s",
    "undercut_flag",
    "undercut_prob",
    "updated_at",
)
"""The 9 hash fields, in contract order."""

TYRE_FIELDS: tuple[str, ...] = (
    "tyre_life_laps",
    "tyre_life_at_start_laps",
    "lap",
    "updated_at",
)
"""The 4 fields of the additive, display-only tyre hash, in order."""

TIMING_FIELDS: tuple[str, ...] = (
    "lap",
    "sector1_s",
    "sector2_s",
    "sector3_s",
    "speed_trap_kph",
    "pb_sector1_s",
    "pb_sector2_s",
    "pb_sector3_s",
    "pb_speed_trap_kph",
    "pit_stops",
    "updated_at",
)
"""The 11 fields of the additive, display-only timing hash (Feature 5), in order."""

EVENT_TYPES: tuple[str, ...] = ("lap", "pit_in", "pit_out", "undercut_alert", "session_end")
"""The Pub/Sub message types."""


class InvalidKeyError(ValueError):
    """A season, round or driverId outside the key contract."""


def _int_in(name: str, value: object, lo: int, hi: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise InvalidKeyError(f"{name} must be an int, got {value!r}")
    if not lo <= value <= hi:
        raise InvalidKeyError(f"{name} must be in {lo}..{hi}, got {value}")
    return value


def validate_season(season: object) -> int:
    return _int_in("season", season, SEASON_MIN, SEASON_MAX)


def validate_round(round_: object) -> int:
    return _int_in("round", round_, ROUND_MIN, ROUND_MAX)


def validate_driver_id(driver_id: object) -> str:
    if not isinstance(driver_id, str) or DRIVER_ID_RE.fullmatch(driver_id) is None:
        raise InvalidKeyError(f"driverId must match [a-z0-9_]+, got {driver_id!r}")
    return driver_id


def race_prefix(season: int, round_: int) -> str:
    """``race:{season}:{round}``, validated."""
    return f"race:{validate_season(season)}:{validate_round(round_)}"


def driver_key(season: int, round_: int, driver_id: str) -> str:
    """``race:{season}:{round}:driver:{driverId}``"""
    return f"{race_prefix(season, round_)}:driver:{validate_driver_id(driver_id)}"


def tyre_key(season: int, round_: int, driver_id: str) -> str:
    """``race:{season}:{round}:tyre:{driverId}`` (additive, display only)."""
    return f"{race_prefix(season, round_)}:tyre:{validate_driver_id(driver_id)}"


def timing_key(season: int, round_: int, driver_id: str) -> str:
    """``race:{season}:{round}:timing:{driverId}`` (additive, display only; Feature 5)."""
    return f"{race_prefix(season, round_)}:timing:{validate_driver_id(driver_id)}"


def order_key(season: int, round_: int) -> str:
    """``race:{season}:{round}:order``"""
    return f"{race_prefix(season, round_)}:order"


def events_channel(season: int, round_: int) -> str:
    """``race:{season}:{round}:events`` (a Pub/Sub channel, not a key)."""
    return f"{race_prefix(season, round_)}:events"


def race_pattern(season: int, round_: int) -> str:
    """``race:{season}:{round}:*``: the SCAN MATCH pattern for every key of one race. The trailing
    colon keeps round 5 from matching round 50; validated ints contain no glob characters."""
    return f"{race_prefix(season, round_)}:*"


def entrants_meta_key(season: int, round_: int) -> str:
    """``meta:entrants:{season}:{round}`` (additive API cache, outside ``race:*``), validated."""
    return f"meta:entrants:{validate_season(season)}:{validate_round(round_)}"


ANALYSIS_VIEWS: tuple[str, ...] = ("laps", "stints", "pitstops", "race_control", "positions")
"""The cached post-race analysis views (``compare`` is derived from ``laps`` and has no key)."""


def analysis_meta_key(season: int, round_: int, view: str) -> str:
    """``meta:analysis:{season}:{round}:{view}`` (additive API cache, outside ``race:*``)."""
    if not isinstance(view, str) or view not in ANALYSIS_VIEWS:
        raise InvalidKeyError(f"unknown analysis view: {view!r}")
    return f"meta:analysis:{validate_season(season)}:{validate_round(round_)}:{view}"


DRIVER_CODE_RE = re.compile(r"[A-Z]{3}")
LAP_MIN, LAP_MAX = 1, 200


def validate_driver_code(code: object) -> str:
    if not isinstance(code, str) or DRIVER_CODE_RE.fullmatch(code) is None:
        raise InvalidKeyError(f"driver code must be three capital letters, got {code!r}")
    return code


def validate_lap(lap: object) -> int:
    return _int_in("lap", lap, LAP_MIN, LAP_MAX)


def telemetry_laps_meta_key(season: int, round_: int, driver_code: str) -> str:
    """``meta:telemetry:{season}:{round}:laps:{CODE}`` (additive API cache, outside ``race:*``)."""
    s, r = validate_season(season), validate_round(round_)
    return f"meta:telemetry:{s}:{r}:laps:{validate_driver_code(driver_code)}"


def telemetry_trace_meta_key(season: int, round_: int, driver_code: str, lap: int) -> str:
    """``meta:telemetry:{season}:{round}:trace:{CODE}:{lap}`` (additive API cache)."""
    s, r = validate_season(season), validate_round(round_)
    return f"meta:telemetry:{s}:{r}:trace:{validate_driver_code(driver_code)}:{validate_lap(lap)}"

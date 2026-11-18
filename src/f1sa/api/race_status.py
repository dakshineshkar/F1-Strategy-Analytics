"""The race-status banner (Feature 5, display only): GREEN / SC / VSC / RED FLAG at leader lap N,
from information up to lap N only.

The value is ``engineer.neutral_at``, the same function the engineer view uses:

* with race control in the lake (full mode): the track-status codes of the leader's lap N
  (``clean/analysis_laps``) and the latest key race-control message with lap <= N;
* otherwise (the sample): the causal lap-time estimate over the lap rows <= N (SC and VSC cannot
  be told apart: ``neutralised``), ``unknown`` before there is a green baseline.

Live, the rows are the API's lap log (``GET /api/races/{s}/{r}/status``, ``routes/status.py``);
the post-race archive feeds a ``LapLog`` from the bundle's own messages up to lap N
(``archive/build.py``), so both run the same code. Nothing is written anywhere. The lap event's
``track_neutral`` / ``track_red_flag`` (batch heuristic, hindsight) are never used.
"""

from __future__ import annotations

from collections.abc import Iterable

from f1sa.api.engineer import by_driver, neutral_at
from f1sa.api.lap_log import LapRow
from f1sa.api.models import AnalysisLapsOut, AnalysisRaceControlsOut, RaceStatusOut


def race_status(
    season: int,
    round_: int,
    lap: int,
    rows: Iterable[LapRow],
    laps_doc: AnalysisLapsOut | None,
    rc_doc: AnalysisRaceControlsOut | None,
) -> RaceStatusOut:
    """The banner at leader lap ``lap``; only rows with lap <= ``lap`` and race-control messages
    with lap <= ``lap`` are read."""
    if lap < 1:
        raise ValueError(f"lap must be >= 1, got {lap}")
    neutral, _ = neutral_at(by_driver(rows, lap), lap, laps_doc, rc_doc)
    return RaceStatusOut(
        season=season,
        round=round_,
        lap=lap,
        status=neutral.status,
        source=neutral.source,
        message=neutral.message,
        message_lap=neutral.message_lap,
    )

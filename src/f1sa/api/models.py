"""Pydantic models of the API. ``DriverStateOut`` mirrors the Redis hash contract exactly: the 9
fields of ``serving.keys.DRIVER_FIELDS``, with ``""`` (unknown) as ``null``."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator

from f1sa.serving.redis_store import StoredDriverState, StoredTyreLife

Compound = Literal["SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET", "UNKNOWN"]
UUID_PATTERN = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DriverStateOut(_Out):
    position: int = Field(ge=1)
    gap_ahead_s: float | None
    gap_leader_s: float | None
    tyre_compound: Compound
    tyre_age_laps: int | None
    last_lap_time_s: float | None
    undercut_flag: bool
    undercut_prob: float | None
    updated_at: str = Field(description="ISO-8601 UTC with milliseconds, as stored")

    @classmethod
    def from_stored(cls, stored: StoredDriverState) -> DriverStateOut:
        s = stored.state
        return cls(
            position=s.position,
            gap_ahead_s=s.gap_ahead_s,
            gap_leader_s=s.gap_leader_s,
            tyre_compound=s.tyre_compound,  # type: ignore[arg-type]  # validated by DriverState
            tyre_age_laps=s.tyre_age_laps,
            last_lap_time_s=s.last_lap_time_s,
            undercut_flag=s.undercut_flag,
            undercut_prob=s.undercut_prob,
            updated_at=stored.updated_at,
        )


class TyreLifeOut(_Out):
    """The additive, display-only tyre hash ``race:{s}:{r}:tyre:{driverId}`` (real TracingInsights
    tyre life). Never used by the model, the rule or the what-if."""

    lap: int = Field(ge=1)
    tyre_life_laps: int | None = Field(default=None, ge=1)
    tyre_life_at_start_laps: int | None = Field(default=None, ge=0)
    updated_at: str

    @classmethod
    def from_stored(cls, stored: StoredTyreLife) -> TyreLifeOut:
        t = stored.tyre
        return cls(
            lap=t.lap,
            tyre_life_laps=t.tyre_life_laps,
            tyre_life_at_start_laps=t.tyre_life_at_start_laps,
            updated_at=stored.updated_at,
        )


class OrderEntry(_Out):
    driver_id: str
    position: int


class RaceStateOut(_Out):
    season: int
    round: int
    drivers: dict[str, DriverStateOut]
    order: list[OrderEntry]
    tyres: dict[str, TyreLifeOut] = Field(
        default_factory=dict,
        description="additive, display only: real tyre life per driver (may be missing)",
    )


class RaceOut(_Out):
    season: int
    round: int
    name: str | None
    laps: int
    synthetic: bool = Field(description="tyre/telemetry data of this race is generated (sample)")


class CheckOut(_Out):
    ok: bool
    error: str | None = None


class ModelCheckOut(CheckOut):
    model_version: str
    git_sha: str | None = None
    git_dirty: bool | None = None
    scorer_sha256: str | None = None
    created_utc: str | None = None
    feature_set: str | None = None
    g: float | None = None
    k: int | None = None


class HealthChecks(_Out):
    redis: CheckOut
    kafka: CheckOut
    model: ModelCheckOut


class LakeOut(_Out):
    """Where the races come from. Informational: it never changes the health status."""

    scheme: Literal["file", "hdfs"]
    mode: Literal["sample", "full"] | None = Field(
        description="sample when any listed race is synthetic; null if the clean zone is unreadable"
    )
    synthetic: bool | None


class HealthOut(_Out):
    status: Literal["ok", "degraded"]
    checks: HealthChecks
    lake: LakeOut


class ReplayIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    speed: Literal[1, 10, 60] = Field(description="race-seconds per wall-second")


class ReplayOut(_Out):
    season: int
    round: int
    speed: int
    run_id: str
    results_dir: str
    state: Literal["starting", "running", "finished", "failed"]
    error: str | None
    started_at: str | None
    ended_at: str | None
    stream_returncode: int | None
    producer_returncode: int | None


class ReplayStatusOut(_Out):
    enabled: bool
    max_running: int
    running: list[ReplayOut]
    recent: list[ReplayOut] = Field(description="finished or failed replays, newest first")


class LatencyIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    event_id: str = Field(pattern=UUID_PATTERN)
    ui_rendered_at_ms: StrictInt = Field(gt=0)


class LatencyOut(_Out):
    event_id: str
    event_type: str | None


class ErrorOut(BaseModel):
    detail: str


# ------------------------------------------------------------------ what-if (Step 15)
DRIVER_ID_PATTERN = r"^[a-z0-9_]{1,64}$"
SimCompound = Literal["SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET", "UNKNOWN"]


class WhatIfIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    attacker: str = Field(pattern=DRIVER_ID_PATTERN, description="driverId of the car behind")
    defender: str = Field(
        pattern=DRIVER_ID_PATTERN, description="driverId of the car directly ahead"
    )
    n: StrictInt = Field(default=500, ge=100, le=5000, description="Monte Carlo draws")
    seed: StrictInt = Field(default=42, ge=0, le=2**32 - 1)

    @model_validator(mode="after")
    def _distinct(self) -> WhatIfIn:
        if self.attacker == self.defender:
            raise ValueError("attacker and defender must differ")
        return self


class StrategyOut(_Out):
    strategy: Literal["pit_now", "pit_next_lap", "stay_out"]
    response: Literal["primary", "sensitivity"]
    attacker_pit_lap: int
    defender_pit_lap: int
    evaluation_lap: int = Field(description="the later of the two out-laps")
    feasible: bool
    reason: str | None = Field(description="race_end | no_pit_loss_prior when not feasible")
    p_attacker_ahead: float | None
    expected_gap_s: float | None = Field(description="cum_D - cum_A; positive = attacker ahead")
    interval80_s: tuple[float, float] | None = Field(description="10th and 90th percentile")
    mc_se: float | None
    attacker_new_compound: SimCompound
    defender_new_compound: SimCompound


class CarInputsOut(_Out):
    driver_id: str
    position: int
    compound: SimCompound
    compound_source: str
    tyre_age: int
    new_compound: SimCompound
    pace_laps: int
    noise_source: str
    noise_sd_s: float
    pace_level_s: float
    stop_loss_s: float | None
    stop_delta_s: float | None
    outlap_residual_s: float | None
    tyre_fit_source: str
    tyre_fit_form: str


class WhatIfInputsOut(_Out):
    current_lap: int | None
    decision_lap: int | None
    race_laps: int | None
    gap_s: float
    gap_source: str
    history: str
    traffic_cars: int
    attacker: CarInputsOut
    defender: CarInputsOut
    pit_loss_prior_s: float | None
    pit_loss_source: str | None
    stop_noise_sd_s: float
    synthetic: bool
    warnings: list[str]


class WhatIfModelOut(_Out):
    probability: float | None = Field(description="the stream's calibrated P for the attacker")
    undercut_flag: bool
    model_version: str
    source: Literal["redis:undercut_prob"] = "redis:undercut_prob"


class WhatIfOut(_Out):
    season: int
    round: int
    attacker: str
    defender: str
    n: int
    seed: int
    strategies: list[StrategyOut] = Field(description="defender covers on the next lap")
    sensitivity: list[StrategyOut] = Field(description="defender covers k = 2 laps later")
    model: WhatIfModelOut
    inputs: WhatIfInputsOut
    runtime_ms: float


TEAM_COLOUR_PATTERN = r"^#[0-9A-F]{6}$"
COLOUR_SOURCE_PATTERN = r"^(ti_race|ti_neighbour_round_[1-9][0-9]?|project_palette)$"


class EntrantOut(_Out):
    """One row of the display-only ``clean/entrants`` dimension (``etl.entrants``)."""

    driver_id: str
    code: str | None
    given_name: str | None
    family_name: str | None
    car_number: int | None = Field(default=None, ge=0, description="the number raced in this race")
    grid: int | None = Field(default=None, ge=0, description="starting slot; 0 = pit lane")
    constructor_id: str
    team_name: str = Field(description="display name for that season")
    team_code: str = Field(pattern=r"^[A-Z]{2,3}$", description="short badge code")
    team_lineage_id: str
    team_colour_hex: str = Field(pattern=TEAM_COLOUR_PATTERN)
    team_text_hex: Literal["#000000", "#FFFFFF"] = Field(
        description="badge text colour: black or white, whichever contrasts more (>= 4.5:1)"
    )
    colour_source: str = Field(pattern=COLOUR_SOURCE_PATTERN)
    nationality: str | None
    nationality_code: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")


class EntrantsOut(_Out):
    """``GET /api/races/{s}/{r}/entrants``: the race's entrants sorted by grid (pit-lane starts
    and unknown grid slots last, then car number). Display only."""

    season: int
    round: int
    entrants: list[EntrantOut]


# ------------------------------------------------------------------ race analysis (Feature 2)
KnownCompound = Literal["SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET"]
DRIVER_CODE_PATTERN = r"^[A-Z]{3}$"


class AnalysisCoverageOut(_Out):
    """What the lake holds for this race (``clean/analysis_race``): which views have real data."""

    n_drivers: int = Field(ge=0)
    n_laps: int = Field(ge=0, description="the highest lap number")
    n_lap_rows: int = Field(ge=0)
    tyre_source: Literal["tracinginsights", "synthetic", "none"]
    is_synthetic: bool = Field(description="compounds and tyre ages are SYNTHETIC (sample mode)")
    has_sectors: bool
    has_speed_traps: bool
    deleted_known: bool = Field(description="false: deleted laps are unknown in this lake")
    neutralised_source: Literal["track_status", "heuristic", "mixed"]
    n_race_control: int = Field(ge=0)
    n_pitstops: int = Field(ge=0)
    n_quick_laps: int = Field(ge=0)
    n_ti_only_laps_dropped: int = Field(ge=0)


class AnalysisLapOut(_Out):
    """One Jolpica lap with the TracingInsights detail (``clean/analysis_laps``)."""

    driver_id: str
    driver_code: str | None
    lap: int = Field(ge=1)
    position: int | None = Field(default=None, ge=1)
    lap_time_s: float | None
    cumulative_time_s: float | None
    gap_to_leader_s: float | None
    sector1_s: float | None
    sector2_s: float | None
    sector3_s: float | None
    speed_i1_kph: float | None
    speed_i2_kph: float | None
    speed_fl_kph: float | None
    speed_st_kph: float | None
    stint: int | None = Field(default=None, ge=1)
    compound: KnownCompound | None
    tyre_life_laps: int | None = Field(default=None, ge=0)
    compound_source: Literal["tracinginsights", "synthetic", "none"]
    is_synthetic: bool
    is_pit_in_lap: bool | None
    is_pit_out_lap: bool | None
    is_deleted: bool | None = Field(description="null: unknown in this lake")
    deleted_reason: str | None
    track_status: str | None = Field(description="race-control track-status codes over the lap")
    is_sc_lap: bool | None
    is_vsc_lap: bool | None
    is_red_flag_lap: bool | None
    is_neutralised_lap: bool | None
    neutralised_source: Literal["track_status", "heuristic"]
    is_quick_lap: bool
    quick_lap_exclusion: (
        Literal["no_time", "lap_1", "pit_in", "pit_out", "neutralised", "deleted", "slow_107"]
        | None
    )


class AnalysisStintOut(_Out):
    """One stint with its lap-time-vs-tyre-life fit over quick laps (a proxy, not tyre wear)."""

    driver_id: str
    driver_code: str | None
    stint: int = Field(ge=1)
    compound: KnownCompound | None
    start_lap: int = Field(ge=1)
    end_lap: int = Field(ge=1)
    laps: int = Field(ge=1)
    tyre_life_start: int | None
    tyre_life_end: int | None
    used_set: bool | None
    ends_in_pit: bool
    n_quick_laps: int = Field(ge=0)
    deg_slope_s_per_lap: float | None
    deg_intercept_s: float | None
    median_quick_lap_s: float | None
    fit_status: Literal["ok", "too_few_laps", "no_tyre_life"]
    compound_source: Literal["tracinginsights", "synthetic", "none"]
    is_synthetic: bool


class AnalysisPitStopOut(_Out):
    """One Jolpica pit stop (``duration_s`` = pit-lane time) with the laps around it."""

    driver_id: str
    driver_code: str | None
    stop: int = Field(ge=1)
    lap: int = Field(ge=1)
    time_of_day: str | None
    duration_s: float | None
    is_long_stop: bool | None
    under_neutralisation: bool | None
    compound_before: KnownCompound | None
    compound_after: KnownCompound | None
    tyre_life_before: int | None
    position_before: int | None
    position_after: int | None


class AnalysisRaceControlOut(_Out):
    """One race-control message with its ``kind`` (SC, VSC, red flag and penalties are key)."""

    seq: int = Field(ge=0)
    lap: int | None
    time_utc: str | None
    category: str | None
    message: str | None
    status: str | None
    flag: str | None
    scope: str | None
    driver_id: str | None
    driver_code: str | None
    kind: Literal[
        "sc_deployed",
        "sc_ending",
        "vsc_deployed",
        "vsc_ending",
        "red_flag",
        "penalty",
        "investigation",
        "track_limits",
        "chequered",
        "other",
    ]
    is_key: bool


class _AnalysisOut(_Out):
    season: int
    round: int
    coverage: AnalysisCoverageOut


class AnalysisLapsOut(_AnalysisOut):
    """``GET …/analysis/laps``: every lap of every driver (driver, then lap)."""

    rows: list[AnalysisLapOut]


class AnalysisStintsOut(_AnalysisOut):
    """``GET …/analysis/stints``."""

    rows: list[AnalysisStintOut]


class AnalysisPitStopsOut(_AnalysisOut):
    """``GET …/analysis/pitstops`` (by lap)."""

    rows: list[AnalysisPitStopOut]


class AnalysisRaceControlsOut(_AnalysisOut):
    """``GET …/analysis/race-control`` (message order); empty when the lake has none."""

    rows: list[AnalysisRaceControlOut]


class PositionPointOut(_Out):
    lap: int = Field(ge=1)
    position: int = Field(ge=1)


class PositionSeriesOut(_Out):
    driver_id: str
    driver_code: str | None
    grid: int | None = Field(default=None, ge=0, description="starting slot; 0 = pit lane")
    positions: list[PositionPointOut]


class PositionsOut(_AnalysisOut):
    """``GET …/analysis/positions``: one series per driver, in finishing order."""

    rows: list[PositionSeriesOut]


class CompareDriverOut(_Out):
    driver_id: str
    driver_code: str = Field(pattern=DRIVER_CODE_PATTERN)


class CompareLapOut(_Out):
    """One lap of ``a`` vs ``b``: deltas are ``a - b`` (negative = ``a`` faster)."""

    lap: int = Field(ge=1)
    a_lap_time_s: float | None
    b_lap_time_s: float | None
    delta_s: float | None
    gap_s: float | None = Field(description="cumulative time a - b at this lap (+ = a behind)")
    sector1_delta_s: float | None
    sector2_delta_s: float | None
    sector3_delta_s: float | None
    a_position: int | None
    b_position: int | None
    a_compound: KnownCompound | None
    b_compound: KnownCompound | None
    a_pit: bool
    b_pit: bool
    neutralised: bool


class CompareOut(_AnalysisOut):
    """``GET …/analysis/compare?a=CODE&b=CODE``."""

    a: CompareDriverOut
    b: CompareDriverOut
    rows: list[CompareLapOut]

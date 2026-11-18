"""Pydantic models of the API. ``DriverStateOut`` mirrors the Redis hash contract exactly: the 9
fields of ``serving.keys.DRIVER_FIELDS``, with ``""`` (unknown) as ``null``."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator

from f1sa.serving.redis_store import StoredDriverState, StoredTiming, StoredTyreLife

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


class TimingOut(_Out):
    """The additive, display-only timing hash ``race:{s}:{r}:timing:{driverId}`` (Feature 5): the
    sector times and speed trap of the car's lap ``lap``, the driver's best so far over its laps
    <= ``lap`` and its stop count. Never used by the model, the rule or the what-if."""

    lap: int = Field(ge=1)
    sector1_s: float | None = Field(default=None, gt=0)
    sector2_s: float | None = Field(default=None, gt=0)
    sector3_s: float | None = Field(default=None, gt=0)
    speed_trap_kph: float | None = Field(default=None, gt=0)
    pb_sector1_s: float | None = Field(default=None, gt=0)
    pb_sector2_s: float | None = Field(default=None, gt=0)
    pb_sector3_s: float | None = Field(default=None, gt=0)
    pb_speed_trap_kph: float | None = Field(default=None, gt=0)
    pit_stops: int | None = Field(default=None, ge=0)
    updated_at: str

    @classmethod
    def from_stored(cls, stored: StoredTiming) -> TimingOut:
        t = stored.timing
        return cls(
            lap=t.lap,
            sector1_s=t.sector1_s,
            sector2_s=t.sector2_s,
            sector3_s=t.sector3_s,
            speed_trap_kph=t.speed_trap_kph,
            pb_sector1_s=t.pb_sector1_s,
            pb_sector2_s=t.pb_sector2_s,
            pb_sector3_s=t.pb_sector3_s,
            pb_speed_trap_kph=t.pb_speed_trap_kph,
            pit_stops=t.pit_stops,
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
    timing: dict[str, TimingOut] = Field(
        default_factory=dict,
        description="additive, display only (Feature 5): sectors, speed trap, bests so far and "
        "stop count per driver (may be missing)",
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


class ReplaySpeedIn(BaseModel):
    """``POST /api/races/{s}/{r}/replay/speed`` (Feature 7)."""

    model_config = ConfigDict(extra="forbid")
    speed: Literal[1, 10, 60] = Field(description="the new race-seconds per wall-second")


class ReplayOut(_Out):
    season: int
    round: int
    speed: int = Field(description="the speed in force (the latest one set)")
    run_id: str
    results_dir: str
    state: Literal["starting", "running", "paused", "stopped", "finished", "failed"]
    paused: bool = Field(description="paused by request (it can be set while still starting)")
    lap: int | None = Field(description="the highest lap of a lap event the producer has sent")
    events_sent: int | None = Field(description="events the producer has sent so far")
    error: str | None
    note: str | None = Field(description="why a replay was stopped without a request")
    started_at: str | None
    running_at: str | None = Field(description="when the producer was started")
    paused_at: str | None = Field(description="when the current pause began")
    updated_at: str | None = Field(description="the latest control change (start, speed, pause)")
    ended_at: str | None
    stream_returncode: int | None
    producer_returncode: int | None


class ReplayStatusOut(_Out):
    enabled: bool
    max_running: int
    running: list[ReplayOut]
    recent: list[ReplayOut] = Field(description="finished, stopped or failed replays, newest first")


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


# ------------------------------------------------------------------ engineer view (Feature 3)
NeutralStatus = Literal["green", "sc", "vsc", "red", "neutralised", "unknown"]


class RaceStatusOut(_Out):
    """The race status at leader lap N (Feature 5 banner, display only), from information up to
    lap N only: ``track_status`` (the lake's track-status codes of the leader's lap N and the latest
    key race-control message with lap <= N) or ``estimated`` (the causal lap-time rule of the
    engineer view; SC and VSC cannot be told apart: ``neutralised``)."""

    season: int
    round: int
    lap: int = Field(ge=1)
    status: NeutralStatus
    source: Literal["track_status", "estimated", "none"]
    message: str | None = Field(description="latest key race-control message with lap <= N")
    message_lap: int | None


class EngineerNeutralOut(_Out):
    """Track status at lap N: ``track_status`` (the lake's race-control codes), ``estimated`` (a
    causal lap-time rule; SC and VSC cannot be told apart: ``neutralised``) or ``none``."""

    status: NeutralStatus
    source: Literal["track_status", "estimated", "none"]
    message: str | None = Field(description="latest key race-control message with lap <= N")
    message_lap: int | None


class TypicalStintOut(_Out):
    """Median completed-stint length on the compound in strictly earlier races."""

    compound: KnownCompound | None
    median_laps: float | None
    n_stints: int = Field(ge=0)
    n_races: int = Field(ge=0)
    source: Literal["circuit", "all_circuits", "none"]
    is_synthetic: bool


class EngineerCarOut(_Out):
    driver_id: str
    driver_code: str | None
    position: int = Field(ge=1, description="order by race time at lap N")
    lap: int = Field(ge=1, description="the car's latest recorded lap <= N")
    projected: bool = Field(description="lap N not completed yet: time projected from lap N-1")
    compound: KnownCompound | None
    tyre_life_laps: int | None
    tyre_life_source: Literal["real", "estimated", "none"]
    tyre_life_delta_laps: int | None = Field(description="this car minus the focus")
    stint_laps: int | None
    typical_stint: TypicalStintOut
    pace_last3_s: float | None
    pace_delta_s: float | None = Field(description="this car minus the focus (+ = slower)")
    last_lap_time_s: float | None
    in_pit: bool
    undercut_flag: bool | None
    undercut_prob: float | None = Field(
        description="the stream's value for this car against the car then directly ahead"
    )
    prob_recorded: bool


class GapPointOut(_Out):
    lap: int = Field(ge=1)
    gap_s: float


class EngineerPairOut(_Out):
    """A front/rear pair: gap = rear - front at lap N; trend < 0 = the rear car is closing."""

    front_id: str
    rear_id: str
    gap_s: float
    projected: bool
    trend_s_per_lap: float | None
    trend_laps: int = Field(ge=0)
    gaps: list[GapPointOut]
    prob: float | None = Field(description="the rear car's undercut probability (stream)")
    prob_role: Literal["focus_on_ahead", "threat"]
    prob_recorded: bool
    pair_matches: bool | None = Field(
        description="the front car was directly ahead of the rear car at lap N-1"
    )


class RejoinCarOut(_Out):
    driver_id: str
    gap_s: float = Field(description="race time at lap N minus the focus's")
    projected: bool


class EngineerRejoinOut(_Out):
    """If the focus pits now: lap-N time + pit-loss prior among the field (display estimate)."""

    pit_loss_s: float | None
    pit_loss_source: Literal["circuit_prior", "global_prior", "none"]
    pit_loss_text: str
    position: int | None
    ahead_id: str | None
    behind_id: str | None
    gap_ahead_s: float | None
    gap_behind_s: float | None
    in_traffic: bool | None
    reliable: bool
    reasons: list[str]
    field: list[RejoinCarOut]
    left_out: int = Field(ge=0, description="cars further back (lapped) or retired, not placed")


class EngineerCallOut(_Out):
    id: Literal[
        "undercut_window",
        "threat",
        "closing",
        "being_caught",
        "rejoin",
        "tyre_offset",
        "long_stint",
    ]
    severity: Literal["info", "warn"]
    text: str


class EngineerOut(_Out):
    """``GET …/engineer/{driverId}?lap=N``: the focus car against the cars directly ahead and
    behind, from information up to lap N only. Display only."""

    season: int
    round: int
    lap: int
    current_lap: int
    history_from_lap: int
    focus_id: str
    neutralised: EngineerNeutralOut
    ahead: EngineerCarOut | None
    focus: EngineerCarOut
    behind: EngineerCarOut | None
    pair_ahead: EngineerPairOut | None
    pair_behind: EngineerPairOut | None
    rejoin: EngineerRejoinOut
    calls: list[EngineerCallOut]
    disclaimer: str


# ------------------------------------------------------------------ post-race archive (Feature 4)
class ArchiveRaceOut(_Out):
    """One race of ``GET /api/archive`` (from its ``_manifest.json``)."""

    season: int
    round: int
    race_name: str | None
    laps: int = Field(ge=1)
    synthetic: bool
    schema_version: int
    model_version: str
    scorer_sha256: str
    sha256: str = Field(description="of the stored bundle.json.gz (the bundle's ETag)")
    size_bytes: int = Field(ge=1, description="bundle.json.gz")
    raw_bytes: int = Field(ge=1, description="the bundle's JSON before gzip")


class ArchiveListOut(_Out):
    """``GET /api/archive``: every race with a post-race bundle (season, round order)."""

    races: list[ArchiveRaceOut]


# ------------------------------------------------------------------ telemetry traces (Feature 6)
TelemetryCoverage = Literal["full", "partial"]
TelemetrySource = Literal["tracinginsights", "synthetic"]


class TelemetryLapOut(_Out):
    """One lap's trace summary (``clean/telemetry_trace``; the lap columns from analysis_laps)."""

    lap: int = Field(ge=1)
    lap_time_s: float | None = Field(description="the official lap time (null if unknown)")
    trace_time_s: float = Field(ge=0, description="elapsed time at the end of the trace")
    lap_length_m: float = Field(gt=0, description="the lap's integrated distance")
    n_samples: int = Field(ge=0)
    max_gap_s: float = Field(ge=0)
    coverage: TelemetryCoverage
    is_pit_in_lap: bool | None
    is_pit_out_lap: bool | None
    is_deleted: bool | None
    is_neutralised_lap: bool | None
    is_red_flag_lap: bool | None
    compound: KnownCompound | None
    tyre_life_laps: int | None
    top_speed_kph: float | None
    top_speed_at_m: float | None
    min_corner_speed_kph: float | None
    min_corner_at_m: float | None
    full_throttle_share: float | None = Field(ge=0, le=1)
    brake_share: float = Field(ge=0, le=1)
    drs_share: float = Field(ge=0, le=1)
    n_braking_zones: int = Field(ge=0)


class _TelemetryDriverOut(_Out):
    season: int
    round: int
    driver_id: str
    driver_code: str = Field(pattern=DRIVER_CODE_PATTERN)
    is_synthetic: bool = Field(description="SYNTHETIC fixture samples (sample mode), not real")
    source: TelemetrySource
    grid_step_m: float = Field(gt=0)


class TelemetryLapsOut(_TelemetryDriverOut):
    """``GET …/telemetry/laps?driver=CODE``: the laps with a trace, in lap order."""

    fastest_lap: int | None = Field(
        description="the default lap: fastest lap time among full-coverage laps that are not "
        "deleted, pit-in or pit-out laps (else the fastest trace time; null if none)"
    )
    rows: list[TelemetryLapOut]


class TelemetryTraceOut(_TelemetryDriverOut):
    """One lap on its own distance grid (cached per lap; the input of the compare)."""

    summary: TelemetryLapOut
    distance_m: list[float]
    elapsed_s: list[float]
    speed_kph: list[float]
    throttle_pct: list[float]
    rpm: list[float]
    brake: list[int]
    n_gear: list[int]
    drs: list[int]
    braking_start_m: list[float]
    braking_end_m: list[float]
    braking_apex_kph: list[float]

    @model_validator(mode="after")
    def _arrays(self) -> TelemetryTraceOut:
        n = len(self.distance_m)
        lanes = (
            self.elapsed_s,
            self.speed_kph,
            self.throttle_pct,
            self.rpm,
            self.brake,
            self.n_gear,
            self.drs,
        )
        if n < 2 or any(len(v) != n for v in lanes):
            raise ValueError("trace arrays must have one equal length of at least 2")
        if any(b <= a for a, b in zip(self.distance_m, self.distance_m[1:], strict=False)):
            raise ValueError("trace distances must increase")
        zones = (self.braking_start_m, self.braking_end_m, self.braking_apex_kph)
        if any(len(z) != len(self.braking_start_m) for z in zones):
            raise ValueError("braking-zone arrays must have one equal length")
        return self


class TelemetryCarOut(_Out):
    """One car of the compare, on the common axis (``distance_m`` of the compare)."""

    driver_id: str
    driver_code: str = Field(pattern=DRIVER_CODE_PATTERN)
    lap: int = Field(ge=1)
    summary: TelemetryLapOut
    own_distance_m: list[float] = Field(description="the car's own lap distance at each point")
    elapsed_s: list[float]
    speed_kph: list[float]
    throttle_pct: list[float]
    rpm: list[float]
    brake: list[int]
    n_gear: list[int]
    drs: list[int]
    braking_start_m: list[float] = Field(description="on the common axis")
    braking_end_m: list[float] = Field(description="on the common axis")
    braking_apex_kph: list[float]


class TelemetrySegmentOut(_Out):
    """A mini-sector of the common axis: how the delta changed over it (+ = a lost time)."""

    index: int = Field(ge=0)
    start_m: float
    end_m: float
    delta_change_s: float


class TelemetryCompareOut(_Out):
    """``GET …/telemetry/compare?a=&alap=&b=&blap=``: both laps on ``a``'s distance grid, read
    at the same fraction of each lap; ``delta_s`` = elapsed ``a`` - elapsed ``b`` (+ = ``a``
    behind)."""

    season: int
    round: int
    is_synthetic: bool
    grid_step_m: float = Field(gt=0)
    distance_m: list[float]
    a: TelemetryCarOut
    b: TelemetryCarOut
    delta_s: list[float]
    segments: list[TelemetrySegmentOut]
    final_delta_s: float
    lap_time_delta_s: float | None = Field(description="official lap time a - b, if both known")

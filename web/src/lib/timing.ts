/** Feature 5 timing-tower values (display only): the sector times and speed trap of a car's lap,
 * its best so far over its own laps up to that lap (computed causally by the producer) and its stop
 * count. They arrive on the ``lap`` payload and in the additive Redis hash
 * ``race:{s}:{r}:timing:{driverId}`` (the snapshot's ``timing`` map). Never part of the 9-field
 * driver hash, never read by the model. */

import { isFiniteNumber, isInt, isObj, type Obj } from "./guard";

export type Triple = readonly [number | null, number | null, number | null];

export interface TimingValues {
  /** S1, S2, S3 of the lap (null when unknown, e.g. the sample, or lap 1 without S1). */
  sectors: Triple;
  /** The driver's best S1, S2, S3 so far (minimum over its laps up to this one). */
  pbSectors: Triple;
  speedTrapKph: number | null;
  /** The driver's best speed trap so far (maximum). */
  pbSpeedTrapKph: number | null;
  /** Stops with in-lap up to this lap (Jolpica); null when the payload has no count. */
  pitStops: number | null;
}

/** The snapshot's timing hash of one car: the values of its lap ``lap``. */
export interface TimingHash extends TimingValues {
  lap: number;
}

export const NO_TIMING: TimingValues = {
  sectors: [null, null, null],
  pbSectors: [null, null, null],
  speedTrapKph: null,
  pbSpeedTrapKph: null,
  pitStops: null,
};

const positive = (v: unknown): number | null => (isFiniteNumber(v) && v > 0 ? v : null);

/** Display-only parsing: an invalid value means unknown, never a dropped lap or snapshot. */
export function parseTimingValues(v: Obj): TimingValues {
  return {
    sectors: [positive(v.sector1_s), positive(v.sector2_s), positive(v.sector3_s)],
    pbSectors: [positive(v.pb_sector1_s), positive(v.pb_sector2_s), positive(v.pb_sector3_s)],
    speedTrapKph: positive(v.speed_trap_kph),
    pbSpeedTrapKph: positive(v.pb_speed_trap_kph),
    pitStops: isInt(v.pit_stops) && v.pit_stops >= 0 ? v.pit_stops : null,
  };
}

/** One entry of the snapshot's ``timing`` map; undefined (dropped) without a valid lap. */
export function toTimingHash(v: unknown): TimingHash | undefined {
  if (!isObj(v) || !isInt(v.lap) || v.lap < 1) return undefined;
  return { lap: v.lap, ...parseTimingValues(v) };
}

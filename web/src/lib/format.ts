/** Display formatting. ``—`` (em dash) always means "unknown". */

export const DASH = "—";

/** ``max_verstappen`` → ``Verstappen``; ``de_vries`` → ``De Vries``. */
export function driverName(id: string): string {
  const parts = id.split("_").filter(Boolean);
  const surname = parts.length > 2 || parts[0] === "de" || parts[0] === "van" ? parts : parts.slice(-1);
  return surname.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ") || id;
}

/** Three-letter timing-screen code from the surname: ``max_verstappen`` → ``VER``. */
export function driverCode(id: string): string {
  const name = driverName(id).replace(/\s+/g, "");
  return name.slice(0, 3).toUpperCase().padEnd(3, "·");
}

export function gap(seconds: number | null): string {
  if (seconds === null) return DASH;
  if (seconds === 0) return "Leader";
  return `+${seconds.toFixed(3)}`;
}

/** A tower gap (interval or gap to the leader): "Leader" only for P1. A car that is not P1 with a gap of 0 (it was
 * measured on a lap the car led, or not measured: a pit lap) shows a dash, never "Leader" (Step 5, finding 7). */
export function towerGap(position: number | null, seconds: number | null): string {
  if (position === 1) return "Leader";
  if (seconds === null || seconds === 0) return DASH;
  return `+${seconds.toFixed(3)}`;
}

/** The tower's gap of 0 on a car that is not P1: shown as a dash, with this reason. */
export const ZERO_GAP_TEXT = "not measured at this lap";

export function lapTime(seconds: number | null): string {
  if (seconds === null || seconds < 0) return DASH;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  const secs = rest.toFixed(3).padStart(6, "0");
  return minutes > 0 ? `${minutes}:${secs}` : rest.toFixed(3);
}

/** A lap-time axis tick: ``lapTime`` without a zero fraction ("1:52", "1:52.5"), so the axis stays recessive. */
export function lapTick(seconds: number): string {
  return lapTime(seconds).replace(/\.?0+$/, "");
}

export function probability(p: number | null): string {
  if (p === null) return DASH;
  return `${Math.round(p * 100)}%`;
}

export function laps(n: number | null): string {
  return n === null ? DASH : String(n);
}

"use client";

/** Replay status from ``GET /api/replays`` (every 1 s while a replay is active, else every 5 s)
 * and the actions: start, and (Feature 7) stop, pause, resume and a speed change. One action is
 * in flight at a time (``pending``); errors become one human-readable message. */

import { useCallback, useEffect, useState } from "react";

import { api, type Replay, type ReplayStatus } from "./api";
import { replayFor, replayMessage, type Speed } from "./replays";

export type { Speed } from "./replays";

export function useReplays(season: number, round: number) {
  const [status, setStatus] = useState<ReplayStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.replays());
    } catch (err) {
      setError(replayMessage(err));
    }
  }, []);

  // ``running`` lists starting, running and paused replays: poll fast while any is there
  const running = (status?.running.length ?? 0) > 0;
  useEffect(() => {
    let alive = true;
    const poll = () => {
      api
        .replays()
        .then((s) => {
          if (alive) setStatus(s);
        })
        .catch((err: unknown) => {
          if (alive) setError(replayMessage(err));
        });
    };
    poll();
    const id = setInterval(poll, running || pending ? 1000 : 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [running, pending]);

  const act = useCallback(
    async (call: () => Promise<Replay>) => {
      setPending(true);
      setError(null);
      try {
        await call();
      } catch (err) {
        setError(replayMessage(err));
      } finally {
        await refresh();
        setPending(false);
      }
    },
    [refresh],
  );

  const start = useCallback((speed: Speed) => act(() => api.startReplay(season, round, speed)), [act, season, round]);
  const stop = useCallback(() => act(() => api.stopReplay(season, round)), [act, season, round]);
  const pause = useCallback(() => act(() => api.pauseReplay(season, round)), [act, season, round]);
  const resume = useCallback(() => act(() => api.resumeReplay(season, round)), [act, season, round]);
  const setSpeed = useCallback(
    (speed: Speed) => act(() => api.setReplaySpeed(season, round, speed)),
    [act, season, round],
  );

  return { status, error, pending, start, stop, pause, resume, setSpeed, current: replayFor(status, season, round) };
}

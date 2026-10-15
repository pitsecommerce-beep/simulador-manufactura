import { createPlayback, type EventLog, type PlaybackFrame } from '@sim/domain';
import { useEffect, useMemo, useRef, useState } from 'react';

export const SPEEDS = [1, 5, 20, 60, 120] as const;

/** Reloj del reproductor: avanza el tiempo de simulación con requestAnimationFrame. */
export function usePlayer(log: EventLog | null) {
  const [t, setT] = useState(log?.start_s ?? 0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(20);
  const playback = useMemo(() => (log ? createPlayback(log) : null), [log]);
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  useEffect(() => {
    if (!playing || !log) return;
    let raf = 0;
    let prev = performance.now();
    const tick = (now: number) => {
      const next = Math.min(log.end_s, tRef.current + ((now - prev) / 1000) * speed);
      prev = now;
      setT(next);
      if (next >= log.end_s) setPlaying(false);
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, log]);

  const frame: PlaybackFrame | null = useMemo(
    () => (playback ? playback.seek(t) : null),
    [playback, t],
  );
  return { t, setT, playing, setPlaying, speed, setSpeed, frame };
}

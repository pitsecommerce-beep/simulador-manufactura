import { useCallback, useEffect, useRef, useState } from 'react';

export const SPEEDS = [0.5, 1, 5, 20, 60, 120] as const;

/**
 * Reloj de la reproducción. El tiempo vive en una referencia que el lienzo lee en cada cuadro;
 * React solo recibe el tiempo unas 10 veces por segundo (barra y paneles), así la animación no
 * vuelve a dibujar todo el editor en cada cuadro.
 */
export function useClock(range: { start: number; end: number } | null) {
  const tRef = useRef(range?.start ?? 0);
  const [t, setUiT] = useState(range?.start ?? 0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(5);

  const seek = useCallback((next: number) => {
    tRef.current = next;
    setUiT(next);
  }, []);

  useEffect(() => {
    if (!playing || !range) return;
    let raf = 0;
    let prev = performance.now();
    let lastUi = 0;
    const tick = (now: number) => {
      const next = Math.min(range.end, tRef.current + ((now - prev) / 1000) * speed);
      prev = now;
      tRef.current = next;
      if (now - lastUi > 100 || next >= range.end) {
        lastUi = now;
        setUiT(next);
      }
      if (next >= range.end) setPlaying(false);
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, range]);

  return { tRef, t, seek, playing, setPlaying, speed, setSpeed };
}

export type Clock = ReturnType<typeof useClock>;

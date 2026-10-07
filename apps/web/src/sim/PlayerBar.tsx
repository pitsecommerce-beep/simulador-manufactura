import type { EventLog } from '@sim/domain';
import { clock, STATE_COLOR, STATE_LABEL } from './format';
import { SPEEDS } from './usePlayer';

export function PlayerBar({
  log,
  name,
  t,
  playing,
  speed,
  onSeek,
  onToggle,
  onSpeed,
  onClose,
}: {
  log: EventLog;
  name: string;
  t: number;
  playing: boolean;
  speed: number;
  onSeek: (t: number) => void;
  onToggle: () => void;
  onSpeed: (s: number) => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute inset-x-2 bottom-2 space-y-1.5 rounded-xl bg-white/95 p-2.5 shadow-md">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          className="btn btn-primary px-3 py-1"
          onClick={onToggle}
          aria-label={playing ? 'Pausar' : 'Reproducir'}
        >
          {playing ? '❚❚ Pausar' : '▶ Reproducir'}
        </button>
        <label className="flex items-center gap-1 text-slate-600">
          Velocidad
          <select
            className="input w-auto px-2 py-0.5 text-xs"
            value={speed}
            onChange={(e) => onSpeed(Number(e.target.value))}
          >
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
        <span className="font-mono text-slate-700 tabular-nums">t = {clock(t)}</span>
        <span className="truncate text-slate-500">
          {name} · réplica {log.replication + 1}
          {log.truncated && ' · registro recortado'}
        </span>
        <ul className="ml-auto flex gap-2">
          {(['busy', 'blocked', 'idle', 'failed'] as const).map((s) => (
            <li key={s} className="flex items-center gap-1 text-slate-600">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: STATE_COLOR[s] }} />
              {STATE_LABEL[s]}
            </li>
          ))}
        </ul>
        <button className="btn btn-ghost px-2 py-1" onClick={onClose}>
          Salir
        </button>
      </div>
      <input
        type="range"
        aria-label="Tiempo de simulación"
        className="w-full accent-brand-600"
        min={log.start_s}
        max={log.end_s}
        step={0.5}
        value={t}
        onChange={(e) => onSeek(Number(e.target.value))}
      />
    </div>
  );
}

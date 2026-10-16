import {
  axisState,
  sampleIndex,
  telemetryCsv,
  type MotionPhase,
  type RobotTelemetry,
  type StationState,
  type TelemetryEvent,
} from '@sim/domain';
import { useMemo, useState } from 'react';
import type { AnimationData } from './animation';
import { clock, STATE_COLOR } from './format';

// Telemetría del robot (PLAN 24.11): pistas de fase, garra y estado, una gráfica por eje con
// el valor comandado (punteado) y el ejecutado (continuo), eventos y exportación CSV.

const EXEC = '#2563eb';
const CMD = '#ea580c';
const W = 600;

const PHASE_COLOR: Record<MotionPhase, string> = {
  reposo: '#e2e8f0',
  'bajando a recoger': '#a5b4fc',
  subiendo: '#c4b5fd',
  trasladando: '#60a5fa',
  'bajando a entregar': '#818cf8',
  'esperando destino': '#f59e0b',
  regresando: '#93c5fd',
  'sin alcance': '#fca5a5',
};

const fmt = (v: number, digits = 1) =>
  v.toLocaleString('es-MX', { maximumFractionDigits: digits, minimumFractionDigits: digits });

/** Puntos de una serie entre dos índices, reducidos a mínimo y máximo por columna. */
function path(
  t: number[],
  values: number[],
  i0: number,
  i1: number,
  t0: number,
  t1: number,
  lo: number,
  hi: number,
  h: number,
): string {
  const span = Math.max(1e-9, t1 - t0);
  const range = Math.max(1e-9, hi - lo);
  const y = (v: number) => h - 2 - ((v - lo) / range) * (h - 4);
  const step = Math.max(1, Math.floor((i1 - i0) / (W * 0.5)));
  const pts: string[] = [];
  for (let i = i0; i <= i1; i += step) {
    let mn = Infinity;
    let mx = -Infinity;
    for (let k = i; k < Math.min(i1 + 1, i + step); k++) {
      mn = Math.min(mn, values[k]!);
      mx = Math.max(mx, values[k]!);
    }
    const x = ((t[i]! - t0) / span) * W;
    pts.push(`${x.toFixed(1)},${y(mn).toFixed(1)}`);
    if (mx !== mn) pts.push(`${x.toFixed(1)},${y(mx).toFixed(1)}`);
  }
  return pts.join(' ');
}

function SignalRow({
  label,
  range,
  t,
  series,
  i0,
  i1,
  t0,
  t1,
  now,
  values,
  onSeek,
  bounds,
}: {
  label: string;
  range: string;
  t: number[];
  series: { values: number[]; color: string; dashed?: boolean }[];
  i0: number;
  i1: number;
  t0: number;
  t1: number;
  now: number;
  values: { text: string; color: string }[];
  onSeek: (t: number) => void;
  /** Límites del eje en la gráfica (rango de la ficha si existe). */
  bounds: [number, number] | null;
}) {
  const h = 34;
  let lo = bounds ? bounds[0] : Infinity;
  let hi = bounds ? bounds[1] : -Infinity;
  if (!bounds)
    for (const s of series)
      for (let k = i0; k <= i1; k++) {
        lo = Math.min(lo, s.values[k]!);
        hi = Math.max(hi, s.values[k]!);
      }
  if (!Number.isFinite(lo)) [lo, hi] = [0, 1];
  const pad = (hi - lo) * 0.05 || 1;
  const x = ((now - t0) / Math.max(1e-9, t1 - t0)) * W;
  return (
    <div className="grid grid-cols-[9rem_minmax(0,1fr)_4.5rem] items-center gap-3 border-t border-slate-100 py-1.5">
      <div className="min-w-0">
        <p className="truncate font-mono text-xs text-slate-800">{label}</p>
        <p className="font-mono text-[11px] text-slate-400">{range}</p>
      </div>
      <svg
        viewBox={`0 0 ${W} ${h}`}
        preserveAspectRatio="none"
        className="h-9 w-full cursor-crosshair"
        role="img"
        aria-label={`Gráfica de ${label}`}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onSeek(t0 + ((e.clientX - r.left) / r.width) * (t1 - t0));
        }}
      >
        {series.map((s, k) => (
          <polyline
            key={k}
            points={path(t, s.values, i0, i1, t0, t1, lo - pad, hi + pad, h)}
            fill="none"
            stroke={s.color}
            strokeWidth={1.6}
            strokeDasharray={s.dashed ? '4 3' : undefined}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {x >= 0 && x <= W && (
          <line x1={x} x2={x} y1={0} y2={h} stroke="#94a3b8" vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      <div className="text-right font-mono text-xs tabular-nums">
        {values.map((v, k) => (
          <p key={k} style={{ color: v.color }}>
            {v.text}
          </p>
        ))}
      </div>
    </div>
  );
}

/** Pista de bloques de colores (fase, garra o estado de la estación). */
function Track({
  label,
  blocks,
  t0,
  t1,
  now,
  onSeek,
}: {
  label: string;
  blocks: { from: number; to: number; color: string; title: string }[];
  t0: number;
  t1: number;
  now: number;
  onSeek: (t: number) => void;
}) {
  const span = Math.max(1e-9, t1 - t0);
  const x = (v: number) => ((v - t0) / span) * W;
  return (
    <div className="grid grid-cols-[9rem_minmax(0,1fr)_4.5rem] items-center gap-3 py-0.5">
      <p className="text-xs text-slate-600">{label}</p>
      <svg
        viewBox={`0 0 ${W} 12`}
        preserveAspectRatio="none"
        className="h-3 w-full cursor-crosshair rounded"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onSeek(t0 + ((e.clientX - r.left) / r.width) * span);
        }}
      >
        {blocks
          .filter((b) => b.to >= t0 && b.from <= t1)
          .map((b, k) => (
            <rect
              key={k}
              x={Math.max(0, x(b.from))}
              width={Math.max(0.5, Math.min(W, x(b.to)) - Math.max(0, x(b.from)))}
              y={0}
              height={12}
              fill={b.color}
            >
              <title>{b.title}</title>
            </rect>
          ))}
        <line
          x1={x(now)}
          x2={x(now)}
          y1={0}
          y2={12}
          stroke="#0f172a"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span />
    </div>
  );
}

/** Convierte una serie por muestra en bloques contiguos. */
function runs<T>(t: number[], values: T[], color: (v: T) => string, title: (v: T) => string) {
  const out: { from: number; to: number; color: string; title: string }[] = [];
  let start = 0;
  for (let i = 1; i <= values.length; i++) {
    if (i === values.length || values[i] !== values[start]) {
      out.push({
        from: t[start]!,
        to: t[Math.min(i, t.length - 1)]!,
        color: color(values[start]!),
        title: title(values[start]!),
      });
      start = i;
    }
  }
  return out;
}

const EVENT_FILTERS: { key: TelemetryEvent['kind'] | 'all'; label: string }[] = [
  { key: 'all', label: 'Todos' },
  { key: 'grip', label: 'Garra' },
  { key: 'phase', label: 'Fases' },
  { key: 'axis_limit', label: 'Topes' },
  { key: 'overspeed', label: 'Sobrevelocidad' },
];

export function TelemetryPanel({
  data,
  t,
  onSeek,
}: {
  data: AnimationData;
  t: number;
  onSeek: (t: number) => void;
}) {
  const robots = [...data.plans.keys()].map((id) => ({
    id,
    name: data.tl.objects.get(id)?.name ?? id,
  }));
  const [robotId, setRobotId] = useState(robots[0]?.id ?? null);
  const [showAll, setShowAll] = useState(false);
  const [mode, setMode] = useState<'position' | 'velocity'>('position');
  const [zoom, setZoom] = useState<'window' | 'all'>('window');
  const [filter, setFilter] = useState<(typeof EVENT_FILTERS)[number]['key']>('grip');
  const tel: RobotTelemetry | null = useMemo(
    () => (robotId ? data.telemetry(robotId) : null),
    [data, robotId],
  );
  const stationBlocks = useMemo(() => {
    if (!robotId) return [];
    const ev = data.tl.log.events.filter(
      (e): e is [number, 'st', string, StationState] => e[1] === 'st' && e[2] === robotId,
    );
    return ev.map((e, i) => ({
      from: e[0],
      to: ev[i + 1]?.[0] ?? data.tl.log.end_s,
      color: STATE_COLOR[e[3]],
      title: e[3],
    }));
  }, [data, robotId]);

  if (!robots.length)
    return (
      <p className="text-sm text-slate-500">
        Ningún robot es estación del proceso: no hay movimientos que registrar.
      </p>
    );
  if (!tel || !tel.t.length) return null;

  const start = tel.t[0]!;
  const end = tel.t[tel.t.length - 1]!;
  const t0 = zoom === 'all' ? start : Math.max(start, Math.min(t - 30, end - 60));
  const t1 = zoom === 'all' ? end : Math.min(end, t0 + 60);
  const i0 = sampleIndex(tel, t0);
  const i1 = sampleIndex(tel, t1);
  const i = sampleIndex(tel, t);
  const joints = showAll ? tel.joints : tel.joints.slice(0, 4);
  const unit = (k: number) => (tel.joints[k]!.type === 'prismatic' ? 'mm' : '°');
  const events = tel.events.filter((e) => filter === 'all' || e.kind === filter);
  const download = () => {
    const blob = new Blob([telemetryCsv(tel)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `telemetria-${robots.find((r) => r.id === robotId)?.name ?? 'robot'}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select
          className="input w-auto px-2 py-1 text-xs"
          aria-label="Robot"
          value={robotId ?? ''}
          onChange={(e) => setRobotId(e.target.value)}
        >
          {robots.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <div className="flex overflow-hidden rounded-lg border border-slate-200">
          {(['position', 'velocity'] as const).map((m) => (
            <button
              key={m}
              className={`px-2 py-1 ${mode === m ? 'bg-slate-800 text-white' : 'bg-white'}`}
              onClick={() => setMode(m)}
            >
              {m === 'position' ? 'Posición' : 'Velocidad'}
            </button>
          ))}
        </div>
        <div className="flex overflow-hidden rounded-lg border border-slate-200">
          {(['window', 'all'] as const).map((z) => (
            <button
              key={z}
              className={`px-2 py-1 ${zoom === z ? 'bg-slate-800 text-white' : 'bg-white'}`}
              onClick={() => setZoom(z)}
            >
              {z === 'window' ? '60 s alrededor' : 'Toda la ventana'}
            </button>
          ))}
        </div>
        <span className="flex items-center gap-1 text-slate-600">
          <span className="inline-block h-0.5 w-4" style={{ background: EXEC }} /> ejecutado
          <span
            className="ml-2 inline-block h-0 w-4 border-t-2 border-dashed"
            style={{ borderColor: CMD }}
          />{' '}
          comandado
        </span>
        <button className="btn btn-secondary ml-auto px-2.5 py-1 text-xs" onClick={download}>
          Exportar CSV
        </button>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
        {[
          ['Ciclos', String(tel.counters.cycles)],
          ['Tomas / entregas', `${tel.counters.picks} / ${tel.counters.places}`],
          ['Recorrido del TCP', `${fmt(tel.counters.tcp_distance_m)} m`],
          ['Fase actual', tel.phase[i] ?? ''],
          [
            'Garra',
            `${tel.gripper[i] === 'closed' ? 'cerrada' : 'abierta'}${tel.holding[i] ? ' con pieza' : ''}`,
          ],
        ].map(([k, v]) => (
          <div key={k} className="rounded-lg bg-slate-50 px-2 py-1.5">
            <dt className="text-slate-500">{k}</dt>
            <dd className="font-medium text-slate-900">{v}</dd>
          </div>
        ))}
      </dl>

      <div>
        <Track
          label="Fase"
          blocks={runs(
            tel.t,
            tel.phase,
            (p) => PHASE_COLOR[p],
            (p) => p,
          )}
          t0={t0}
          t1={t1}
          now={t}
          onSeek={onSeek}
        />
        <Track
          label="Garra"
          blocks={runs(
            tel.t,
            tel.gripper.map((g, k) =>
              g === 'closed' ? (tel.holding[k] ? 'pieza' : 'cerrada') : 'abierta',
            ),
            (g) => (g === 'abierta' ? '#e2e8f0' : g === 'pieza' ? '#d97706' : '#64748b'),
            (g) => g,
          )}
          t0={t0}
          t1={t1}
          now={t}
          onSeek={onSeek}
        />
        <Track label="Estación" blocks={stationBlocks} t0={t0} t1={t1} now={t} onSeek={onSeek} />
      </div>

      <div>
        <p className="mb-1 text-xs font-semibold text-slate-600">
          Ejes{' '}
          <span className="font-normal text-slate-400">
            {clock(t0)} a {clock(t1)}
          </span>
        </p>
        {joints.map((j, k) => {
          const pos = tel.position[k]!;
          const vel = tel.velocity[k]!;
          const state = axisState(j, pos[i] ?? 0, vel[i] ?? 0);
          const range =
            j.min != null && j.max != null
              ? `${j.min} a ${j.max} ${unit(k)}`
              : 'rango no publicado';
          const speed = j.max_speed != null ? ` · máx ${j.max_speed} ${unit(k)}/s` : '';
          return mode === 'position' ? (
            <SignalRow
              key={j.axis}
              label={`eje${j.axis}_${unit(k) === '°' ? 'deg' : 'mm'}`}
              range={`${range}${state === 'limit' ? ' · en tope' : ''}`}
              t={tel.t}
              series={[
                { values: pos, color: EXEC },
                { values: tel.commanded[k]!, color: CMD, dashed: true },
              ]}
              bounds={j.min != null && j.max != null ? [j.min, j.max] : null}
              i0={i0}
              i1={i1}
              t0={t0}
              t1={t1}
              now={t}
              values={[
                { text: fmt(pos[i] ?? 0), color: EXEC },
                { text: fmt(tel.commanded[k]![i] ?? 0), color: CMD },
              ]}
              onSeek={onSeek}
            />
          ) : (
            <SignalRow
              key={j.axis}
              label={`eje${j.axis}_vel`}
              range={`${unit(k)}/s${speed}${
                tel.peakSpeedPercent[k] != null
                  ? ` · pico ${Math.round(tel.peakSpeedPercent[k]!)} %`
                  : ''
              }`}
              t={tel.t}
              series={[{ values: vel, color: EXEC }]}
              bounds={j.max_speed != null ? [-j.max_speed, j.max_speed] : null}
              i0={i0}
              i1={i1}
              t0={t0}
              t1={t1}
              now={t}
              values={[{ text: fmt(vel[i] ?? 0), color: EXEC }]}
              onSeek={onSeek}
            />
          );
        })}
        <SignalRow
          label="tcp_vel_m_s"
          range="velocidad lineal de la herramienta"
          t={tel.t}
          series={[{ values: tel.tcpSpeed, color: EXEC }]}
          bounds={null}
          i0={i0}
          i1={i1}
          t0={t0}
          t1={t1}
          now={t}
          values={[{ text: fmt(tel.tcpSpeed[i] ?? 0, 2), color: EXEC }]}
          onSeek={onSeek}
        />
        {tel.joints.length > 4 && (
          <button className="link mt-1 text-xs" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Mostrar menos' : `Mostrar los ${tel.joints.length} ejes →`}
          </button>
        )}
      </div>

      {tel.warnings.length > 0 && (
        <ul className="space-y-1 rounded-xl bg-amber-50 p-2 text-xs text-amber-900">
          {tel.warnings.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
        </ul>
      )}

      <div>
        <div className="mb-1 flex flex-wrap items-center gap-1">
          <p className="mr-2 text-xs font-semibold text-slate-600">Eventos</p>
          {EVENT_FILTERS.map((f) => (
            <button
              key={f.key}
              className={`badge cursor-pointer ${filter === f.key ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <ul className="max-h-44 overflow-y-auto rounded-xl border border-slate-200 text-xs">
          {events.length === 0 ? (
            <li className="px-2 py-1.5 text-slate-500">Sin eventos de este tipo.</li>
          ) : (
            events.slice(0, 500).map((e, k) => (
              <li key={k}>
                <button
                  className={`flex w-full gap-3 px-2 py-1 text-left hover:bg-slate-50 ${
                    Math.abs(e.t - t) < 0.05 ? 'bg-brand-50' : ''
                  }`}
                  onClick={() => onSeek(e.t)}
                >
                  <span className="font-mono text-slate-500 tabular-nums">{clock(e.t)}</span>
                  <span className={e.kind === 'overspeed' ? 'text-amber-800' : 'text-slate-800'}>
                    {e.label}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
      <p className="text-[11px] text-slate-500">
        Telemetría de la animación representativa (no del controlador real), muestreada a 20 Hz de
        tiempo de simulación.
      </p>
    </div>
  );
}

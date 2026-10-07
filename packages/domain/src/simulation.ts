import { z } from 'zod';
import {
  validateProcess,
  type Distribution,
  type ProcessIssue,
  type ProcessNode,
} from './process.ts';
import type { Scene } from './scene.ts';

// Contrato de la fase 4 entre web, api y sim-worker. Tiempos en segundos salvo que se indique.

export const RunConfig = z
  .object({
    name: z.string().trim().min(1).max(200),
    horizon_h: z.number().finite().positive().max(10_000),
    warmup_h: z.number().finite().min(0).max(10_000).default(0),
    replications: z.number().int().min(1).max(10_000),
    seed: z.number().int().min(0).max(2_147_483_647),
    /** Demanda del cliente (unidades/h). Sin ella no se calcula el takt time. */
    demand_per_hour: z.number().finite().positive().max(1e7).nullable().default(null),
  })
  .refine((c) => c.warmup_h < c.horizon_h, {
    message: 'El calentamiento debe ser menor que el horizonte',
    path: ['warmup_h'],
  });
export type RunConfig = z.infer<typeof RunConfig>;

/** Nodo listo para simular: el nodo de proceso con nombre y tipo del objeto. */
export type SimNode = ProcessNode & { name: string; kind: string };

export interface SimModel {
  product: { name: string; bom: { item: string; qty: number }[] };
  nodes: SimNode[];
  routes: { from: string; to: string; item: string | null; share: number | null }[];
}

/** Petición de la api al sim-worker. */
export interface SimRequest {
  run_id: string;
  project_id: string;
  model: SimModel;
  config: RunConfig;
  /** Ventana del registro de eventos tras el calentamiento (s). */
  playback_window_s: number;
  max_events: number;
  /** Supuestos del modelo, para guardarlos junto a los resultados. */
  assumptions: string[];
}

/**
 * Compila la escena para el motor. Devuelve los problemas del proceso; si hay errores el
 * modelo es null (no se puede simular).
 */
export function compileProcess(scene: Scene): { model: SimModel | null; issues: ProcessIssue[] } {
  const issues = validateProcess(scene.process, {
    objects: scene.objects.map((o) => ({ id: o.id, kind: o.kind, name: o.name })),
  });
  if (scene.process.nodes.length === 0) {
    issues.push({
      level: 'error',
      code: 'no_source',
      objects: [],
      message: 'El layout no tiene modelo de proceso: asigna roles y rutas en el modo Flujo.',
    });
  }
  if (issues.some((i) => i.level === 'error')) return { model: null, issues };
  const objects = new Map(scene.objects.map((o) => [o.id, o]));
  return {
    issues,
    model: {
      product: scene.process.product,
      nodes: scene.process.nodes.map((n) => ({
        ...n,
        name: objects.get(n.object_id)!.name,
        kind: objects.get(n.object_id)!.kind,
      })),
      routes: scene.process.routes.map(({ from, to, item, share }) => ({ from, to, item, share })),
    },
  };
}

/** Supuestos (parámetros no publicados en una ficha) usados en el modelo, para mostrarlos. */
export function modelAssumptions(model: SimModel): string[] {
  const out: string[] = [];
  const who = (o: string) => (o === 'user' ? 'supuesto del usuario' : 'supuesto del asistente');
  const d = (x: Distribution) => describeDist(x);
  for (const n of model.nodes) {
    if (n.role === 'source' && n.interarrival && n.interarrival.origin !== 'catalog')
      out.push(`${n.name}: llegadas ${d(n.interarrival.dist)} (${who(n.interarrival.origin)})`);
    if (n.role === 'station') {
      if (n.cycle && n.cycle.origin !== 'catalog')
        out.push(`${n.name}: ciclo ${d(n.cycle.dist)} (${who(n.cycle.origin)})`);
      if (n.cycle?.origin === 'catalog')
        out.push(
          `${n.name}: ciclo de la ficha ${d(n.cycle.dist)}, medido en "${n.cycle.note ?? 'condición no indicada'}"`,
        );
      if (n.scrap) out.push(`${n.name}: scrap ${n.scrap.rate} (${who(n.scrap.origin)})`);
      if (n.failures)
        out.push(
          `${n.name}: MTBF ${n.failures.mtbf_s} s, MTTR ${d(n.failures.mttr)} (${who(n.failures.origin)})`,
        );
    }
    if (n.role === 'buffer' && n.transfer)
      out.push(`${n.name}: recorrido ${d(n.transfer.dist)} (${who(n.transfer.origin)})`);
    if (n.role === 'sink' && n.pallet_change)
      out.push(
        `${n.name}: cambio de pallet ${d(n.pallet_change.dist)} (${who(n.pallet_change.origin)})`,
      );
  }
  return out;
}

export function describeDist(x: Distribution): string {
  switch (x.type) {
    case 'fixed':
      return `${x.value} s`;
    case 'exponential':
      return `exponencial, media ${x.mean} s`;
    case 'normal':
      return `normal ${x.mean} ± ${x.sd} s`;
    case 'lognormal':
      return `lognormal ${x.mean} ± ${x.sd} s`;
    case 'uniform':
      return `uniforme ${x.min} a ${x.max} s`;
    case 'triangular':
      return `triangular ${x.min} / ${x.mode} / ${x.max} s`;
  }
}

// ---------------------------------------------------------------------------
// Resultados
// ---------------------------------------------------------------------------

export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface SimMetric {
  metric: string;
  scope: string;
  label: string | null;
  unit: string | null;
  replication: number | null;
  value: number | null;
  min: number | null;
  mean: number | null;
  max: number | null;
  p5: number | null;
  p95: number | null;
  ci_low: number | null;
  ci_high: number | null;
}

export interface RunSummary {
  bottleneck: {
    node: string;
    name: string;
    busy_failed: number;
    second: { node: string; name: string; busy_failed: number } | null;
  } | null;
  assumptions: string[];
  notes: string[];
  representative_replication: number | null;
  takt_time_s: number | null;
}

export interface SimRun {
  id: string;
  project_id: string;
  name: string | null;
  status: RunStatus;
  replications: number;
  seed: number | null;
  progress: number | null;
  error: string | null;
  summary: RunSummary | null;
  input: { config: RunConfig; scene: Scene; model: SimModel } | null;
  layout_version: number | null;
  engine_version: string | null;
  events_path: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/** Nombres y unidades de las métricas que produce el motor. */
export const METRIC_INFO: Record<
  string,
  { label: string; unit: string; better: 'up' | 'down' | null }
> = {
  throughput_per_hour: { label: 'Producción por hora', unit: 'u/h', better: 'up' },
  total_output: { label: 'Total producido (buenas)', unit: 'u', better: 'up' },
  pallets_completed: { label: 'Pallets llenos', unit: 'pallets', better: 'up' },
  line_cycle_time_s: { label: 'Tiempo de ciclo de la línea', unit: 's/u', better: 'down' },
  flow_time_s: { label: 'Tiempo de flujo', unit: 's', better: 'down' },
  wip_avg: { label: 'WIP promedio', unit: 'u', better: 'down' },
  oee: { label: 'OEE', unit: '%', better: 'up' },
  scrap_units: { label: 'Scrap', unit: 'u', better: 'down' },
  busy: { label: 'Ocupada', unit: '%', better: null },
  blocked: { label: 'Bloqueada', unit: '%', better: null },
  starved: { label: 'En espera', unit: '%', better: null },
  failed: { label: 'En falla', unit: '%', better: null },
  availability: { label: 'Disponibilidad', unit: '%', better: 'up' },
  performance: { label: 'Rendimiento', unit: '%', better: 'up' },
  quality: { label: 'Calidad', unit: '%', better: 'up' },
  buffer_avg: { label: 'Ocupación promedio', unit: 'u', better: null },
};

// ---------------------------------------------------------------------------
// Registro de eventos (reproductor)
// ---------------------------------------------------------------------------

export type StationState = 'busy' | 'blocked' | 'idle' | 'failed';

/** [t, 'st', nodo, estado] | [t, 'at', unidad, nodo] | [t, 'gone', unidad] */
export type SimEvent =
  [number, 'st', string, StationState] | [number, 'at', number, string] | [number, 'gone', number];

export interface EventLog {
  start_s: number;
  end_s: number;
  replication: number;
  truncated: boolean;
  events: SimEvent[];
}

export interface PlaybackFrame {
  states: Map<string, StationState>;
  /** Unidad → [nodo anterior, nodo actual, fracción del traslado 0..1] */
  units: Map<number, [string | null, string, number]>;
}

/** Duración visual de un traslado entre nodos (s de simulación). */
export const TRAVEL_S = 2;

/**
 * Estado del reproductor en el instante `t`. Recorre los eventos hasta `t` (ordenados).
 * `events` debe estar ordenado por tiempo.
 */
export function frameAt(log: EventLog, t: number): PlaybackFrame {
  const states = new Map<string, StationState>();
  const last = new Map<number, [string | null, string, number]>(); // unidad → [prev, nodo, t]
  for (const e of log.events) {
    if (e[0] > t) break;
    if (e[1] === 'st') states.set(e[2], e[3]);
    else if (e[1] === 'at') {
      const prev = last.get(e[2]);
      last.set(e[2], [prev ? prev[1] : null, e[3], e[0]]);
    } else last.delete(e[2]);
  }
  const units = new Map<number, [string | null, string, number]>();
  for (const [u, [prev, node, since]] of last) {
    units.set(u, [prev, node, prev ? Math.min(1, (t - since) / TRAVEL_S) : 1]);
  }
  return { states, units };
}

/**
 * Reproductor incremental: avanzar en el tiempo solo aplica los eventos nuevos; retroceder
 * vuelve a empezar. Da el mismo resultado que `frameAt`.
 */
export function createPlayback(log: EventLog) {
  let cursor = 0;
  let lastT = -Infinity;
  let states = new Map<string, StationState>();
  let last = new Map<number, [string | null, string, number]>();
  return {
    seek(t: number): PlaybackFrame {
      if (t < lastT) {
        cursor = 0;
        states = new Map();
        last = new Map();
      }
      lastT = t;
      const ev = log.events;
      while (cursor < ev.length && ev[cursor]![0] <= t) {
        const e = ev[cursor++]!;
        if (e[1] === 'st') states.set(e[2], e[3]);
        else if (e[1] === 'at') {
          const prev = last.get(e[2]);
          last.set(e[2], [prev ? prev[1] : null, e[3], e[0]]);
        } else last.delete(e[2]);
      }
      const units = new Map<number, [string | null, string, number]>();
      for (const [u, [prev, node, since]] of last) {
        units.set(u, [prev, node, prev ? Math.min(1, (t - since) / TRAVEL_S) : 1]);
      }
      return { states: new Map(states), units };
    },
  };
}

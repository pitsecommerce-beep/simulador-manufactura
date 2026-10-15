import { z } from 'zod';

// Modelo de proceso ligado a los objetos del lienzo (fase 4). Tiempos en segundos.
// Cada tiempo o tasa lleva su origen: ficha del catálogo, usuario o asistente de IA.

export const PARAM_ORIGINS = ['catalog', 'user', 'assistant'] as const;
export const ParamOrigin = z.enum(PARAM_ORIGINS);
export type ParamOrigin = z.infer<typeof ParamOrigin>;

export const ORIGIN_LABEL: Record<ParamOrigin, string> = {
  catalog: 'Ficha del catálogo',
  user: 'Supuesto del usuario',
  assistant: 'Supuesto del asistente',
};

const sec = z.number().finite().min(0).max(1e7);
const pos = z.number().finite().positive().max(1e7);

export const Distribution = z.discriminatedUnion('type', [
  z.object({ type: z.literal('fixed'), value: sec }),
  z.object({ type: z.literal('exponential'), mean: pos }),
  z.object({ type: z.literal('normal'), mean: pos, sd: sec }),
  z.object({ type: z.literal('lognormal'), mean: pos, sd: sec }),
  z.object({ type: z.literal('uniform'), min: sec, max: sec }),
  z.object({ type: z.literal('triangular'), min: sec, mode: sec, max: sec }),
]);
export type Distribution = z.infer<typeof Distribution>;
export type DistributionType = Distribution['type'];

export const DIST_LABEL: Record<DistributionType, string> = {
  fixed: 'Fijo',
  exponential: 'Exponencial',
  normal: 'Normal',
  lognormal: 'Lognormal',
  uniform: 'Uniforme',
  triangular: 'Triangular',
};

/** Media de una distribución (s). */
export function distMean(d: Distribution): number {
  switch (d.type) {
    case 'fixed':
      return d.value;
    case 'exponential':
    case 'normal':
    case 'lognormal':
      return d.mean;
    case 'uniform':
      return (d.min + d.max) / 2;
    case 'triangular':
      return (d.min + d.mode + d.max) / 3;
  }
}

/** Tiempo con su distribución, origen y, si viene de la ficha, la condición de medición. */
export const Timed = z.object({
  dist: Distribution,
  origin: ParamOrigin,
  note: z.string().max(500).nullable().default(null),
});
export type Timed = z.infer<typeof Timed>;

const ObjectRef = z.string().min(1).max(64);
const Item = z.string().trim().min(1).max(60);

// Los campos obligatorios aceptan null para guardar borradores: validateProcess los exige.
export const ProcessNode = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('source'),
    object_id: ObjectRef,
    item: Item.nullable().default(null),
    interarrival: Timed.nullable().default(null),
    batch: z.number().int().min(1).max(10_000).default(1),
  }),
  z.object({
    role: z.literal('station'),
    object_id: ObjectRef,
    operation: z.enum(['process', 'assemble']).default('process'),
    cycle: Timed.nullable().default(null),
    capacity: z.number().int().min(1).max(100).default(1),
    scrap: z.object({ rate: z.number().finite(), origin: ParamOrigin }).nullable().default(null),
    failures: z
      .object({ mtbf_s: z.number().finite(), mttr: Distribution, origin: ParamOrigin })
      .nullable()
      .default(null),
  }),
  z.object({
    role: z.literal('buffer'),
    object_id: ObjectRef,
    capacity: z.number().finite().nullable().default(null),
    transfer: Timed.nullable().default(null),
  }),
  z.object({
    role: z.literal('sink'),
    object_id: ObjectRef,
    units_per_pallet: z.number().int().min(1).max(100_000).nullable().default(null),
    pallet_change: Timed.nullable().default(null),
  }),
]);
export type ProcessNode = z.infer<typeof ProcessNode>;
export type ProcessRole = ProcessNode['role'];

export const ROLE_LABEL: Record<ProcessRole, string> = {
  source: 'Fuente',
  station: 'Estación',
  buffer: 'Buffer',
  sink: 'Salida',
};

export const Route = z.object({
  id: z.string().min(1).max(64),
  from: ObjectRef,
  to: ObjectRef,
  /** Solo pasa este artículo (para llevar cada componente a su estación). */
  item: Item.nullable().default(null),
  /** Fracción del flujo cuando un nodo tiene varias salidas. */
  share: z.number().finite().nullable().default(null),
});
export type Route = z.infer<typeof Route>;

export const Product = z.object({
  name: Item.default('Producto'),
  bom: z
    .array(z.object({ item: Item, qty: z.number().int().min(1).max(10_000) }))
    .max(50)
    .default([]),
});
export type Product = z.infer<typeof Product>;

export const ProcessModel = z.object({
  product: Product.default({ name: 'Producto', bom: [] }),
  nodes: z.array(ProcessNode).max(500).default([]),
  routes: z.array(Route).max(2000).default([]),
});
export type ProcessModel = z.infer<typeof ProcessModel>;

export const emptyProcess = (): ProcessModel => ({
  product: { name: 'Producto', bom: [] },
  nodes: [],
  routes: [],
});

/** Qué roles admite cada tipo de objeto. */
export const ROLES_BY_KIND: Record<string, ProcessRole[]> = {
  robot: ['station'],
  conveyor: ['source', 'station', 'buffer', 'sink'],
  table: ['source', 'station', 'buffer', 'sink'],
  pallet: ['source', 'sink'],
  box: ['source'],
};

// ---------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------

export interface ProcessIssue {
  level: 'error' | 'warning' | 'info';
  code:
    | 'no_source'
    | 'no_sink'
    | 'missing_object'
    | 'duplicate_node'
    | 'role_incompatible'
    | 'route_missing_node'
    | 'route_from_sink'
    | 'route_to_source'
    | 'route_self'
    | 'route_duplicate'
    | 'no_exit'
    | 'unreachable'
    | 'cycle'
    | 'buffer_capacity'
    | 'missing_cycle'
    | 'missing_interarrival'
    | 'missing_item'
    | 'missing_units'
    | 'share_sum'
    | 'share_missing'
    | 'assemble_without_bom'
    | 'bom_uncovered'
    | 'param_range'
    | 'assumption'
    | 'catalog_cycle_available';
  objects: string[];
  message: string;
}

export interface ProcessContext {
  /** Tipo y nombre de cada objeto del lienzo. */
  objects: { id: string; kind: string; name: string }[];
  /** Tiempos de ciclo publicados (s) para el objeto robot, si la ficha los publica. */
  publishedCycles?: (objectId: string) => number[] | undefined;
}

function distProblems(d: Distribution): string | null {
  switch (d.type) {
    case 'uniform':
      return d.min <= d.max ? null : 'mínimo mayor que máximo';
    case 'triangular':
      return d.min <= d.mode && d.mode <= d.max ? null : 'debe cumplir mín ≤ moda ≤ máx';
    default:
      return null;
  }
}

/** Valida el modelo de proceso. Los errores impiden simular; avisos e info no. */
export function validateProcess(p: ProcessModel, ctx: ProcessContext): ProcessIssue[] {
  const issues: ProcessIssue[] = [];
  const objects = new Map(ctx.objects.map((o) => [o.id, o]));
  const name = (id: string) => objects.get(id)?.name ?? id;
  const add = (
    level: ProcessIssue['level'],
    code: ProcessIssue['code'],
    ids: string[],
    message: string,
  ) => issues.push({ level, code, objects: ids, message });

  if (p.nodes.length === 0 && p.routes.length === 0) return issues;

  // Nodos
  const nodes = new Map<string, ProcessNode>();
  for (const n of p.nodes) {
    const obj = objects.get(n.object_id);
    if (!obj) {
      add(
        'error',
        'missing_object',
        [n.object_id],
        `Un nodo del proceso apunta a un objeto que ya no existe.`,
      );
      continue;
    }
    if (nodes.has(n.object_id)) {
      add(
        'error',
        'duplicate_node',
        [n.object_id],
        `${obj.name} tiene más de un rol en el proceso.`,
      );
      continue;
    }
    if (!(ROLES_BY_KIND[obj.kind] ?? []).includes(n.role)) {
      add(
        'error',
        'role_incompatible',
        [n.object_id],
        `${obj.name} no puede ser ${ROLE_LABEL[n.role].toLowerCase()}.`,
      );
    }
    nodes.set(n.object_id, n);
  }
  const all = [...nodes.values()];
  if (!all.some((n) => n.role === 'source'))
    add('error', 'no_source', [], 'El proceso no tiene ninguna fuente de producto.');
  if (!all.some((n) => n.role === 'sink'))
    add('error', 'no_sink', [], 'El proceso no tiene ninguna salida.');

  // Rutas
  const out = new Map<string, Route[]>();
  const inc = new Map<string, Route[]>();
  const seen = new Set<string>();
  for (const r of p.routes) {
    const from = nodes.get(r.from);
    const to = nodes.get(r.to);
    if (!from || !to) {
      add(
        'error',
        'route_missing_node',
        [r.from, r.to].filter((x) => objects.has(x)),
        `Una ruta conecta un objeto sin rol en el proceso (${name(r.from)} → ${name(r.to)}).`,
      );
      continue;
    }
    if (r.from === r.to) {
      add('error', 'route_self', [r.from], `${name(r.from)} tiene una ruta hacia sí mismo.`);
      continue;
    }
    if (from.role === 'sink')
      add(
        'error',
        'route_from_sink',
        [r.from],
        `Una salida no puede enviar producto (${name(r.from)} → ${name(r.to)}).`,
      );
    if (to.role === 'source')
      add(
        'error',
        'route_to_source',
        [r.to],
        `Una fuente no puede recibir producto (${name(r.from)} → ${name(r.to)}).`,
      );
    const key = `${r.from}>${r.to}>${r.item ?? ''}`;
    if (seen.has(key))
      add(
        'error',
        'route_duplicate',
        [r.from, r.to],
        `Ruta repetida ${name(r.from)} → ${name(r.to)}.`,
      );
    seen.add(key);
    out.set(r.from, [...(out.get(r.from) ?? []), r]);
    inc.set(r.to, [...(inc.get(r.to) ?? []), r]);
  }

  // Parámetros por nodo
  for (const n of all) {
    const id = [n.object_id];
    const nm = name(n.object_id);
    const timed = (t: Timed | null, what: string) => {
      if (!t) return;
      const prob = distProblems(t.dist);
      if (prob) add('error', 'param_range', id, `${what} de ${nm}: ${prob}.`);
      if (t.origin !== 'catalog')
        add(
          'info',
          'assumption',
          id,
          `${what} de ${nm}: ${t.origin === 'user' ? 'supuesto del usuario' : 'supuesto del asistente'}.`,
        );
    };
    if (n.role === 'source') {
      if (!n.interarrival)
        add('error', 'missing_interarrival', id, `Falta la tasa de llegada de ${nm}.`);
      if (!n.item) add('error', 'missing_item', id, `Falta el artículo que entra por ${nm}.`);
      timed(n.interarrival, 'Tiempo entre llegadas');
    } else if (n.role === 'station') {
      if (!n.cycle) add('error', 'missing_cycle', id, `Falta el tiempo de ciclo de ${nm}.`);
      timed(n.cycle, 'Tiempo de ciclo');
      const published = ctx.publishedCycles?.(n.object_id);
      if (published?.length && n.cycle && n.cycle.origin !== 'catalog') {
        add(
          'info',
          'catalog_cycle_available',
          id,
          `La ficha de ${nm} publica tiempos de ciclo (${published.join(', ')} s) bajo condiciones de medición específicas; se usa otro valor.`,
        );
      }
      if (n.scrap) {
        if (!(n.scrap.rate >= 0 && n.scrap.rate < 1))
          add(
            'error',
            'param_range',
            id,
            `El scrap de ${nm} debe estar entre 0 y 1 (sin incluir 1).`,
          );
        else if (n.scrap.origin !== 'catalog')
          add(
            'info',
            'assumption',
            id,
            `Scrap de ${nm}: supuesto del ${n.scrap.origin === 'user' ? 'usuario' : 'asistente'}.`,
          );
      }
      if (n.failures) {
        if (!(n.failures.mtbf_s > 0))
          add('error', 'param_range', id, `El MTBF de ${nm} debe ser mayor que 0.`);
        const prob = distProblems(n.failures.mttr);
        if (prob) add('error', 'param_range', id, `MTTR de ${nm}: ${prob}.`);
        if (n.failures.origin !== 'catalog')
          add(
            'info',
            'assumption',
            id,
            `Fallas de ${nm}: supuesto del ${n.failures.origin === 'user' ? 'usuario' : 'asistente'}.`,
          );
      }
      if (n.operation === 'assemble' && p.product.bom.length === 0) {
        add(
          'error',
          'assemble_without_bom',
          id,
          `${nm} ensambla, pero el producto no tiene lista de materiales.`,
        );
      }
    } else if (n.role === 'buffer') {
      if (n.capacity == null || !Number.isInteger(n.capacity) || n.capacity < 1) {
        add(
          'error',
          'buffer_capacity',
          id,
          `El buffer ${nm} necesita una capacidad entera de al menos 1.`,
        );
      }
      timed(n.transfer, 'Tiempo de recorrido');
    } else {
      if (n.units_per_pallet == null)
        add('error', 'missing_units', id, `Falta cuántas unidades llenan la salida ${nm}.`);
      timed(n.pallet_change, 'Cambio de pallet');
    }
  }

  // Repartos
  for (const [from, routes] of out) {
    if (routes.length < 2) continue;
    const byItem =
      routes.every((r) => r.item) && new Set(routes.map((r) => r.item)).size === routes.length;
    if (byItem) continue;
    if (routes.some((r) => r.share == null)) {
      add(
        'error',
        'share_missing',
        [from],
        `${name(from)} tiene varias salidas: indica qué fracción va por cada ruta.`,
      );
    } else {
      const sum = routes.reduce((a, r) => a + (r.share ?? 0), 0);
      if (Math.abs(sum - 1) > 1e-6 || routes.some((r) => (r.share ?? 0) < 0)) {
        add(
          'error',
          'share_sum',
          [from],
          `Las fracciones de salida de ${name(from)} suman ${Math.round(sum * 1000) / 1000}; deben sumar 1.`,
        );
      }
    }
  }

  // Grafo: ciclos, alcanzabilidad desde fuentes y llegada a una salida.
  const color = new Map<string, 0 | 1 | 2>();
  const inCycle = new Set<string>();
  const dfs = (u: string, stack: string[]) => {
    color.set(u, 1);
    for (const r of out.get(u) ?? []) {
      const c = color.get(r.to) ?? 0;
      if (c === 1) stack.slice(stack.indexOf(r.to)).forEach((x) => inCycle.add(x));
      else if (c === 0) dfs(r.to, [...stack, r.to]);
    }
    color.set(u, 2);
  };
  for (const n of all) if (!color.get(n.object_id)) dfs(n.object_id, [n.object_id]);
  if (inCycle.size) {
    add(
      'error',
      'cycle',
      [...inCycle],
      `Las rutas forman un ciclo (${[...inCycle].map(name).join(' → ')}). El retrabajo aún no está soportado.`,
    );
  }

  const reach = (starts: string[], next: (id: string) => string[]) => {
    const seenIds = new Set(starts);
    const queue = [...starts];
    while (queue.length) {
      for (const v of next(queue.shift()!)) {
        if (seenIds.has(v)) continue;
        seenIds.add(v);
        queue.push(v);
      }
    }
    return seenIds;
  };
  const fromSources = reach(
    all.filter((n) => n.role === 'source').map((n) => n.object_id),
    (id) => (out.get(id) ?? []).map((r) => r.to),
  );
  const toSinks = reach(
    all.filter((n) => n.role === 'sink').map((n) => n.object_id),
    (id) => (inc.get(id) ?? []).map((r) => r.from),
  );
  for (const n of all) {
    if (n.role !== 'sink' && !out.get(n.object_id)?.length) {
      add(
        'error',
        'no_exit',
        [n.object_id],
        `${name(n.object_id)} no tiene ruta de salida: el producto se quedaría ahí.`,
      );
    } else if (n.role !== 'sink' && !toSinks.has(n.object_id)) {
      add(
        'error',
        'no_exit',
        [n.object_id],
        `Desde ${name(n.object_id)} el producto no llega a ninguna salida.`,
      );
    }
    if (n.role !== 'source' && !fromSources.has(n.object_id)) {
      add(
        'error',
        'unreachable',
        [n.object_id],
        `A ${name(n.object_id)} no llega producto desde ninguna fuente.`,
      );
    }
  }

  // Ensamblaje: las entradas deben aportar todos los componentes de la BOM.
  if (!inCycle.size) {
    const items = new Map<string, Set<string>>();
    const itemsAt = (id: string): Set<string> => {
      const cached = items.get(id);
      if (cached) return cached;
      const n = nodes.get(id);
      let set: Set<string>;
      if (n?.role === 'source') set = new Set(n.item ? [n.item] : []);
      else {
        set = new Set();
        for (const r of inc.get(id) ?? []) {
          const upstream = itemsAt(r.from);
          for (const it of upstream) if (!r.item || r.item === it) set.add(it);
        }
        if (n?.role === 'station' && n.operation === 'assemble') {
          const missing = p.product.bom.filter((b) => !set.has(b.item)).map((b) => b.item);
          if (p.product.bom.length && missing.length) {
            add(
              'error',
              'bom_uncovered',
              [id],
              `${name(id)} ensambla ${p.product.name}, pero no le llega: ${missing.join(', ')}.`,
            );
          }
          set = new Set([p.product.name]);
        }
      }
      items.set(id, set);
      return set;
    };
    for (const n of all) itemsAt(n.object_id);
  }

  return issues;
}

/** Quita del proceso el nodo de un objeto y sus rutas. */
export function removeObjectFromProcess(p: ProcessModel, objectId: string): ProcessModel {
  return {
    ...p,
    nodes: p.nodes.filter((n) => n.object_id !== objectId),
    routes: p.routes.filter((r) => r.from !== objectId && r.to !== objectId),
  };
}
